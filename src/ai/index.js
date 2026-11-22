// One way to ask a model for JSON, whatever the provider: checks the answer against its
// schema, asks once more if it does not fit, and keeps every good answer on disk.
const { app } = require("electron");
const files = require("../files");
const secrets = require("../secrets");
const { parse, validate } = require("../schema");
const { PROVIDERS, price } = require("./models");
const anthropic = require("./anthropic");
const openai = require("./openai");
const claudeCode = require("./claude-code");
const { allowedAddress } = require("../address");

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

let settings = () => ({});
function init(readSettings) {
  settings = readSettings;
  claudeCode.warm();
}

// Test servers on this machine stand in for the real ones. Never in the app people install.
const override = (name) => (app.isPackaged ? undefined : process.env[name]);

function config() {
  const ai = settings().ai || {};
  const provider = PROVIDERS[ai.provider] ? ai.provider : null;
  if (!provider) return { provider: null };
  return {
    provider,
    model: (ai.models && ai.models[provider]) || PROVIDERS[provider].model,
    baseURL: provider === "openai" ? ai.baseURL || "" : undefined,
  };
}

async function status() {
  await secrets.ready();
  const c = config();
  const ready =
    c.provider === "claudeCode"
      ? Boolean(await claudeCode.locate())
      : c.provider === "openai"
        ? Boolean(c.baseURL && c.model)
        : c.provider
          ? secrets.has(c.provider)
          : false;
  return {
    ...c,
    ready,
    keys: { anthropic: secrets.has("anthropic"), openrouter: secrets.has("openrouter"), openai: secrets.has("openai") },
    claudeCode: Boolean(await claudeCode.locate()),
    price: c.provider ? price(c.provider, c.model) : null,
  };
}

function call(c, request) {
  if (c.provider === "claudeCode") return claudeCode.complete(request);
  if (c.provider === "anthropic") {
    return anthropic.complete({ ...request, key: secrets.get("anthropic"), baseURL: override("ACED_ANTHROPIC_BASE_URL") });
  }
  if (c.provider === "openrouter") {
    return openai.complete({
      ...request,
      flavour: "openrouter",
      key: secrets.get("openrouter"),
      baseURL: override("ACED_OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1",
    });
  }
  if (!allowedAddress(c.baseURL)) throw coded(c.baseURL ? "insecureAddress" : "noServer");
  return openai.complete({ ...request, flavour: "plain", key: secrets.get("openai"), baseURL: c.baseURL });
}

/**
 * Asks the model. `material` is the long text from the person's files (data, never
 * instructions); `prompt` is the task. Resolves to the checked JSON.
 * `cache: true` marks the material for the provider's own cache, where it has one.
 * `onUsage({input, cached, output, cost?})` is called for every request that was really sent.
 */
async function ask({ name, system, material = "", prompt, schema, maxTokens = 32000, effort = "medium", cache = false, usable, images }, { signal, onUsage, onKey, fresh } = {}) {
  await secrets.ready();
  const c = config();
  if (!c.provider) throw coded("noProvider");
  // Pictures count by what they show: their bytes are part of the question.
  const seen = images && images.length ? images.map((i) => files.sha(i.data)) : undefined;
  const key = files.sha(JSON.stringify([c.provider, c.model, system, material, prompt, schema, ...(seen ? [seen] : [])]));
  onKey?.(key); // lets the caller note which kept answers belong to which exam
  // An answer is kept only when it could be used (`usable` returns what is wrong with it, or
  // ""): an empty one must not come back from the disk for ever. `fresh` asks again regardless.
  const hit = fresh ? null : files.cached(key);
  if (hit && !(usable && usable(hit))) return hit;

  let problem = "";
  for (let round = 0; round < 2; round++) {
    const again = problem ? `\n\nYour previous answer could not be used (${problem}). Answer again and follow the schema exactly.` : "";
    const { text, usage } = await call(c, {
      model: c.model,
      system,
      material,
      prompt: prompt + again,
      schema,
      schemaName: name,
      maxTokens,
      effort,
      cache,
      signal,
      ...(images && images.length ? { images } : {}),
    });
    onUsage?.(usage);
    try {
      const value = validate(schema, parse(text));
      const wrong = usable ? usable(value) : "";
      if (wrong) throw new Error(wrong);
      files.remember(key, value);
      return value;
    } catch (err) {
      problem = err.message;
    }
  }
  throw coded("badOutput", problem);
}

/** A tiny real request, for the "Test" button in Settings. */
async function test() {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  await secrets.ready();
  const c = config();
  if (!c.provider) throw coded("noProvider");
  const { text } = await call(c, {
    model: c.model,
    system: "You answer with JSON only.",
    material: "",
    prompt: 'Answer with {"ok": true}.',
    schema,
    schemaName: "ping",
    maxTokens: 8000,
    effort: "low",
  });
  return validate(schema, parse(text)).ok === true;
}

// ------------------------------------------------------------ can the chosen model see?

const sight = new Map(); // "provider|model|address" -> true | false: only answers that are certain, for as long as the app runs
let modelList = null; // OpenRouter's public list of models, fetched once

/** Whether a model can see is asked again: after the AI, its model, its address or its key changed. */
const forgetSight = () => sight.clear();

/** OpenRouter's public list of models (prices, and what each one takes as input), or [] when it cannot be had now. */
async function openRouterModels() {
  if (modelList) return modelList;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(6000) });
    modelList = (await res.json()).data || [];
  } catch {
    return [];
  }
  return modelList;
}

/**
 * Whether the chosen model can read pictures: true, false, or null when no AI is chosen.
 * Claude can (through Claude Code or a key). For OpenRouter its own list says so. Any other
 * server, or an OpenRouter model the list does not name, is shown a small picture with two
 * numbers on it and has to name them.
 *
 * Only a certain answer is kept: the list said so, or the server answered the picture (named
 * the numbers, or refused pictures). When the server cannot be reached, is busy or refuses the
 * key, that is thrown as what it is ("offline", "badKey" …): it says nothing about seeing, and
 * the next try asks again.
 */
async function canSee({ signal, samplePicture } = {}) {
  await secrets.ready();
  const c = config();
  if (!c.provider) return null;
  const id = `${c.provider}|${c.model}|${c.baseURL || ""}`;
  if (sight.has(id)) return sight.get(id);
  if (c.provider === "claudeCode" || c.provider === "anthropic") {
    sight.set(id, true);
    return true;
  }
  if (c.provider === "openrouter") {
    const found = (await openRouterModels()).find((m) => m.id === c.model);
    if (found && found.architecture && Array.isArray(found.architecture.input_modalities)) {
      const sees = found.architecture.input_modalities.includes("image");
      sight.set(id, sees);
      return sees;
    }
  }
  if (!samplePicture) return false;
  const picture = await samplePicture();
  let sees;
  try {
    const { text } = await call(c, {
      model: c.model,
      system: "You read pictures and answer with JSON only.",
      material: "",
      prompt: 'Which two numbers are written on this picture? Answer with JSON: {"text": "<the two numbers>"}.',
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      schemaName: "sight",
      maxTokens: 2000,
      effort: "low",
      signal,
      images: [{ mediaType: "image/png", data: picture.toString("base64") }],
    });
    sees = /12/.test(text) && /34/.test(text);
  } catch (err) {
    // The server answered, and refused the request with the picture (400, 404, 413, 415, 422): it does not take pictures.
    if (["provider", "noModel", "badAddress", "tooBig"].includes(err.code) && (!err.status || [400, 404, 413, 415, 422].includes(err.status))) sees = false;
    else throw err;
  }
  sight.set(id, sees);
  return sees;
}

module.exports = { init, config, status, ask, test, canSee, forgetSight, openRouterModels, PROVIDERS };

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
    return anthropic.complete({ ...request, key: secrets.get("anthropic"), baseURL: override("SPURT_ANTHROPIC_BASE_URL") });
  }
  if (c.provider === "openrouter") {
    return openai.complete({
      ...request,
      flavour: "openrouter",
      key: secrets.get("openrouter"),
      baseURL: override("SPURT_OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1",
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
async function ask({ name, system, material = "", prompt, schema, maxTokens = 32000, effort = "medium", cache = false, usable }, { signal, onUsage, onKey, fresh } = {}) {
  await secrets.ready();
  const c = config();
  if (!c.provider) throw coded("noProvider");
  const key = files.sha(JSON.stringify([c.provider, c.model, system, material, prompt, schema]));
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

module.exports = { init, config, status, ask, test, PROVIDERS };

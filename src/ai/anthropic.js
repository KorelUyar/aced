// The Anthropic API with the person's own key, through the official SDK.
const AnthropicSdk = require("@anthropic-ai/sdk");
const { REFUSAL_FALLBACK } = require("./models");

const Anthropic = AnthropicSdk.default || AnthropicSdk;

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

/**
 * The SDK takes settings from the environment: another server, extra headers, a log level, a
 * profile. This app sends the person's key to api.anthropic.com and nowhere else, so those are
 * removed from this process before a client is made. (Claude Code runs as its own process with
 * the person's shell environment and is not affected.)
 */
function ignoreEnvironment() {
  for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_")) delete process.env[name];
}

/** An error from the API as a code the interface has a sentence for; what the API itself says only as a last resort, in words, never as JSON. */
function apiProblem(err) {
  const status = err.status || 0;
  const body = err.error && err.error.error ? err.error.error : {};
  const said = String(body.message || "").replace(/\s+/g, " ").trim();
  if (status === 402 || /credit balance|billing/i.test(said)) return coded("noCredit");
  if (status === 529 || body.type === "overloaded_error") return coded("overloaded");
  if (status === 413 || /prompt is too long|too many tokens/i.test(said)) return coded("tooBig");
  if (status >= 500) return coded("serverError");
  return coded("provider", said ? said.slice(0, 200) : `HTTP ${status}`);
}

async function complete({ key, baseURL, model, system, material, prompt, schema, maxTokens, effort, cache, signal, images }) {
  if (!key) throw coded("noKey");
  ignoreEnvironment();
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: baseURL || "https://api.anthropic.com", maxRetries: 2 });
  const fallback = REFUSAL_FALLBACK.has(model);
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system }],
    messages: [
      {
        role: "user",
        content: [
          // Pictures of pages first, then what is asked about them.
          ...(images || []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
          // Where the same pages will be asked about again soon (quizzes on a topic), the material
          // is marked for caching: writing it costs a quarter more once, reading it a fraction.
          ...(material ? [{ type: "text", text: material, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }] : []),
          { type: "text", text: prompt },
        ],
      },
    ],
    output_config: { effort, format: { type: "json_schema", schema } },
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
  let message;
  try {
    // Streaming, so a long answer does not run into an HTTP timeout.
    message = await (fallback ? client.beta.messages : client.messages).stream(body, { signal }).finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) throw coded("cancelled");
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw coded("badKey");
    if (err instanceof Anthropic.RateLimitError) throw coded("rateLimit");
    if (err instanceof Anthropic.NotFoundError) throw coded("noModel", model);
    if (err instanceof Anthropic.APIConnectionError) throw coded("offline");
    if (err instanceof Anthropic.APIError) throw apiProblem(err);
    throw err;
  }
  if (message.stop_reason === "refusal") throw coded("refusal");
  if (message.stop_reason === "max_tokens") throw coded("tooLong");
  const u = message.usage || {};
  return {
    text: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    usage: {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      written: u.cache_creation_input_tokens || 0,
      output: u.output_tokens || 0,
    },
  };
}

module.exports = { complete, ignoreEnvironment };

// The Anthropic API with the person's own key, through the official SDK.
const AnthropicSdk = require("@anthropic-ai/sdk");
const { REFUSAL_FALLBACK } = require("./models");

const Anthropic = AnthropicSdk.default || AnthropicSdk;

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

async function complete({ key, baseURL, model, system, material, prompt, schema, maxTokens, effort, signal }) {
  if (!key) throw coded("noKey");
  const client = new Anthropic({ apiKey: key, ...(baseURL ? { baseURL } : {}), maxRetries: 2 });
  const fallback = REFUSAL_FALLBACK.has(model);
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system }],
    messages: [
      {
        role: "user",
        content: [
          // The material is the long, stable part: cached, so a second question about the
          // same pages (another quiz, a retry) is billed at a fraction.
          ...(material ? [{ type: "text", text: material, cache_control: { type: "ephemeral" } }] : []),
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
    if (err instanceof Anthropic.APIError) throw coded("provider", `${err.status || ""} ${err.message}`.trim().slice(0, 300));
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
      output: u.output_tokens || 0,
    },
  };
}

module.exports = { complete };

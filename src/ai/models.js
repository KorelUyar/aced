// Where the AI can come from, the models offered for each, and what they cost.
// Prices are US dollars per million tokens: [input, output, input read from the cache], from
// Anthropic's price list (checked 2026-11). Input written to the cache costs 1.25 times the
// input price. They feed the estimate before a large run and the "used so far" line.

const CLAUDE = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", price: [4, 20, 0.2] },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", price: [2, 10, 0.1] },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", price: [0.1, 0.5, 0.01] },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", price: [8, 40, 0.2] },
];
const CACHE_WRITE = 1.25;

const PROVIDERS = {
  // The person's own Claude Code login on this Mac. No key, no price per token.
  claudeCode: { key: false, models: CLAUDE, model: "claude-opus-5-5" },
  anthropic: { key: true, models: CLAUDE, model: "claude-opus-5-5" },
  // Any model id OpenRouter knows; its price is looked up from OpenRouter's public list.
  openrouter: { key: true, models: null, model: "anthropic/claude-opus-5.5" },
  // Any server that speaks the OpenAI chat format (base URL + optional key), e.g. a local one.
  openai: { key: "optional", models: null, model: "" },
};

// These decline some requests through a safety check; the API can re-run those on another model.
const REFUSAL_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);

function price(provider, model) {
  if (provider !== "anthropic") return null;
  return CLAUDE.find((m) => m.id === model)?.price || null;
}

/** What one request cost, from the token counts the provider reported. */
function cost(prices, u) {
  const read = u.cached || 0;
  const written = u.written || 0;
  const plain = Math.max(0, (u.input || 0) - read - written);
  return (plain * prices[0] + written * prices[0] * CACHE_WRITE + read * (prices[2] ?? prices[0] * 0.1) + (u.output || 0) * prices[1]) / 1e6;
}

module.exports = { PROVIDERS, CLAUDE, REFUSAL_FALLBACK, price, cost };

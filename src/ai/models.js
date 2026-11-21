// Where the AI can come from, the models offered for each, and what they cost.
// Prices are US dollars per million tokens [input, output], from Anthropic's price list
// (checked 2026-11). They only feed the rough estimate shown before a large run.

const CLAUDE = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", price: [4, 20] },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", price: [2, 10] },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", price: [0.1, 0.5] },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", price: [8, 40] },
];

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

module.exports = { PROVIDERS, CLAUDE, REFUSAL_FALLBACK, price };

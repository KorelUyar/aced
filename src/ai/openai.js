// OpenRouter, and any other server that speaks the OpenAI chat format. Plain fetch.
const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

async function post(url, key, body, signal, extraHeaders) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extraHeaders },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw coded("cancelled");
    throw coded("offline");
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: handled below
  }
  if (!res.ok || json?.error) {
    const message = String(json?.error?.message || text || res.statusText).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw coded("badKey");
    if (res.status === 402) throw coded("noCredit");
    if (res.status === 429) throw coded("rateLimit");
    if (res.status === 404) throw coded("noModel", body.model);
    throw Object.assign(coded("provider", `${res.status} ${message}`), { status: res.status });
  }
  if (!json) throw coded("provider", "The server did not answer with JSON.");
  return json;
}

/**
 * `flavour` is "openrouter" (prompt caching markers, usage with cost, only providers that can
 * do structured output) or "plain" (nothing beyond the common format).
 */
async function complete({ key, baseURL, flavour, model, system, material, prompt, schema, schemaName, maxTokens, signal }) {
  if (!baseURL) throw coded("noServer");
  if (!model) throw coded("noModel", "");
  const openrouter = flavour === "openrouter";
  if (openrouter && !key) throw coded("noKey");
  const url = baseURL.replace(/\/+$/, "") + "/chat/completions";
  const user =
    openrouter && material
      ? [
          { type: "text", text: material, cache_control: { type: "ephemeral" } },
          { type: "text", text: prompt },
        ]
      : (material ? material + "\n\n" : "") + prompt;
  const base = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(openrouter ? { provider: { require_parameters: true }, usage: { include: true } } : {}),
  };
  const headers = openrouter ? { "X-Title": "Spurt" } : {};
  // Structured output where the server has it; servers that do not know it get the schema in words.
  const inWords = (b) => ({
    ...b,
    messages: [
      b.messages[0],
      { role: "user", content: (material ? material + "\n\n" : "") + prompt + "\n\nAnswer with one JSON object that follows this JSON Schema, and nothing else:\n" + JSON.stringify(schema) },
    ],
  });
  const tries = [
    { ...base, response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } } },
    { ...inWords(base), response_format: { type: "json_object" } },
    inWords(base),
  ];
  let json;
  for (let i = 0; i < tries.length; i++) {
    try {
      json = await post(url, key, tries[i], signal, headers);
      break;
    } catch (err) {
      // 400/422: this server does not take that response_format. Try the next, simpler way.
      if (err.code === "provider" && (err.status === 400 || err.status === 422) && i < tries.length - 1) continue;
      throw err;
    }
  }
  const choice = json.choices?.[0];
  if (!choice) throw coded("provider", "The answer was empty.");
  if (choice.message?.refusal) throw coded("refusal");
  if (choice.finish_reason === "length") throw coded("tooLong");
  if (choice.finish_reason === "content_filter") throw coded("refusal");
  const content = choice.message?.content;
  const u = json.usage || {};
  return {
    text: Array.isArray(content) ? content.map((c) => c.text || "").join("") : content || "",
    usage: {
      input: u.prompt_tokens || 0,
      cached: u.prompt_tokens_details?.cached_tokens || 0,
      output: u.completion_tokens || 0,
      ...(typeof u.cost === "number" ? { cost: u.cost } : {}),
    },
  };
}

module.exports = { complete };

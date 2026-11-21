// OpenRouter, and any other server that speaks the OpenAI chat format. Plain fetch.
const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

/** Reads an answer that arrives as a stream of events, and returns it in the shape of a plain one. */
async function readStream(res) {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let refusal = "";
  let finish = null;
  let usage = null;
  let error = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue; // comments and keep-alives
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) error = event.error;
      if (event.usage) usage = event.usage;
      const choice = event.choices && event.choices[0];
      if (!choice) continue;
      if (choice.delta && typeof choice.delta.content === "string") content += choice.delta.content;
      if (choice.delta && typeof choice.delta.refusal === "string") refusal += choice.delta.refusal;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return { error, usage, choices: [{ finish_reason: finish, message: { content, refusal: refusal || null } }] };
}

async function post(url, key, body, signal, extraHeaders) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extraHeaders },
      // Streamed, so a slow model (one on the person's own computer, say) does not run into a timeout.
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw coded("cancelled");
    throw coded("offline");
  }
  let json = null;
  let text = "";
  try {
    if (res.ok && (res.headers.get("content-type") || "").includes("text/event-stream")) json = await readStream(res);
    else {
      text = await res.text();
      json = JSON.parse(text);
    }
  } catch (err) {
    if (err.name === "AbortError") throw coded("cancelled");
    // not JSON, or the connection broke: handled below
  }
  if (!res.ok || json?.error) {
    const message = String(json?.error?.message || text || res.statusText).slice(0, 300);
    const status = res.ok ? Number(json?.error?.code) || 0 : res.status;
    if (status === 401 || status === 403) throw coded("badKey");
    if (status === 402) throw coded("noCredit");
    if (status === 429) throw coded("rateLimit");
    // 404 is either a model the server does not have or an address that leads nowhere.
    if (status === 404) throw /model/i.test(message) ? coded("noModel", body.model) : coded("badAddress");
    throw Object.assign(coded("provider", `${status || ""} ${message}`.trim()), { status });
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
  // Other servers are asked to report token counts at the end of the stream, where they know how.
  const counted = openrouter ? {} : { stream_options: { include_usage: true } };
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
    { ...base, ...counted, response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } } },
    { ...inWords(base), ...counted, response_format: { type: "json_object" } },
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

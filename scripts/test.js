// Checks of the parts that need no window:
//
//   node_modules/.bin/electron scripts/test.js
//
// - the planner (grades, what fits, what is left out, repetition)
// - the check of exercise numbers against page text
// - every key-based provider against a small server on this machine that speaks its format:
//   what is sent (key, schema, caching marks), what comes back, and what happens on errors
// No real provider is contacted and no key is needed.
const { app } = require("electron");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

app.dock?.hide();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "spurt-test-")));
// A helper window is opened and closed along the way (to make a PDF); that must not end the run.
app.on("window-all-closed", () => {});

let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const same = (a, b, message) => {
  assert.deepStrictEqual(a, b, message);
  checks++;
};

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, body ? JSON.parse(body) : null, res));
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

/** An Anthropic Messages answer as a stream of events, the way the API sends it. */
function anthropicStream(res, text, stopReason = "end_turn") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 40, cache_read_input_tokens: 0 } },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } });
  send("message_stop", {});
  res.end();
}

const SCHEMA = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
const request = (prompt, extra = {}) => ({ name: "sum", system: "You add numbers.", material: "<material>two and three</material>", prompt, schema: SCHEMA, ...extra });
const failsWith = async (promise, code) => {
  try {
    await promise;
  } catch (err) {
    return same(err.code, code, `expected ${code}, got ${err.code}: ${err.detail || err.message}`);
  }
  assert.fail(`expected ${code}, but it worked`);
};

function plannerChecks() {
  const p = require("../src/planner");
  same(p.targetScore("ch", 5), 0.8);
  same(p.gradeFor("ch", 0.8), 5);
  same(p.gradeFor("ch", 0.72), 4.5);
  same(p.gradeFor("de", 1), 1);
  same(p.gradeFor("de", p.targetScore("de", 2)), 2);
  same(p.gradeFor("pct", 0.834), 83);
  same(p.addDays("2026-12-30", 3), "2027-01-02");
  same(p.diffDays("2026-11-21", "2026-11-27"), 6);

  const step = (id, kind, minutes) => ({ id, kind, minutes });
  const topic = (id, share, minutes) => ({
    id,
    title: id,
    share,
    order: Number(id.slice(1)),
    skipCost: "",
    steps: [step(`${id}/r0`, "read", minutes * 0.3), step(`${id}/s0`, "solve", minutes * 0.5), step(`${id}/q`, "quiz", minutes * 0.2)],
  });
  const exam = (over = {}) => ({
    date: "2026-11-27",
    time: { mode: "perDay", minutes: 40 },
    scale: "ch",
    target: 5,
    pace: "sprint",
    strategy: { topics: [topic("t1", 0.4, 60), topic("t2", 0.3, 60), topic("t3", 0.2, 60), topic("t4", 0.1, 100)] },
    done: {},
    mastery: {},
    attempts: {},
    cards: {},
    quizzes: {},
    ...over,
  });
  const today = "2026-11-21";
  let plan = p.buildPlan(exam(), today);
  same(plan.days.length, 6, "study days run up to the day before the exam");
  same(plan.dropped.map((d) => d.topicId), ["t4"], "the topic with the fewest points per minute is left out");
  same(plan.coverage, 0.9);
  ok(plan.reachable && plan.reach === 5.5, "a 5 is in reach with 90% covered");
  ok(plan.days.every((d) => d.tasks.reduce((sum, t) => sum + t.minutes, 0) <= 40 * 1.5), "no day is overloaded");
  const flat = (pl) => pl.days.flatMap((d, i) => d.tasks.map((t) => [t.id, i]));
  const dayOf = (pl, id) => (flat(pl).find(([x]) => x === id) || [])[1];
  ok(dayOf(plan, "t1/q") > dayOf(plan, "t1/s0"), "the quiz comes a day after the exercises");
  ok(flat(plan).some(([id]) => id === "mock"), "time that is left over but too short for the dropped topic goes to a mock exam");
  const tight = p.buildPlan(exam({ time: { mode: "perDay", minutes: 33 } }), today);
  ok(tight.dropped.length === 1 && !flat(tight).some(([id]) => id === "mock"), "no topic is dropped to make room for a mock exam");

  // Too little time for the target: the plan says so.
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 15 } }), today);
  ok(!plan.reachable && plan.short > 0 && plan.reach < 5, "says honestly that the target is out of reach");

  // Plenty of time: everything fits, repetition and a mock exam are added.
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 90 }, pace: "thorough" }), today);
  same(plan.dropped.length, 0);
  ok(flat(plan).some(([id]) => id === "mock") && flat(plan).some(([id]) => id === "t1/q~3"), "mock exam and spaced repetition are planned");

  // Efficient: stops once the target is covered.
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 90 }, pace: "efficient", target: 4 }), today);
  ok(plan.dropped.some((d) => d.reason === "notNeeded"), "efficient leaves out what the target does not need");

  // Falling behind: nothing done, two days later. The plan re-forms and drops more.
  plan = p.buildPlan(exam(), "2026-11-24");
  same(plan.days.length, 3);
  ok(plan.dropped.length >= 2, "with less time left, more is left out");

  // Done work is not planned again, and counts against today's time.
  const done = { "t1/r0": { date: today, minutes: 18, at: 1 } };
  plan = p.buildPlan(exam({ done }), today);
  ok(plan.days[0].tasks[0].done && plan.days[0].tasks[0].id === "t1/r0", "what was done today stays visible");
  same(plan.days.flatMap((d) => d.tasks).filter((t) => t.id === "t1/r0").length, 1);
  // Doing more today pulls work forward.
  const more = p.buildPlan(exam({ done, bonus: { date: today, minutes: 40 } }), today);
  ok(more.days[0].tasks.length > plan.days[0].tasks.length, "extra time today pulls the next task in");

  // A weak quiz brings the topic back; the missed questions come back too.
  const weak = exam({
    done: { "t1/r0": { date: today, minutes: 18 }, "t1/s0": { date: today, minutes: 30 }, "t1/q": { date: today, minutes: 12 } },
    mastery: { t1: 0.4 },
    attempts: { t1: 1 },
    quizzes: { t1: { questions: [{ id: "t1/k0", topicId: "t1" }, { id: "t1/k1", topicId: "t1" }] } },
    cards: { "t1/k0": p.nextCard(null, 0, today), "t1/k1": p.nextCard(null, 1, today) },
  });
  plan = p.buildPlan(weak, "2026-11-22");
  ok(plan.days[0].tasks.some((t) => t.kind === "review"), "a missed question is due the next day");
  same(dayOf(plan, "t1/q#1"), 1, "the weak topic's quiz comes back two days after the first");
  same(p.dueQuestions(weak, "2026-11-22").map((q) => q.id), ["t1/k0"]);
  same(p.nextCard(null, 1, today).due, "2026-11-23");
  same(p.nextCard({ box: 1 }, 1, today).due, "2026-11-25");
  same(p.nextCard({ box: 2 }, 0.5, today), { box: 0, due: "2026-11-23" });

  // The projection follows quiz results and stays honest about what is left out.
  const fresh = p.standing(exam(), p.buildPlan(exam(), today));
  const good = exam({ mastery: { t1: 1, t2: 1, t3: 1 } });
  const bad = exam({ mastery: { t1: 0.2, t2: 0.2, t3: 0.2 } });
  ok(p.standing(good, p.buildPlan(good, today)).projected > fresh.projected, "good quizzes raise the projection");
  ok(p.standing(bad, p.buildPlan(bad, today)).projected < fresh.projected, "weak quizzes lower it");
  ok(fresh.readiness < 0.3 && fresh.projected <= 5, "nobody is ready before starting");
}

function referenceChecks() {
  const { findLabel, checkExercise } = require("../src/engine");
  same(findLabel("5. 6 . 7 . 8.", "7"), 2);
  same(findLabel("costs 17 apples", "7"), 0);
  same(findLabel("Aufgabe 12 a) Berechne", "12 a"), 2);
  same(findLabel("3.2 Lösen Sie die Gleichung", "Aufgabe 3.2"), 2);
  same(findLabel("see figure 4 above", "4"), 1);
  same(findLabel("A solution like this has a pH of 2. Pure water is neutral.", "2"), 1, "a number that ends a sentence is not an exercise number");
  same(findLabel("Vertex opens up. 57 . Vertex opens down.", "57"), 2);
  same(findLabel("Lies den Text.  12  Berechne den pH-Wert.", "12"), 1);
  same(findLabel("Lies den Text.  12.  Berechne den pH-Wert.", "12"), 2, "a number at the start of a column");
  same(findLabel("See Example 1.", "1"), 1);
  const source = { data: { pages: ["Theory, no exercises here.", "1. First\n2. Second\n3. Third", "4. Fourth\n5. Fifth"] } };
  same(checkExercise(source, 2, "2"), { page: 2, state: "confirmed" });
  same(checkExercise(source, 2, "5"), { page: 3, state: "moved" }, "an exercise cited one page off is put on the right page");
  same(checkExercise(source, 1, "9"), { page: 1, state: "unconfirmed" });
  // The model gave the printed page number (12) instead of the page's place in the file (22).
  const book = { data: { pages: Array.from({ length: 30 }, (_, i) => (i === 21 ? "5.1 Section exercises 12\n6. Rewrite in vertex form.\n7. Find the vertex." : `Running text of page ${i + 1 - 10}.`)) } };
  same(checkExercise(book, 12, "7", 10), { page: 22, state: "moved" }, "a printed page number is turned into the page of the file");
  same(checkExercise(book, 12, "7"), { page: 12, state: "unconfirmed" });
}

async function providerChecks() {
  const store = require("../src/store");
  const files = require("../src/files");
  const secrets = require("../src/secrets");
  const ai = require("../src/ai");
  const dir = app.getPath("userData");
  files.init(dir);
  secrets.init(dir, { persist: false });
  store.init({ dir, sample: false });
  ai.init(() => store.settings());

  // ---- Anthropic
  const seen = [];
  let mode = "good";
  const anthropic = await serve((req, body, res) => {
    seen.push({ url: req.url, headers: req.headers, body });
    // The SDK sends the key as a bearer token with the current API version; older ones used x-api-key.
    const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (key !== "sk-ant-test") return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (mode === "refuse") return anthropicStream(res, "", "refusal");
    if (mode === "cut") return anthropicStream(res, '{"answer":', "max_tokens");
    if (mode === "bad-then-good" && !body.messages[0].content.at(-1).text.includes("previous answer")) return anthropicStream(res, "The answer is five.");
    anthropicStream(res, '{"answer": 5}');
  });
  process.env.SPURT_ANTHROPIC_BASE_URL = anthropic.url;
  store.setSettings({ ai: { provider: "anthropic" } });
  same((await ai.status()).ready, false, "not ready without a key");
  await failsWith(ai.ask(request("no key yet")), "noKey");
  await secrets.set("anthropic", "sk-ant-test");
  const usage = [];
  same(await ai.ask(request("What is two plus three?"), { onUsage: (u) => usage.push(u) }), { answer: 5 });
  const sent = seen.at(-1);
  same(sent.body.model, "claude-opus-5-5", "the default model");
  ok(sent.url.startsWith("/v1/messages"), "the Messages endpoint");
  same(sent.body.output_config.format, { type: "json_schema", schema: SCHEMA }, "structured output is requested");
  same(sent.body.fallbacks, "default", "refusal fallback is on");
  ok(String(sent.headers["anthropic-beta"]).includes("server-side-fallback-2026-07-01"));
  ok(!("cache_control" in sent.body.messages[0].content[0]), "a one-off question does not pay for writing the cache");
  await ai.ask(request("Asked again soon", { cache: true }));
  same(seen.at(-1).body.messages[0].content[0].cache_control, { type: "ephemeral" }, "material that will be asked about again is marked for caching");
  ok(sent.body.messages[0].content[0].text.includes("two and three") && sent.body.stream === true);
  ok(!("thinking" in sent.body) && !("temperature" in sent.body), "no parameters the current models reject");
  same(usage, [{ input: 140, cached: 0, written: 40, output: 12 }]);
  const { cost } = require("../src/ai/models");
  same(Math.round(cost([4, 20, 0.2], { input: 1000, cached: 400, written: 300, output: 100 }) * 1e6), 4780, "plain, written and cached input each have their price");
  // Settings for the SDK in the environment must not reach the request.
  Object.assign(process.env, { ANTHROPIC_CUSTOM_HEADERS: "X-Injected: yes", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_LOG: "debug" });
  same(await ai.ask(request("Environment case")), { answer: 5 }, "another server named in the environment is ignored");
  ok(!("x-injected" in seen.at(-1).headers) && !Object.keys(process.env).some((k) => k.startsWith("ANTHROPIC_")), "no header from the environment is sent");
  same(seen.at(-1).body.max_tokens, 32000, "room for a model that thinks before it answers");
  const before = seen.length;
  same(await ai.ask(request("What is two plus three?")), { answer: 5 });
  same(seen.length, before, "the same question is answered from disk, not asked again");
  mode = "bad-then-good";
  same(await ai.ask(request("Retry case")), { answer: 5 }, "an unusable answer is asked for once more");
  same(seen.length, before + 2);
  mode = "refuse";
  await failsWith(ai.ask(request("Refusal case")), "refusal");
  mode = "cut";
  await failsWith(ai.ask(request("Cut off case")), "tooLong");
  mode = "good";
  await secrets.set("anthropic", "sk-ant-wrong");
  await failsWith(ai.ask(request("Bad key case")), "badKey");
  store.setSettings({ ai: { provider: "anthropic", model: "claude-haiku-5-5" } });
  await secrets.set("anthropic", "sk-ant-test");
  await ai.ask(request("Haiku case"));
  ok(!("fallbacks" in seen.at(-1).body) && !seen.at(-1).headers["anthropic-beta"], "no refusal fallback where the model has none");
  anthropic.close();

  // ---- OpenRouter
  const calls = [];
  let style = "strict";
  const openrouter = await serve((req, body, res) => {
    calls.push({ url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== "Bearer sk-or-test") return json(res, 401, { error: { message: "No auth credentials found", code: 401 } });
    if (style === "broke") return json(res, 402, { error: { message: "Insufficient credits", code: 402 } });
    if (style === "flagged") return json(res, 403, { error: { message: "Your input was flagged by moderation", code: 403 } });
    // No provider of the model takes structured output: OpenRouter says 404 (or 503) until the request is simpler.
    if (style === "no-endpoint" && body.response_format?.type === "json_schema") return json(res, 404, { error: { message: "No endpoints found that support the requested parameters", code: 404 } });
    if (style === "no-endpoint" && body.response_format) return json(res, 503, { error: { message: "No instances available", code: 503 } });
    if (style === "long") return json(res, 200, { choices: [{ finish_reason: "length", message: { content: '{"answer":' } }] });
    if (style === "stream") {
      // The answer in pieces, the way a real server streams it, with a keep-alive comment in between.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const piece = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      piece({ choices: [{ delta: { role: "assistant", content: '{"ans' } }] });
      res.write(": OPENROUTER PROCESSING\n\n");
      piece({ choices: [{ delta: { content: 'wer": 5}' } }] });
      piece({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 6, cost: 0.0003 } });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (style === "stream-error") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } })}\n\n`);
      return res.end();
    }
    json(res, 200, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"answer": 5}' } }],
      usage: { prompt_tokens: 90, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 }, cost: 0.0004 },
    });
  });
  process.env.SPURT_OPENROUTER_BASE_URL = openrouter.url;
  store.setSettings({ ai: { provider: "openrouter" } });
  await secrets.set("openrouter", "sk-or-test");
  usage.length = 0;
  same(await ai.ask(request("OpenRouter case"), { onUsage: (u) => usage.push(u) }), { answer: 5 });
  const or = calls.at(-1);
  same(or.url, "/chat/completions");
  same(or.body.stream, true, "answers are streamed");
  ok(!("stream_options" in or.body), "OpenRouter reports usage its own way");
  same(or.body.response_format, { type: "json_schema", json_schema: { name: "sum", strict: true, schema: SCHEMA } });
  same(or.body.provider, { require_parameters: true }, "only providers that can do structured output");
  same(or.body.messages[1].content[0].cache_control, { type: "ephemeral" });
  same(usage, [{ input: 90, cached: 60, output: 7, cost: 0.0004 }]);
  style = "stream";
  usage.length = 0;
  same(await ai.ask(request("Streamed case"), { onUsage: (u) => usage.push(u) }), { answer: 5 }, "a streamed answer is put together");
  same(usage, [{ input: 80, cached: 0, output: 6, cost: 0.0003 }]);
  style = "stream-error";
  await failsWith(ai.ask(request("Error in the stream")), "rateLimit");
  ok(!("max_tokens" in or.body), "the length of the answer is left to the model");
  style = "flagged";
  try {
    await ai.ask(request("Flagged case"));
    assert.fail("a 403 must not pass");
  } catch (err) {
    same([err.code, /flagged by moderation/.test(err.detail)], ["provider", true], "a 403 from OpenRouter is shown with its own words, not as a wrong key");
  }
  style = "no-endpoint";
  const beforeFallback = calls.length;
  same(await ai.ask(request("No provider takes the schema")), { answer: 5 }, "404 and 503 lead to the simpler request");
  same(calls.length - beforeFallback, 3);
  style = "broke";
  await failsWith(ai.ask(request("No credit case")), "noCredit");
  style = "long";
  await failsWith(ai.ask(request("Too long case")), "tooLong");
  await secrets.set("openrouter", "nope");
  await failsWith(ai.ask(request("Bad key case, OpenRouter")), "badKey");
  openrouter.close();

  // ---- Another server in the OpenAI format: one that knows structured output, one that does not
  const plain = [];
  const local = await serve((req, body, res) => {
    plain.push(body);
    if (body.response_format) return json(res, 400, { error: { message: "response_format is not supported" } });
    json(res, 200, { choices: [{ finish_reason: "stop", message: { content: 'Sure!\n```json\n{"answer": 5}\n```' } }], usage: { prompt_tokens: 50, completion_tokens: 9 } });
  });
  store.setSettings({ ai: { provider: "openai", model: "", baseURL: local.url + "/v1/" } });
  same((await ai.status()).ready, false, "not ready without a model name");
  store.setSettings({ ai: { provider: "openai", model: "local-model" } });
  same(await ai.ask(request("Local server case")), { answer: 5 }, "falls back to a plain request and still gets JSON out");
  same(plain.length, 3, "structured output, then JSON mode, then plain");
  ok(typeof plain[2].messages[1].content === "string" && plain[2].messages[1].content.includes('"additionalProperties":false'), "the schema is given in words");
  ok(!("provider" in plain[0]) && !("usage" in plain[0]), "nothing OpenRouter-specific goes to another server");
  same(plain[0].stream_options, { include_usage: true });
  ok(!("stream_options" in plain[2]) && !("response_format" in plain[2]), "the last try is the plainest request there is");
  local.close();
  // 404: a model the server does not have, or an address that leads nowhere.
  const lost = await serve((req, body, res) =>
    req.url.startsWith("/v1/") ? json(res, 404, { error: { message: 'model "local-model" not found, try pulling it first' } }) : res.writeHead(404).end("404 page not found"),
  );
  store.setSettings({ ai: { provider: "openai", model: "local-model", baseURL: lost.url + "/v1" } });
  await failsWith(ai.ask(request("Unknown model")), "noModel");
  store.setSettings({ ai: { provider: "openai", model: "local-model", baseURL: lost.url + "/api" } });
  await failsWith(ai.ask(request("Wrong address")), "badAddress");
  lost.close();
  store.setSettings({ ai: { provider: "openai", model: "local-model", baseURL: "http://127.0.0.1:9/v1" } });
  await failsWith(ai.ask(request("Nobody home")), "offline");

  // ---- the address of "another server", and what belongs to it
  const { allowedAddress, origin } = require("../src/address");
  same(["https://api.example.com/v1", "http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1"].map(allowedAddress), [true, true, true, true]);
  same(["http://example.com/v1", "http://192.168.1.20:11434/v1", "ftp://localhost/v1", "localhost:11434", ""].map(allowedAddress), [false, false, false, false, false], "plain http only on this computer");
  same(origin("https://a.example/v1") === origin("https://a.example/other"), true);
  try {
    store.setSettings({ ai: { provider: "openai", baseURL: "http://example.com/v1" } });
    assert.fail("plain http to another computer must be refused");
  } catch (err) {
    same(err.code, "insecureAddress");
  }
  const { connectionError } = require("../src/ai/openai");
  same(connectionError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })).code, "slow", "a server that stays silent is not called a missing connection");
  same(connectionError(new TypeError("fetch failed")).code, "offline");

  // ---- files: nothing is read once cancelled, and what no exam uses is deleted
  const { BrowserWindow } = require("electron");
  const printer = new BrowserWindow({ show: false });
  await printer.loadURL("data:text/html," + encodeURIComponent("<h1>Chapter 1</h1><p>" + "Some text to read. ".repeat(40) + "</p>"));
  const pdfFile = path.join(dir, "small.pdf");
  fs.writeFileSync(pdfFile, await printer.webContents.printToPDF({}));
  printer.destroy();
  const gone = new AbortController();
  gone.abort();
  await failsWith(files.add(pdfFile, null, gone.signal), "cancelled");
  ok(!fs.existsSync(path.join(dir, "library")) || !fs.readdirSync(path.join(dir, "library")).length, "a cancelled file is not kept");
  const item = await files.add(pdfFile);
  same([item.pages, item.scanned, item.chars > 500], [1, false, true], "and read when it is not cancelled");
  fs.rmSync(path.join(dir, "library"), { recursive: true });
  fs.rmSync(path.join(dir, "texts"), { recursive: true });
  for (const [folder, name] of [["library", "aaa.pdf"], ["library", "bbb.pdf"], ["texts", "aaa.json"], ["texts", "bbb.json"], ["answers", "k1.json"], ["answers", "k2.json"]]) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, name), "x");
  }
  files.prune({ hashes: new Set(["aaa"]), answers: new Set(["k1"]) });
  same(["library", "texts", "answers"].map((f) => fs.readdirSync(path.join(dir, f)).filter((n) => /^(aaa|bbb|k1|k2)\./.test(n)).join()), ["aaa.pdf", "aaa.json", "k1.json"], "files no exam uses are deleted");

  // ---- how Claude Code says "sign in (again)"
  const { signInProblem } = require("../src/ai/claude-code");
  same(signInProblem("Not logged in · Please run /login"), "signedOut");
  same(signInProblem("Failed to authenticate: OAuth session expired and could not be refreshed"), "expired", "the sentence from the bug report");
  same(signInProblem('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}'), "expired");
  same([signInProblem("Credit balance is too low"), signInProblem("Claude usage limit reached")], [null, null], "other failures are not taken for a sign-in problem");

  // ---- keys never reach the settings file or the window
  const settingsFile = fs.readFileSync(path.join(dir, "spurt.json"), "utf8");
  ok(!/sk-ant|sk-or/.test(settingsFile), "no key in the settings file");
  ok(!JSON.stringify(await ai.status()).includes("sk-"), "the status sent to the window holds no key");
}

app.whenReady().then(async () => {
  try {
    plannerChecks();
    referenceChecks();
    await providerChecks();
    console.log(`ok: ${checks} checks`);
  } catch (err) {
    console.log("FAIL", err.message, "\n", String(err.stack).split("\n").slice(1, 4).join("\n"));
    process.exitCode = 1;
  }
  app.quit();
});

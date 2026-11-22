// Checks of the parts that need no window:
//
//   node_modules/.bin/electron scripts/test.js
//
// - the planner (grades, what fits, what is left out, the order, what is for today, what an exam puts back)
// - results typed by the student compared with the expected ones (numbers in every notation)
// - the search through the pages of a book, the store (damaged file, backup, language, kept ticks)
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
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-")));
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
  // Topics are numbered against the book's order on purpose: t1 is the last chapter.
  const topic = (id, share, minutes, order) => ({
    id,
    title: id,
    share,
    order,
    skipCost: "",
    steps: [step(`${id}/r0`, "read", minutes * 0.4), step(`${id}/s0`, "solve", minutes * 0.6), step(`${id}/q`, "quiz", 10)],
  });
  const exam = (over = {}) => ({
    date: "2026-11-27",
    time: { mode: "perDay", minutes: 40 },
    scale: "ch",
    target: 5,
    pace: "sprint",
    strategy: { topics: [topic("t1", 0.4, 60, 40), topic("t2", 0.3, 60, 30), topic("t3", 0.2, 60, 20), topic("t4", 0.1, 100, 10)] },
    done: {},
    again: [],
    ...over,
  });
  const today = "2026-11-21";
  const ids = (pl) => pl.stages.flatMap((st) => st.tasks.map((t) => t.id));
  let plan = p.buildPlan(exam(), today);
  same(plan.days.length, 6, "study days run up to the day before the exam");
  same(plan.dropped.map((d) => d.topicId), ["t4"], "the topic with the fewest points per minute is left out");
  same(plan.stages.map((st) => st.id), ["t3", "t2", "t1"], "what stays is done in the book's order");
  ok(!ids(plan).some((id) => id.endsWith("/q")), "no quizzes on the list where the book has exercises");
  same(plan.coverage, 0.9);
  ok(plan.reachable && plan.reach === 5.5, "a 5 is in reach with 90% covered");
  ok(plan.days.every((d) => d.tasks.reduce((sum, t) => sum + t.minutes, 0) <= 40 * 1.6), "no day is overloaded");
  same([plan.percent, plan.next], [0, "t3/r0"], "nothing done: the first step of the first chapter is up");
  same(plan.today, { steps: 1, minutes: 24, end: "t3/r0" }, "today's steps are the next ones, as far as today's minutes reach");
  ok(plan.stages[0].tasks[0].today && !plan.stages[0].tasks[1].today);

  // Too little time for the target: the plan says so.
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 15 } }), today);
  ok(!plan.reachable && plan.short > 0 && plan.reach < 5, "says honestly that the target is out of reach");

  // Plenty of time: everything fits.
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 90 }, pace: "thorough" }), today);
  same([plan.dropped.length, plan.stages.map((st) => st.id).join()], [0, "t4,t3,t2,t1"]);

  // Efficient: stops once the target is covered.
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 90 }, pace: "efficient", target: 4 }), today);
  ok(plan.dropped.some((d) => d.reason === "notNeeded"), "efficient leaves out what the target does not need");

  // Falling behind: nothing done, two days later. The plan re-forms and drops more.
  plan = p.buildPlan(exam(), "2026-11-24");
  same(plan.days.length, 3);
  ok(plan.dropped.length >= 2, "with less time left, more is left out");

  // Done work counts, by minutes, and against today's time.
  const done = { "t3/r0": { date: today, minutes: 24, at: 1 }, "t3/s0": { date: today, minutes: 36, at: 2 } };
  plan = p.buildPlan(exam({ done }), today);
  same(plan.percent, 33, "a third of the minutes is done");
  same([plan.next, plan.today.steps], ["t2/r0", 0], "today's time is used up: the rest is ahead of plan");
  ok(plan.days[0].tasks.every((t) => t.done), "what was done today stays on today");
  const everything = Object.fromEntries(["t3", "t2", "t1"].flatMap((t) => [`${t}/r0`, `${t}/s0`]).map((id) => [id, { date: "2026-11-20", minutes: 30 }]));
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 10 }, done: everything }), today);
  same([plan.percent, plan.next, plan.dropped.length], [100, null, 1], "everything ticked is 100%");
  // Time that is left when the list is done lets a topic that was left out back in.
  plan = p.buildPlan(exam({ done: everything }), today);
  same([plan.dropped.length, plan.next], [0, "t4/r0"]);

  // Time "in total" is shared out to the minute: an hour over 14 days is an hour.
  plan = p.buildPlan(exam({ date: "2026-12-05", time: { mode: "total", minutes: 60 } }), today);
  same([plan.available, plan.days.length, plan.perDay], [60, 14, 4]);

  // A topic whose book has no exercises gets questions instead; others never do.
  const bare = exam({ time: { mode: "perDay", minutes: 90 } });
  bare.strategy.topics[0].steps = bare.strategy.topics[0].steps.filter((x) => x.kind !== "solve");
  plan = p.buildPlan(bare, today);
  same(ids(plan).filter((id) => id.endsWith("/q")), ["t1/q"]);

  // What an exam result puts back comes after everything else, and lowers the percentage.
  const again = [{ id: "t2/a1", topicId: "t2", score: 0.3, steps: [step("t2/a1/r0", "read", 10), step("t2/a1/s0", "solve", 20)] }];
  plan = p.buildPlan(exam({ time: { mode: "perDay", minutes: 10 }, done: everything, again }), today);
  same([plan.stages.at(-1).id, plan.stages.at(-1).again, plan.next], ["t2/a1", true, "t2/a1/r0"]);
  ok(plan.percent < 100 && plan.percent > 80);

  // An exam whose date has passed: the list stays, nothing is "for today", and it says so.
  plan = p.buildPlan(exam(), "2026-12-01");
  same([plan.over, plan.daysLeft, plan.today.steps], [true, 0, 0]);
}

function answerChecks() {
  const a = require("../src/answers");
  // One number, written the ways people write numbers.
  const right = [
    ["21920.70", 21920.7, 0.005], ["21'920.70", 21920.7, 0.005], ["CHF 21 920.70", 21920.7, 0.005], ["21 920,70", 21920.7, 0.005], ["21.920,70", 21920.7, 0.005],
    ["21,920.70", 21920.7, 0.005], ["21921", 21920.7, 0.005], ["1 234,5", 1234.5, 0], ["CHF 1’234.50", 1234.5, 0], ["1234.5 m", 1234.5, 0], ["x = 3", 3, 0], ["f(2) = 5", 5, 0],
    ["2x = 10 → x = 5", 5, 0], ["x_1 = 5", 5, 0], ["5,00", 5, 0], ["3/4", 0.75, 0], ["6/8", 0.75, 0], ["x=3/4", 0.75, 0], [".75", 0.75, 0], ["0,75", 0.75, 0], ["75%", 0.75, 0],
    ["12 %", 12, 0], ["−2.5", -2.5, 0], ["- 0.75", -0.75, 0], ["-3/4", -0.75, 0], ["1,5·10^3", 1500, 0], ["1,5 x 10^3", 1500, 0], ["1.5e3", 1500, 0], ["10^3", 1000, 0],
    ["2^3", 8, 0], ["2 1/2", 2.5, 0], ["sqrt(2)", 1.41421356, 0], ["√2", 1.41421356, 0], ["2√2", 2.828427, 0], ["pi/2", 1.570796, 0], ["3π", 9.424778, 0], ["1,234", 1234, 0],
    ["1,234", 1.234, 0], ["1.000.000", 1e6, 0], ["1 000 000", 1e6, 0], ["140 feet", 140, 0], ["5 m/s", 5, 0], ["12 cm^2", 12, 0], ["12 m²", 12, 0], ["9.81 m/s^2", 9.81, 0],
    ["h = 2,5 Sekunden", 2.5, 0], ["0.33", 1 / 3, 0.01],
    // Rounded to the precision that was typed: right, unless it changes the value by more than a little.
    ["4.65", 4.646, 0], ["1.41", 1.41421356, 0], ["0.333", 1 / 3, 0], ["0.33", 1 / 3, 0],
  ];
  for (const [typed, expected, tolerance] of right) ok(a.numberRight(typed, expected, tolerance), `"${typed}" is ${expected}`);
  const wrong = [["21900", 21920.7, 0.005], ["22000", 21920.7, 0.005], ["2.5", -2.5, 0], ["-5", 5, 0], ["0.3", 1 / 3, 0], ["", 7, 0], ["seven", 7, 0], ["no solution", 2, 0], ["70", 7, 0], ["31", 3, 0], ["12", 12.4, 0], ["5", 4.646, 0], ["4 (not 5)", 5, 0]];
  for (const [typed, expected, tolerance] of wrong) ok(!a.numberRight(typed, expected, tolerance), `"${typed}" is not ${expected}`);
  // Several numbers, in any order, with any of the usual separators.
  for (const typed of ["x1 = 2; x2 = 3", "x2=3; x1=2", "3 and 2", "2, 3", "2,3", "{3;2}", "x = 2 or x = 3", "2 und 3", "2 oder 3", "2 3", "x=2, x=3", "x₁=2; x₂=3", "(2, 3)", "x ∈ {2, 3}", "x=2 ∨ x=3", "2 / 3"]) ok(a.numbersRight(typed, [2, 3], 0), `"${typed}" names 2 and 3`);
  for (const typed of ["x1 = 1,5; x2 = -2", "1,5 / -2", "1.5, -2", "1,5, -2", "-2 und 1,5", "3/2 and -2", "x=3/2, x=-2", "1 1/2 und -2"]) ok(a.numbersRight(typed, [-2, 1.5], 0), `"${typed}" names 1.5 and -2`);
  ok(a.numbersRight("4,646 / -0,646", [4.646, -0.646], 0.0005), "the notation from the bug report");
  ok(a.numbersRight("4.65; -0.65", [4.646, -0.646], 0) && a.numbersRight("-4.65; 0.65", [0.65, -4.65], 0.005));
  for (const typed of ["±2", "+-2", "2 and -2", "x = ±2"]) ok(a.numbersRight(typed, [-2, 2], 0), `"${typed}" names 2 and -2`);
  ok(a.numbersRight("1/2, 3/4", [0.5, 0.75], 0) && a.numbersRight("2√2 und -2√2", [2.828, -2.828], 0.001));
  for (const typed of ["2", "2; 2", "2;3;4", "2 oder 4", ""]) ok(!a.numbersRight(typed, [2, 3], 0), `"${typed}" does not name 2 and 3`);
}

/** The move from the folder of Spurt (the app's earlier name) into this app's folder. */
function moveChecks() {
  const { fromSpurt } = require("../src/move");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-move-"));
  const make = (name) => {
    const dir = path.join(base, name);
    for (const folder of ["library", "texts", "answers"]) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, "spurt.json"), JSON.stringify({ settings: {}, exams: [{ id: "e1" }] }));
    fs.writeFileSync(path.join(dir, "spurt.backup.json"), "{}");
    fs.writeFileSync(path.join(dir, "spurt.backup.1.json"), "{}");
    fs.writeFileSync(path.join(dir, "library", "a.pdf"), "book a");
    fs.writeFileSync(path.join(dir, "library", "b.pdf"), "book b");
    fs.writeFileSync(path.join(dir, "texts", "a.json"), "{}");
    fs.writeFileSync(path.join(dir, "answers", "k.json"), "{}");
    return dir;
  };
  const list = (dir) => fs.readdirSync(dir).sort().map((n) => (fs.statSync(path.join(dir, n)).isDirectory() ? `${n}/${fs.readdirSync(path.join(dir, n)).sort().join("+")}` : n)).join(" ");
  // Nothing to move: a first start with no Spurt on the Mac.
  same(fromSpurt(path.join(base, "fresh"), path.join(base, "no-such-folder")), null);
  same(fromSpurt(path.join(base, "fresh"), null), null);
  // Everything comes over; Spurt's own data file is renamed, never deleted.
  let old = make("old1");
  same(fromSpurt(path.join(base, "new1"), old), { exams: true, keys: false });
  same(list(path.join(base, "new1")), "aced.backup.1.json aced.backup.json aced.json answers/k.json library/a.pdf+b.pdf texts/a.json");
  same(list(old), "answers/ library/ spurt.backup.1.json spurt.backup.json spurt.moved-to-aced.json texts/");
  same(JSON.parse(fs.readFileSync(path.join(base, "new1", "aced.json"), "utf8")).exams[0].id, "e1");
  same(fromSpurt(path.join(base, "new1"), old), null, "a second start moves nothing");
  // A saved key is noticed (it cannot be read under the new name) and left where it is.
  old = make("old2");
  fs.writeFileSync(path.join(old, "keys.bin"), "locked");
  same(fromSpurt(path.join(base, "new2"), old), { exams: true, keys: true });
  ok(fs.existsSync(path.join(old, "keys.bin")) && !fs.existsSync(path.join(base, "new2", "keys.bin")));
  // Cut short (the app was quit after one book had moved): the next start carries on, and nothing is lost or doubled.
  old = make("old3");
  fs.mkdirSync(path.join(base, "new3", "library"), { recursive: true });
  fs.renameSync(path.join(old, "library", "a.pdf"), path.join(base, "new3", "library", "a.pdf"));
  ok(!fs.existsSync(path.join(base, "new3", "aced.json")), "without the data file the move does not count as done");
  same(fromSpurt(path.join(base, "new3"), old), { exams: true, keys: false });
  same(list(path.join(base, "new3")), "aced.backup.1.json aced.backup.json aced.json answers/k.json library/a.pdf+b.pdf texts/a.json");
  same(fs.readFileSync(path.join(base, "new3", "library", "a.pdf"), "utf8"), "book a");
  // A folder that holds the old file name itself (a profile folder renamed by hand) is read in place.
  old = make("old4");
  same(fromSpurt(old, null), { exams: true, keys: false });
  ok(fs.existsSync(path.join(old, "aced.json")) && fs.existsSync(path.join(old, "library", "a.pdf")));
  // Aced's own data is never replaced by Spurt's.
  old = make("old5");
  fs.mkdirSync(path.join(base, "new5"));
  fs.writeFileSync(path.join(base, "new5", "aced.json"), "mine");
  same(fromSpurt(path.join(base, "new5"), old), null);
  same([fs.readFileSync(path.join(base, "new5", "aced.json"), "utf8"), fs.existsSync(path.join(old, "spurt.json"))], ["mine", true]);
  fs.rmSync(base, { recursive: true, force: true });
}

function searchChecks() {
  const { rank, words } = require("../src/search");
  same(words("Die Aufgaben zum Zinseszins"), words("aufgabe ZINSESZINSEN"), "plural, case and stop words do not matter");
  const pages = ["Quadratic functions have a vertex.", "Section exercises: find the vertex of each parabola.", "Die Aufgaben zum Zinseszins: Berechne das Endkapital.", "Logarithms."];
  same(rank([{ n: 1, hash: "t1", pages }], "Where do I find exercises on the vertex?")[0].page, 2);
  same(rank([{ n: 1, hash: "t1", pages }], "Auf welcher Seite finde ich Aufgaben für Zinseszins?")[0].page, 3);
  same(rank([{ n: 1, hash: "t1", pages }], "wo?"), [], "nothing to search for finds nothing");
}

function errorChecks() {
  const { problemOf } = require("../src/ai/claude-code");
  const code = (text) => {
    const e = problemOf(text, "claude-haiku-5-5");
    return e.detail ? `${e.code}: ${e.detail}` : e.code;
  };
  same(code("Claude usage limit reached. Your limit will reset at 7pm (Europe/Zurich)."), "usageLimit: 7pm (Europe/Zurich)", "the reset time is kept");
  same(code("API Error: Connection error."), "offline");
  same(code('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "overloaded");
  same(code("There's an issue with the selected model (claude-haiku-5-5). It may not exist or you may not have access to it. Run /model to pick a different model."), "noModel: claude-haiku-5-5");
  same(code('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), "serverError");
  same(code("Not logged in · Please run /login"), "signIn: signedOut");
  ok(!/[{}]/.test(code('Something odd {"a":1} happened')) || code('Something odd {"a":1} happened').startsWith("provider: Claude Code:"), "anything else is passed on as words");

  const { completeAddress, allowedAddress } = require("../src/address");
  same(completeAddress("localhost:7802/v1"), "http://localhost:7802/v1", "a local address without http:// is completed");
  same(completeAddress("api.example.com/v1"), "https://api.example.com/v1");
  ok(allowedAddress(completeAddress("127.0.0.1:11434/v1")) && !allowedAddress(completeAddress("http://example.com/v1")) && !allowedAddress(completeAddress("hello world")));
}

function storeChecks() {
  const store = require("../src/store");
  const files = require("../src/files");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-store-"));
  const file = path.join(dir, "aced.json");
  // A first start follows the Mac's language; a choice is kept.
  store.init({ dir, sample: false, systemLang: "de" });
  same([store.settings().lang, store.problem()], ["de", null]);
  store.setSettings({ lang: "en" });
  store.init({ dir, sample: false, systemLang: "de" });
  same(store.settings().lang, "en", "a language that was chosen stays");
  // A file from 0.1 with the default English on a German Mac follows the Mac; German was a choice.
  fs.writeFileSync(file, JSON.stringify({ settings: { lang: "en", appearance: "system", ai: { provider: null, models: {}, baseURL: "" } }, exams: [] }));
  store.init({ dir, sample: false, systemLang: "de" });
  same(store.settings().lang, "de");
  fs.writeFileSync(file, JSON.stringify({ settings: { lang: "de" }, exams: [] }));
  store.init({ dir, sample: false, systemLang: "en" });
  same(store.settings().lang, "de");

  // An exam, a strategy, ticks; a new strategy keeps the ticks of steps that say the same.
  const exam = store.createExam({ name: "Test", date: "2099-01-01", time: { mode: "total", minutes: 60 * 100000 } });
  ok(exam.time.minutes <= 60 * 400, "time in total is capped");
  const strategy = (labels) => ({ topics: [{ id: "t1", title: "T", share: 1, order: 1, objectives: [], steps: [{ id: "t1/r0", kind: "read", material: "m", from: 3, to: 5, minutes: 10 }, { id: "t1/s0", kind: "solve", material: "m", page: 6, labels, minutes: 10 }] }] });
  store.setStrategy(exam.id, strategy(["1", "2"]));
  store.change(exam.id, (e) => (e.done = { "t1/r0": { date: "2026-01-01", minutes: 10 }, "t1/s0": { date: "2026-01-01", minutes: 10 } }));
  store.change(exam.id, (e) => {
    e.sets = { "final#0": { key: "final#0", final: true, variant: 0, topicIds: ["t1"], questions: [{ id: "k0", topicId: "t1" }], spare: {}, result: { weak: ["t1"], topics: { t1: { points: 0, max: 2 } }, points: 0, max: 2 } } };
    e.again = [{ id: "t1/ax", topicId: "t1", from: "final#0", steps: [{ id: "t1/ax/r0", kind: "read", material: "m", from: 3, to: 5, minutes: 5 }] }];
    e.formulas = [{ topicId: "t1", formulas: [] }];
  });
  // A new strategy never says the same steps again. What was done still counts: pages mostly
  // read stay read, exercises solved stay solved and are not handed out again, and the exam
  // result with the topic it put back stays, under the topic's new number.
  const again = { topics: [{ id: "t1", title: "Other", share: 0.5, order: 1, objectives: [], steps: [{ id: "t1/r0", kind: "read", material: "m", from: 40, to: 41, minutes: 5 }] }, { id: "t2", title: "T", share: 0.5, order: 2, objectives: [], steps: [{ id: "t2/r0", kind: "read", material: "m", from: 4, to: 6, minutes: 12 }, { id: "t2/s0", kind: "solve", material: "m", page: 7, labels: ["2", "1"], minutes: 9 }, { id: "t2/s1", kind: "solve", material: "m", page: 6, labels: ["1", "9"], minutes: 10 }] }] };
  store.setStrategy(exam.id, again);
  let now = store.exam(exam.id);
  same(Object.keys(now.done).sort(), ["t2/r0", "t2/s0"], "read p. 3-5 covers most of p. 4-6; exercises 1 and 2 were solved, also when cited a page off");
  same([now.strategy.topics[1].steps[2].labels, now.strategy.topics[1].steps[2].solved, now.strategy.topics[1].steps[2].minutes], [["9"], ["1"], 5], "a step with one new exercise hands out only that one");
  same([now.sets["final#0"].topicIds, now.sets["final#0"].result.weak, now.again[0].topicId, now.sets["final#0"].titles.t2], [["t2"], ["t2"], "t2", "T"], "the exam result and its topic move to the topic's new number");
  same(store.view(now).undo.lost, 0, "nothing that was ticked is lost");
  same(store.view(now).final.state, "done");
  // One click brings the earlier plan back, as it was.
  store.undoStrategy(exam.id);
  now = store.exam(exam.id);
  same([Object.keys(now.done), now.strategy.topics[0].steps[1].labels, now.again[0].topicId, Boolean(now.formulas), now.previous], [["t1/r0", "t1/s0"], ["1", "2"], "t1", true, undefined]);
  // A plan about something else entirely loses the ticks, says how many, and can be undone too.
  store.setStrategy(exam.id, { topics: [{ id: "t1", title: "Elsewhere", share: 1, order: 1, objectives: [], steps: [{ id: "t1/r0", kind: "read", material: "m", from: 90, to: 99, minutes: 5 }] }] });
  same([Object.keys(store.exam(exam.id).done), store.view(store.exam(exam.id)).undo.lost, store.exam(exam.id).again.length, store.exam(exam.id).sets["final#0"].result.points], [[], 2, 0, 0], "the result stays in the record even when its topic is gone");
  store.undoStrategy(exam.id);
  store.change(exam.id, (e) => ((e.sets = {}), (e.again = [])));
  store.setStrategy(exam.id, strategy(["1", "3"]));
  same(store.view(store.exam(exam.id)).percent, 67, "the reading is done, and of the exercises only the new one is left");
  // The same file or text a second time is said to be there already.
  same(store.addMaterial(exam.id, { hash: "h1", type: "text", title: "First", pages: 1, chars: 10 }, "notes"), "");
  same(store.addMaterial(exam.id, { hash: "h1", type: "text", title: "Copy", pages: 1, chars: 10 }, "notes"), "First");
  // A step that points into material that is gone is noticed.
  ok(store.view(store.exam(exam.id)).missing, "the plan points at material that is not there");

  // A damaged file is never written over; the backup of the last good start can take its place.
  store.init({ dir, sample: false });
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, good.slice(0, good.length / 2));
  store.init({ dir, sample: false });
  ok(store.problem() && store.problem().backup, "the damage is noticed and there is a backup");
  same(store.exams().length, 0);
  store.setSettings({ appearance: "dark" });
  same(fs.readFileSync(file, "utf8"), good.slice(0, good.length / 2), "nothing is written while the file is damaged");
  store.recover("backup");
  same([store.problem(), store.exams().length, store.exams()[0].name], [null, 1, "Test"]);
  ok(fs.readdirSync(dir).some((name) => name.startsWith("aced.damaged-")), "the damaged file is kept beside it");
  // Backups are also taken while the app stays open, and a few generations are kept.
  for (let i = 0; i < 60; i++) store.setSettings({ appearance: i % 2 ? "dark" : "light" });
  ok(fs.existsSync(path.join(dir, "aced.backup.1.json")) && fs.existsSync(path.join(dir, "aced.backup.2.json")), "after many changes there are several backups");
  fs.writeFileSync(path.join(dir, "aced.backup.json"), "broken too");
  fs.writeFileSync(file, "{");
  store.init({ dir, sample: false });
  ok(store.problem().backup, "when the newest backup is damaged as well, the one before it is offered");
  store.recover("backup");
  same(store.exams()[0].name, "Test");
  fs.writeFileSync(file, "{ not json");
  for (const name of fs.readdirSync(dir)) if (name.startsWith("aced.backup")) fs.rmSync(path.join(dir, name));
  store.init({ dir, sample: false });
  same(store.problem(), { backup: null });
  store.recover("empty");
  same([store.problem(), store.exams().length], [null, 0]);

  // A file written by the released 0.1.0 (scripts/fixtures/profile-0.1.0.json: a real strategy,
  // two ticked steps, one quiz) opens as it is: the plan is there, the ticks count, and nothing
  // 0.1 kept is thrown away, although 0.2 no longer uses all of it.
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "profile-0.1.0.json"), "utf8"));
  const carried = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-carry-"));
  fs.writeFileSync(path.join(carried, "aced.json"), JSON.stringify(old));
  store.init({ dir: carried, sample: false, systemLang: "de" });
  same([store.problem(), store.exams().length, store.settings().lang], [null, 1, "de"], "it is read, and follows the Mac's language (0.1 only knew its default)");
  const then = store.view(store.exam(old.exams[0].id), "2026-11-21");
  same([then.percent, then.plan.next, then.final.state, then.plan.stages.some((st) => st.tasks.some((t) => t.kind === "quiz"))], [14, "t1/r0", "none", false], "the two ticked steps count; the quizzes of 0.1 are not on the list");
  same(JSON.stringify(store.exam(old.exams[0].id).strategy), JSON.stringify(old.exams[0].strategy), "the strategy is not touched");
  store.setSettings({ appearance: "dark" });
  const kept = JSON.parse(fs.readFileSync(path.join(carried, "aced.json"), "utf8")).exams[0];
  for (const key of ["done", "mastery", "attempts", "cards", "quizzes", "history", "usage", "materials"]) same(kept[key], old.exams[0][key], `"${key}" from 0.1 is still in the file`);

  // Text files in the encodings people really have.
  const text = "Lernziele: Größe, Fläche, Übung";
  same(files.decode(Buffer.from(text, "utf8")), text);
  same(files.decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text, "UTF-16 with a mark");
  same(files.decode(Buffer.from(text, "utf16le")), text, "UTF-16 without one");
  same(files.decode(Buffer.from(text, "latin1")), text, "Latin-1");
  files.init(dir);
  const long = files.addText(("A paragraph of text that is about a hundred characters long, so that a great many of them make pages.\n\n").repeat(400), "long");
  ok(long.pages > 8 && !long.cut, "a long text is kept as pages, whole");
  ok(files.addText("x".repeat(3000500), "huge").cut, "what is cut off is said");
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
  same(findLabel("A B C\n1 Nr Aufgabe Punkte\n2 Ü1 Ein Kapital von 5000 CHF\n3 Ü2 Welches Kapital", "Ü2"), 2, "a label with a letter, first in a row of a printed spreadsheet");
  same(findLabel("| A3 | Löse die Gleichung |", "A3"), 2, "or first in a table row read by an AI");
  same(findLabel("Das Format A4 ist üblich.", "A4"), 1, "but not in the middle of a sentence");
  same(findLabel("6. Finde die Nullstellen.\na) graphisch\nb) rechnerisch", "6 b"), 2, "a part of an exercise: the exercise, then its letter");
  same(findLabel("6. Finde die Nullstellen.\na) graphisch", "6 c"), 0, "a part the exercise does not have");
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
    if (mode === "402") return json(res, 402, { type: "error", error: { type: "billing_error", message: "Your credit balance is too low to access the API." } });
    if (mode === "529") return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    if (mode === "500") return json(res, 500, { type: "error", error: { type: "api_error", message: "Internal server error" } });
    if (mode === "400") return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages: something is not right" } });
    if (mode === "bad-then-good" && !body.messages[0].content.at(-1).text.includes("previous answer")) return anthropicStream(res, "The answer is five.");
    anthropicStream(res, '{"answer": 5}');
  });
  process.env.ACED_ANTHROPIC_BASE_URL = anthropic.url;
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
  // A picture of a page goes first, as an image block; Claude can see.
  await ai.ask(request("What is on this page?", { images: [{ mediaType: "image/jpeg", data: "QUJD" }] }));
  same(seen.at(-1).body.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }, "a picture goes to Anthropic as an image block, before the text");
  same(await ai.canSee(), true, "a Claude model can see pictures");
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
  // Errors of the API become codes the interface has a sentence for, never its JSON.
  mode = "402";
  await failsWith(ai.ask(request("No credit case")), "noCredit");
  mode = "529";
  await failsWith(ai.ask(request("Overloaded case")), "overloaded");
  mode = "500";
  await failsWith(ai.ask(request("Server error case")), "serverError");
  mode = "400";
  const other = await ai.ask(request("Other error case")).catch((e) => e);
  same([other.code, other.detail], ["provider", "messages: something is not right"], "what the API says, in words, without status or JSON");
  mode = "good";
  // An answer that fits the schema but cannot be used is not kept: the next try asks again.
  const sentSoFar = seen.length;
  const six = { usable: (v) => (v.answer === 6 ? "" : "not six") };
  await failsWith(ai.ask(request("Usable case", six)), "badOutput");
  await failsWith(ai.ask(request("Usable case", six)), "badOutput");
  same(seen.length, sentSoFar + 4, "an unusable answer is asked for again, this time and the next");
  await ai.ask(request("What is two plus three?"), { fresh: true });
  same(seen.length, sentSoFar + 5, "a fresh run asks although the answer is on disk");
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
  process.env.ACED_OPENROUTER_BASE_URL = openrouter.url;
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
  await ai.ask(request("OpenRouter picture case", { images: [{ mediaType: "image/png", data: "QUJD" }] }));
  same(calls.at(-1).body.messages[1].content[0], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }, "a picture goes to OpenRouter as an image part, before the text");
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
  let seesPictures = true;
  const local = await serve((req, body, res) => {
    plain.push(body);
    if (body.response_format) return json(res, 400, { error: { message: "response_format is not supported" } });
    // The small picture with two numbers on it: a server whose model sees names them.
    if (JSON.stringify(body).includes("Which two numbers")) {
      if (!seesPictures) return json(res, 400, { error: { message: "this model does not support image input" } });
      return json(res, 200, { choices: [{ finish_reason: "stop", message: { content: '{"text": "12 and 34"}' } }] });
    }
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
  await ai.ask(request("Local picture case", { images: [{ mediaType: "image/jpeg", data: "QUJD" }] }));
  same(plain.at(-1).messages[1].content[0], { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }, "the picture stays in the plainest request too");
  ok(plain.at(-1).messages[1].content[1].text.includes('"additionalProperties":false'), "with the schema in words after it");
  const sample = async () => Buffer.from("not really a picture");
  same(await ai.canSee({ samplePicture: sample }), true, "another server is shown a picture with two numbers once: it names them, so it sees");
  seesPictures = false;
  store.setSettings({ ai: { provider: "openai", model: "text-only-model" } });
  same(await ai.canSee({ samplePicture: sample }), false, "one whose model refuses pictures does not");
  // Unclear answers are not kept: a server that cannot be reached, or refuses the key, says nothing about seeing.
  const unreachable = await serve(() => {});
  unreachable.close();
  await new Promise((r) => setTimeout(r, 50));
  store.setSettings({ ai: { provider: "openai", model: "vision-model", baseURL: unreachable.url + "/v1/" } });
  ai.forgetSight();
  await failsWith(ai.canSee({ samplePicture: sample }), "offline");
  seesPictures = true;
  store.setSettings({ ai: { provider: "openai", model: "vision-model", baseURL: local.url + "/v1/" } });
  ai.forgetSight();
  same(await ai.canSee({ samplePicture: sample }), true, "after being offline, the next try asks again (nothing was kept)");
  const locked = await serve((req, body, res) => json(res, 401, { error: { message: "Incorrect API key provided" } }));
  store.setSettings({ ai: { provider: "openai", model: "vision-model", baseURL: locked.url + "/v1/" } });
  ai.forgetSight();
  await failsWith(ai.canSee({ samplePicture: sample }), "badKey");
  locked.close();
  store.setSettings({ ai: { provider: "openai", model: "vision-model", baseURL: local.url + "/v1/" } });
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
  // A PDF with a single line of real text is short, not "a PDF no text could be read from".
  const liner = new BrowserWindow({ show: false });
  await liner.loadURL("data:text/html," + encodeURIComponent("<p>Lernziel: Ich kann den pH-Wert berechnen.</p>"));
  const oneLine = path.join(dir, "one-line.pdf");
  fs.writeFileSync(oneLine, await liner.webContents.printToPDF({}));
  liner.destroy();
  const short = await files.add(oneLine);
  same([short.pages, short.scanned, short.chars > 20], [1, false, true], "one line of text is material");
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
  const settingsFile = fs.readFileSync(path.join(dir, "aced.json"), "utf8");
  ok(!/sk-ant|sk-or/.test(settingsFile), "no key in the settings file");
  ok(!JSON.stringify(await ai.status()).includes("sk-"), "the status sent to the window holds no key");
}

/** The engine against a server that plays the model: questions, marking, formula sheet, helper. */
async function engineChecks() {
  const store = require("../src/store");
  const files = require("../src/files");
  const secrets = require("../src/secrets");
  const engine = require("../src/engine");
  const P = require("../src/prompts");
  const dir = app.getPath("userData");
  const seen = [];
  const last = (body) => body.messages[0].content.at(-1).text;
  const answers = {
    "Task: the final exam": {
      questions: [
        { topic: 0, type: "number", prompt: "Interest?", value: 21920.7, values: [], tolerance: 0.005, unit: "CHF", choices: [], correct: -1, answer: "", solution: "s", points: 2, book: 1, page: 2 },
        { topic: 0, type: "numbers", prompt: "Solutions?", value: 0, values: [1, 3], tolerance: 0, unit: "", choices: [], correct: -1, answer: "$x_1=1$, $x_2=3$", solution: "s", points: 2, book: 1, page: 2 },
        { topic: 1, type: "choice", prompt: "Which?", value: 0, values: [], tolerance: 0, unit: "", choices: ["a", "b"], correct: 9, answer: "b", solution: "s", points: 1, book: 1, page: 3 },
        { topic: 1, type: "text", prompt: "The line through (0,1) with slope 2?", value: 0, values: [], tolerance: 0, unit: "", choices: [], correct: -1, answer: "$y=2x+1$", solution: "s", points: 7, book: 1, page: 99 },
        { topic: 1, type: "number", prompt: "Ten?", value: 10, values: [], tolerance: 1000, unit: "", choices: [], correct: -1, answer: "10", solution: "s", points: 1, book: 1, page: 3 },
      ],
      more: [
        { topic: 0, book: 1, page: 2, label: "5", minutes: 5 },
        { topic: 0, book: 1, page: 2, label: "99", minutes: 5 },
        { topic: 0, book: 1, page: 2, label: "1", minutes: 5 },
      ],
    },
    "Task: mark results": { results: [{ n: 0, points: 0, note: "Not the interest." }, { n: 1, points: 2, note: "" }, { n: 2, points: 3, note: "" }, { n: 3, points: 0, note: "The slope is wrong." }] },
    "Task: the formula sheet": { groups: [{ topic: 0, formulas: [{ name: "Square", latex: "$a^2$", note: "n", book: 1, page: 2 }, { name: "Cube", latex: "a^3", note: "", book: 1, page: 77 }] }, { topic: 1, formulas: [] }] },
    "Task: answer the student's question": { answer: "On the exercise page.", pages: [{ book: 1, page: 2, what: "exercises" }, { book: 1, page: 99, what: "nowhere" }, { book: 1, page: 4, what: "from the contents" }] },
  };
  const server = await serve((req, body, res) => {
    seen.push(body);
    const task = Object.keys(answers).find((k) => last(body).includes(k));
    anthropicStream(res, JSON.stringify(answers[task] || {}));
  });
  process.env.ACED_ANTHROPIC_BASE_URL = server.url;
  store.setSettings({ ai: { provider: "anthropic", model: "claude-opus-5-5" } });
  await secrets.set("anthropic", "sk-ant-test");

  const book = files.addText("a book for the engine checks", "Book");
  const pages = ["Contents", "Compound interest and quadratic equations.\n1. First exercise\n2. Second exercise\n5. Fifth exercise", "Lines and slopes: theory of the straight line.", "Zebras live in herds. An unrelated chapter about zebras."];
  fs.writeFileSync(path.join(dir, "texts", book.hash + ".json"), JSON.stringify({ pages, outline: [1, 2, 3, 4, 5, 6].map((n) => ({ title: "Chapter " + n, page: Math.min(n, 4), depth: 0 })) }));
  const exam = store.createExam({ name: "Engine", date: "2099-01-01", time: { mode: "perDay", minutes: 60 } });
  store.addMaterial(exam.id, { ...book, id: "m1", pages: pages.length, chars: 400 }, "book");
  store.setStrategy(exam.id, {
    objectives: ["o1", "o2"],
    shown: [{ material: "m1", pages: [2, 3] }],
    topics: [
      { id: "t1", title: "Compound interest", share: 0.5, order: 2, objectives: [0], steps: [{ id: "t1/r0", kind: "read", material: "m1", from: 2, to: 2, chapter: "1", minutes: 5 }, { id: "t1/s0", kind: "solve", material: "m1", page: 2, labels: ["1"], minutes: 5 }] },
      { id: "t2", title: "Lines", share: 0.5, order: 3, objectives: [1], steps: [{ id: "t2/r0", kind: "read", material: "m1", from: 3, to: 3, chapter: "2", minutes: 5 }, { id: "t2/q", kind: "quiz", questions: 3, minutes: 10 }] },
    ],
  });
  const stored = () => store.exam(exam.id);

  // ---- questions: every one has a result that can be typed, and the points are for the result
  ok(/points are for the result only/i.test(P.questionsTask({ topics: [{ title: "T", objectives: [] }], count: 3, final: true, planned: "" })), "the question writer is told that only the result earns points");
  const set = await engine.writeQuestions(stored(), { key: "final#0", final: true, topicIds: ["t1", "t2"], count: 5 });
  ok(last(seen.at(-1)).includes("book 1 page 2: 1"), "the exercises already in the plan are named, so other ones are suggested");
  same(set.questions.map((q) => q.type), ["number", "numbers", "text", "text", "number"], "a choice without a valid right option is asked as text");
  same([set.questions[0].answer, set.questions[0].tolerance, set.questions[4].tolerance, set.questions[3].points], ["21920.7 CHF", 0.005, 0.5, 3], "missing answers are filled in, wild tolerances and points are cut back");
  same([set.questions[3].page, set.questions[0].page], [3, 2], "a page the model was not shown is replaced by the topic's own");
  same(set.spare, { t1: [{ material: "m1", page: 2, labels: ["5"], minutes: 5 }] }, "spare exercises: only ones that stand on the page and are not in the plan");

  // ---- marking: numbers are decided here, in any notation; only other results go to the model
  const [q0, q1, q2, q3, q4] = set.questions;
  let before = seen.length;
  let marks = await engine.mark(set.questions, { [q0.id]: "CHF 21'920.70", [q1.id]: "3 und 1", [q2.id]: "b", [q3.id]: "y=2x+1", [q4.id]: "" });
  same(seen.length, before, "nothing is sent when every result can be decided here");
  same(set.questions.map((q) => marks[q.id].points), [2, 2, 1, 3, 0], "a right final number earns all its points, with no working shown");
  marks = await engine.mark(set.questions, { [q0.id]: "21000", [q1.id]: "one and three", [q2.id]: "the second one", [q3.id]: "y - 1 = 2x", [q4.id]: "10" });
  same(seen.length, before + 1, "what this Mac cannot call right goes to the model in one request: other results, and numbers it could not match");
  ok(/Only the result counts/.test(last(seen.at(-1))) && /never take a point off because steps are missing/i.test(last(seen.at(-1))), "which is told to mark the result only");
  ok(last(seen.at(-1)).includes("21000") && last(seen.at(-1)).includes("one and three") && !last(seen.at(-1)).includes("<typed>\n10\n"), "a number that looks wrong gets a second look; one that is right is not sent");
  same(set.questions.map((q) => [marks[q.id].points, marks[q.id].note, marks[q.id].by]), [[0, "Not the interest.", "model"], [2, "", "model"], [1, "", "model"], [0, "The slope is wrong.", "model"], [1, "", "here"]], "a wrong mark is never final from the comparison alone");

  // ---- formula sheet: every formula with the page it stands on, where that page was read
  const formulas = await engine.writeFormulas(stored());
  same(formulas, [{ topicId: "t1", formulas: [{ name: "Square", latex: "a^2", note: "n", material: "m1", page: 2 }, { name: "Cube", latex: "a^3", note: "", material: null, page: null }] }]);

  // ---- helper: the pages are found here, in the whole book, and only those are sent
  const reply = await engine.help(stored(), "Where is the chapter about zebras?", { earlier: [{ question: "Hello?", answer: "Hi." }], now: "solve step" });
  const sent = seen.at(-1).messages[0].content;
  ok(sent[0].cache_control && sent[0].text.includes("Chapter 3") && sent[0].text.includes("<plan>") && !sent[0].text.includes("Zebras live"), "contents and plan are the part that stays the same, marked for the provider's cache");
  ok(sent.at(-1).text.includes("[[book 1, page 4]]") && sent.at(-1).text.includes("Zebras live") && !sent.at(-1).text.includes("Compound interest and quadratic"), "the page found for the question is sent, the rest of the book is not");
  ok(sent.at(-1).text.includes("Student: Hello?") && sent.at(-1).text.includes("solve step"), "with the conversation so far and where the student is");
  same(reply.pages.map((x) => x.page), [2, 4], "a page that does not exist is not linked; one named by the plan or the contents is");
  server.close();
}

app.whenReady().then(async () => {
  try {
    for (const part of [plannerChecks, answerChecks, moveChecks, searchChecks, errorChecks, storeChecks, referenceChecks, providerChecks, engineChecks]) {
      if (process.env.ACED_TEST_TRACE) console.log("…", part.name);
      await part();
    }
    console.log(`ok: ${checks} checks`);
  } catch (err) {
    console.log("FAIL", err.message, "\n", String(err.stack).split("\n").slice(1, 4).join("\n"));
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
});

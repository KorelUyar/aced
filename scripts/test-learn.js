// Checks for learning in the app (0.6): the summary per topic, the plan by pace, the book's
// exercises as tasks (typed results in every usual notation, safe expressions), the check of their
// results before they are shown, the percent after an upgrade, and both in a shared file.
//
//   node_modules/.bin/electron scripts/test-learn.js
const { app } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet } = require("./hidden");

quiet();
app.on("window-all-closed", () => {});

let passed = 0;
let failed = 0;
const ok = (value, message) => {
  if (value) passed++;
  else {
    failed++;
    console.log("FAIL", message);
  }
};
const same = (a, b, message) => {
  try {
    assert.deepStrictEqual(a, b);
    passed++;
  } catch {
    failed++;
    console.log("FAIL", message, "\n  got     ", JSON.stringify(a), "\n  expected", JSON.stringify(b));
  }
};

app.whenReady().then(async () => {
  const started = Date.now();
  try {
    const expr = require("../src/expr");
    const tasks = require("../src/tasks");
    const planner = require("../src/planner");
    const engine = require("../src/engine");
    const share = require("../src/share");

    // ---- the book's printed answer: whole values for the right quantity, whole choices (F1)
    const B = (o) => engine.bookAgrees({ tolerance: 0, ...o });
    ok(!B({ type: "choice", choices: ["wahr", "unwahr"], correct: 0, bookAnswer: "unwahr" }) && B({ type: "choice", choices: ["wahr", "unwahr"], correct: 0, bookAnswer: "wahr" }), "wahr is not confirmed by unwahr");
    ok(!B({ type: "choice", choices: ["gerade", "ungerade"], correct: 0, bookAnswer: "ungerade" }) && !B({ type: "choice", choices: ["2", "12"], correct: 0, bookAnswer: "12" }), "gerade is not ungerade, 2 is not 12");
    ok(B({ type: "choice", choices: ["2", "12"], correct: 1, bookAnswer: "b)" }), "a choice's letter confirms it");
    ok(!B({ type: "number", value: 7, bookAnswer: "x = 4; y = 7" }) && !B({ type: "number", value: 4, bookAnswer: "x = 4; y = 7" }), "an answer with two values confirms neither");
    ok(!B({ type: "number", value: 25, bookAnswer: "A = 5 cm², U = 25 cm" }), "an area of 25 is not confirmed by U = 25");
    ok(B({ type: "number", value: 5, bookAnswer: "9. A = 5 cm²" }) && B({ type: "numbers", values: [0.5, -2], bookAnswer: "x = 1/2 or x = −2" }), "a clear answer confirms");
    const answerPage = { data: { pages: ["Answers\n1. (2, −3)   2. (−3, −5)"] } };
    ok(engine.printedOn(answerPage, 1, "(2, -3)", "1") && !engine.printedOn(answerPage, 1, "(2, 3)", "1") && !engine.printedOn(answerPage, 2, "(2, -3)", "1"), "the book's answer counts only where it is printed, on the page named");
    ok(!engine.printedOn(answerPage, 1, "(-3, -5)", "1") && engine.printedOn(answerPage, 1, "(-3, -5)", "2"), "and only after the exercise's own label");
    const key = { data: { pages: ["Lösungen zu Kapitel 4\n3. a) x = 14   b) y = 2,5\n4. x = 4   5. wahr"] } };
    ok(!engine.printedOn(key, 1, "4", "3a") && engine.printedOn(key, 1, "x = 14", "3a"), "4 is not printed where the page says 14");
    ok(!engine.printedOn(key, 1, "y = 5", "3b") && engine.printedOn(key, 1, "y = 2.5", "3b"), "5 is not 2,5; a decimal comma is a decimal point");
    ok(!engine.printedOn(key, 1, "Kapitel", "3a") && engine.printedOn(key, 1, "wahr", "5"), "a word in the heading is no exercise's answer");
    ok(!engine.printedOn(key, 1, "4"), "without the exercise's label, nothing is confirmed");
    // "Check the solutions" on a task from a file: its book answer counts only from this Mac's own copy.
    const fromFile = { id: "k1", material: "m1", label: "4", type: "number", value: 4, tolerance: 0, answer: "x = 4", bookAnswer: "x = 4", answerPage: 1 };
    ok(!engine.bookConfirms(null, fromFile), "with no book on this Mac, a file's book answer confirms nothing");
    const realReadText = require("../src/files").readText;
    require("../src/files").readText = () => key.data;
    try {
      const withBook = { materials: [{ id: "m1", hash: "h", type: "pdf", pages: 1 }] };
      ok(engine.bookConfirms(withBook, fromFile), "with the same book here, its printed answer confirms");
      ok(!engine.bookConfirms(withBook, { ...fromFile, value: 14, answer: "x = 14", bookAnswer: "x = 14" }), "an answer the file claims, which this page does not print for the exercise, confirms nothing");
      ok(!engine.bookConfirms({ materials: [{ id: "m1", hash: "h", type: "pdf", pages: 1, edition: "other" }] }, fromFile), "another edition confirms nothing");
    } finally {
      require("../src/files").readText = realReadText;
    }

    // ---- expressions: points small and large; too few is "cannot tell", never "different" (F2)
    for (const e of ["sqrt(x-5)", "ln(x-4)", "a+b+c+d+f", "x^20", "exp(10x)"]) same(expr.compare(e, e), true, `${e} is the same as itself`);
    ok(expr.compare("sqrt(x-6)", "sqrt(x-5)") === false, "sqrt(x-6) is not sqrt(x-5)");
    ok(expr.compare("sqrt(x-5000)", "sqrt(x-5000)") === null && tasks.isRight({ type: "expression", expression: "sqrt(x-5000)" }, "sqrt(x-5000)") === null, "too few points: cannot tell, never wrong");

    // ---- notations a teacher accepts, and answers that hedge (F3)
    for (const [typed, expected] of [["sin²x", "sin(x)^2"], ["sin^2(x)", "sin(x)^2"], ["|x|", "abs(x)"], ["½x", "x/2"], ["X+1", "x+1"], ["1/2x", "x/2"]]) ok(tasks.isRight({ type: "expression", expression: expected }, typed) === true, `${typed} is ${expected}`);
    for (const typed of ["P(2/-3)", "(2/\u22123)"]) ok(tasks.isRight({ type: "numbers", values: [2, -3], ordered: true }, typed) === true, `a point written ${typed}`);
    for (const typed of ["4 oder 5", "±4", "3 bis 5", "1, 2, 3, 4, 5"]) same(tasks.check({ type: "number", value: 4 }, typed), { verdict: "ask", one: true }, `${typed}: one result, please`);
    same(tasks.check({ type: "expression", expression: "1/(2x)" }, "1/2x"), { verdict: "ask", suggest: "1/(2x)" }, "1/2x for 1/(2x): a question back, not wrong");
    same(tasks.check({ type: "expression", expression: "e^(2x)" }, "e^2x"), { verdict: "ask", suggest: "e^(2x)" }, "e^2x for e^(2x): a question back");
    same(tasks.check({ type: "number", value: 6 }, "2 x 3"), { verdict: "ask", suggest: "2*3" }, "2 x 3 for 6: a question back");

    // ---- typed results: every usual way to write a point, a decimal comma, the real minus sign
    const point = { type: "numbers", values: [2, -3], ordered: true, tolerance: 0 };
    for (const typed of ["2; -3", "2|-3", "(2|-3)", "S(2|-3)", "S(2 | -3)", "2; −3", "(2 | −3)", "S(2|−3)", "2 ; - 3"]) ok(tasks.isRight(point, typed), `a point written as ${JSON.stringify(typed)}`);
    for (const typed of ["(-3|2)", "2; 3", "-2; -3", "2", ""]) ok(!tasks.isRight(point, typed), `not the point: ${JSON.stringify(typed)}`);
    const decimal = { type: "numbers", values: [2.5, -3], ordered: true, tolerance: 0 };
    for (const typed of ["2,5; -3", "2,5|-3", "(2,5 | −3)", "S(2,5|-3)", "2.5; -3"]) ok(tasks.isRight(decimal, typed), `a decimal comma in a point: ${JSON.stringify(typed)}`);
    ok(tasks.isRight({ type: "number", value: 2.5, tolerance: 0 }, "2,5"), "2,5 is two and a half");
    ok(!tasks.isRight({ type: "number", value: 25, tolerance: 0 }, "2,5"), "2,5 is not 25");
    ok(tasks.isRight({ type: "numbers", values: [2, 5], ordered: true }, "2,5"), "a comma splits a point only when it cannot be one number");
    ok(tasks.isRight({ type: "numbers", values: [3, 4] }, "x1 = 4; x2 = 3"), "solutions in any order");
    ok(tasks.isRight({ type: "number", value: -1 }, "y = −1"), "the minus sign U+2212");
    ok(tasks.isRight({ type: "number", value: 0.75 }, "3/4"), "a fraction is worked out");
    ok(tasks.isRight({ type: "choice", correct: 1 }, 1) && !tasks.isRight({ type: "choice", correct: 1 }, 0), "a choice is its position");

    // ---- expressions: the same function in another form; never run as code
    ok(expr.same("(x-2)^2-3", "x^2-4x+1"), "(x-2)^2-3 is x^2-4x+1");
    ok(expr.same("f(x) = 2(x − 2)² − 5", "2x^2-8x+3"), "f(x) = 2(x − 2)² − 5 is 2x^2-8x+3");
    ok(!expr.same("x^2+4x+1", "x^2-4x+1"), "a sign makes another function");
    ok(expr.same("\\frac{1}{2}x", "x/2") && expr.same("\\sqrt{x}", "sqrt(x)"), "LaTeX fractions and roots");
    ok(Number.isNaN(expr.value("process.exit()")) && Number.isNaN(expr.value("require('fs')")) && !expr.read("a;b"), "anything but maths is refused");
    ok(!expr.same("constructor", "x") && Number.isNaN(expr.value("constructor")), "names of object properties are only letters");
    ok(Number.isNaN(expr.value("(".repeat(200) + "1" + ")".repeat(200))), "deep nesting is refused");

    // ---- the result check before a task is shown
    const t1 = { type: "numbers", values: [2, -3], ordered: true, tolerance: 0 };
    ok(engine.agree(t1, { values: [2, -3] }) && !engine.agree(t1, { values: [-3, 2] }), "a second solving agrees only in the right order");
    ok(engine.agree({ type: "numbers", values: [3, 4] }, { values: [4, 3] }), "solutions agree in any order");
    ok(engine.agree({ type: "expression", expression: "(x-2)^2-3" }, { expression: "x^2-4x+1" }), "expressions agree when they are the same function");
    ok(engine.bookAgrees({ ...t1, bookAnswer: "(2, −3)" }) && !engine.bookAgrees({ ...t1, bookAnswer: "(2, 3)" }), "the book's printed answer is read");

    // ---- the plan by pace
    const topic = (id, extra = {}) => ({
      id,
      title: id,
      share: 0.5,
      objectives: [],
      order: 1,
      steps: [
        { id: `${id}/r0`, kind: "read", material: "m1", from: 10, to: 19, chapter: "", minutes: 30 },
        { id: `${id}/s0`, kind: "solve", material: "m1", page: 20, labels: ["1", "2"], minutes: 20 },
        { id: `${id}/q`, kind: "quiz", questions: 4, minutes: 10 },
      ],
      ...extra,
    });
    const summary = { core: ["a"], example: null, todo: ["b"], pages: [{ material: "m1", from: 12, to: 13, what: "key" }] };
    const task = (id, step) => ({ id, step, material: "m1", page: 20, label: "1", prompt: "p", type: "number", value: 1, checked: "twice" });
    const learnt = topic("t1", { summary, tasks: [task("t1/s0/1", "t1/s0"), task("t1/s0/2", "t1/s0")] });
    const kinds = (pace, done = {}, results = {}, t = learnt) => planner.workOf(t, pace, done, results).map((s) => s.kind + (s.key ? "*" : ""));
    same(kinds("efficient"), ["summary", "solve"], "efficient: the summary and the tasks, no reading, no check while nothing went wrong");
    same(kinds("efficient", {}, { "t1/s0/1": { wrong: 1 } }), ["summary", "solve", "quiz"], "efficient: the check comes when a task went wrong");
    same(planner.workOf(learnt, "efficient", {}, { "t1/s0/1": { wrong: 1 } })[2].questions, 2, "the check has two questions");
    same(kinds("efficient", { "t1/s0": { date: "2026-11-20" } }), ["summary", "solve", "quiz"], "efficient: the check comes when exercises were ticked without the app");
    same(kinds("efficient", { "t1/s0": { date: "2026-11-20" } }, { "t1/s0/1": { right: true }, "t1/s0/2": { right: true } }), ["summary", "solve"], "no check when every task was right in the app");
    same(kinds("efficient", { "t1/r0": { date: "2026-11-20" } }), ["summary", "read", "solve"], "reading that was ticked stays: done work is never taken away");
    same(kinds("sprint"), ["summary", "solve"], "sprint: the summary and the tasks");
    same(kinds("thorough"), ["summary", "read*", "solve", "quiz"], "thorough: only the pages the summary names, then the check");
    same(planner.workOf(learnt, "thorough").find((s) => s.key).minutes, 8, "two key pages take eight minutes");
    same(kinds("efficient", {}, {}, topic("t2")), ["read", "solve"], "a topic without a summary keeps its steps (0.5)");

    // ---- an exam from before 0.6: its percent does not fall on the first open
    const exam = (topics, extra = {}) => ({ id: "e", name: "E", date: planner.addDays(planner.todayIso(), 6), time: { mode: "perDay", minutes: 60 }, scale: "ch", target: 5, pace: "efficient", materials: [], strategy: { topics, objectives: [] }, done: {}, again: [], ...extra });
    const before = exam([topic("t1"), topic("t2")], { done: { "t1/r0": { date: "2026-11-20", minutes: 30 } } });
    const was = planner.buildPlan(before, planner.todayIso()).percent;
    const upgraded = exam([learnt, topic("t2", { summary })], { done: { "t1/r0": { date: "2026-11-20", minutes: 30 }, "t1/sum": { date: "2026-11-22", minutes: 0, carried: true } }, floor: was });
    ok(planner.buildPlan(upgraded, planner.todayIso()).percent >= was, `the percent stays at least ${was}% after the upgrade`);
    ok(planner.buildPlan({ ...upgraded, floor: 0 }, planner.todayIso()).percent > 0, "and the begun topic counts its summary as read");
    const partly = exam([learnt], { taskResults: { "t1/s0/1": { right: true } } });
    ok(planner.buildPlan(partly, planner.todayIso()).percent > planner.buildPlan(exam([learnt]), planner.todayIso()).percent, "a task right in the app counts toward the percent");

    // ---- answering a task: right, wrong (it comes back), unconfirmed (never wrong)
    const e = exam([learnt]);
    let r = tasks.answer(e, "t1/s0/1", "2", "2026-11-22");
    same([r.right, e.taskResults["t1/s0/1"].wrong, e.again.length], [false, 1, 1], "a wrong result counts, and the task comes back later");
    r = tasks.answer(e, "t1/s0/1", "1", "2026-11-22");
    r = tasks.answer(e, "t1/s0/2", "1", "2026-11-22");
    ok(r.right && e.done["t1/s0"], "all tasks of a step right: the step is ticked off");
    const unsure = exam([{ ...learnt, tasks: [{ ...task("t1/s0/1", "t1/s0"), checked: "none" }] }]);
    r = tasks.answer(unsure, "t1/s0/1", "7", "2026-11-22");
    same([r.right, r.sure, unsure.taskResults["t1/s0/1"].wrong || 0, unsure.again.length], [false, false, 0, 0], "an unconfirmed solution never marks a result wrong");
    same(tasks.answer(e, "constructor", "1", "2026-11-22"), null, "an id that is no task is nothing");
    const own = exam([learnt]);
    tasks.answer(own, "t1/s0/1", "2", "2026-11-22");
    ok(tasks.overrule(own, "t1/s0/1", "2026-11-22") && own.taskResults["t1/s0/1"].right && !own.again.length, "My result was right: it counts, and it does not come back");

    // ---- summary and tasks travel in the shared file, checked on the way in
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-learn-"));
    const strategy = { createdOn: "2026-11-20", approach: "", objectives: ["o"], topics: [{ ...learnt, steps: learnt.steps }] };
    const sent = { name: "Algebra", date: "2026-12-01", time: { mode: "perDay", minutes: 30 }, scale: "ch", target: 5, pace: "efficient", materials: [{ id: "m1", kind: "book", type: "pdf", title: "Book", pages: 40, hash: "a".repeat(64) }], strategy, formulas: [], sets: {} };
    const bytes = share.pack(sent, { chosen: [], appVersion: "0.6.0", pdfOf: () => null, textOf: () => null, shareId: "11111111-2222-3333-4444-555555555555" });
    const file = path.join(root, "a.aced");
    fs.writeFileSync(file, bytes);
    const got = share.unpack(file, root);
    same(got.strategy.topics[0].summary.core, ["a"], "the summary goes along");
    same(got.strategy.topics[0].tasks.map((x) => x.id), ["t1/s0/1", "t1/s0/2"], "the tasks go along");
    // A hostile file: odd ids, a task for a step that is not there, oversized and wrong fields.
    const zip = require("../src/formats/zip");
    const archive = zip.open(file);
    const plain = JSON.parse(archive.read("aced.json").toString("utf8"));
    archive.close();
    plain.strategy.topics[0].tasks.push(
      { ...task("constructor", "t1/s0"), prompt: "odd" },
      { ...task("t1/x/1", "t1/nowhere") },
      { ...task("t1/s0/9", "t1/s0"), type: "script" },
      { ...task("t1/s0/8", "t1/s0"), prompt: "x".repeat(5000), figure: { top: -4, bottom: 9 }, solution: Array(40).fill("s"), minutes: 9999 },
    );
    plain.strategy.topics[0].summary.core = Array(30).fill("<img src=x onerror=alert(1)>");
    fs.writeFileSync(file, share.zipOf([["aced.json", Buffer.from(JSON.stringify(plain))]]));
    const hostile = share.unpack(file, root).strategy.topics[0];
    same(hostile.tasks.map((x) => x.id), ["t1/s0/1", "t1/s0/2", "t1/s0/8"], "odd ids, steps that are not there and unknown types are refused");
    const big = hostile.tasks[2];
    same([big.prompt.length, big.figure, big.solution.length, big.minutes], [2000, { top: 0, bottom: 1 }, 12, 5], "everything else is cut to size");
    same(hostile.summary.core.length, 8, "at most eight points in a summary (shown as text, never as HTML)");
    // ---- a confirmed flag never comes from a file; the book's answer is checked on this Mac
    const flagged = plain;
    flagged.strategy.topics[0].tasks = [{ ...task("t1/s0/1", "t1/s0"), checked: "book", bookAnswer: "1", answerPage: 3 }];
    fs.writeFileSync(file, share.zipOf([["aced.json", Buffer.from(JSON.stringify(flagged))]]));
    same(share.unpack(file, root).strategy.topics[0].tasks[0].checked, "none", "a file cannot say its solutions are confirmed");
    const pages = ["", "", "Answers\n1. 1   2. 7"];
    const local = { strategy: { topics: [{ id: "t1", steps: [], tasks: [{ ...task("t1/s0/1", "t1/s0"), checked: "none", bookAnswer: "1", answerPage: 3 }] }] }, materials: [{ id: "m1", hash: "h", type: "pdf", pages: 3 }] };
    local.strategy.topics[0].tasks[0].label = "1";
    const filesMod = require("../src/files");
    const realRead = filesMod.readText;
    filesMod.readText = () => ({ pages });
    try {
      engine.recheckLocal(local);
      same(local.strategy.topics[0].tasks[0].checked, "book", "with the same book on this Mac, its printed answer confirms the solution");
      local.strategy.topics[0].tasks[0] = { ...local.strategy.topics[0].tasks[0], checked: "none", bookAnswer: "4" };
      engine.recheckLocal(local);
      same(local.strategy.topics[0].tasks[0].checked, "none", "an answer that is not printed there confirms nothing");
      local.materials[0].missing = true;
      local.strategy.topics[0].tasks[0] = { ...local.strategy.topics[0].tasks[0], bookAnswer: "1" };
      engine.recheckLocal(local);
      same(local.strategy.topics[0].tasks[0].checked, "none", "without the book on this Mac, nothing is confirmed");
    } finally {
      filesMod.readText = realRead;
    }

    // ---- a book that stays home goes along only when the plan uses it
    const unused = { ...sent, materials: [...sent.materials, { id: "m9", kind: "book", type: "pdf", title: "Tagebuch Privat", pages: 3, hash: "b".repeat(64) }] };
    const sentDoc = JSON.parse(require("../src/formats/zip").open((fs.writeFileSync(file, share.pack(unused, { chosen: [], appVersion: "0.6.0", pdfOf: () => null, textOf: () => null })), file)).read("aced.json").toString("utf8"));
    ok(sentDoc.materials.some((m) => m.id === "m1") && !sentDoc.materials.some((m) => m.id === "m9") && !JSON.stringify(sentDoc).includes("Tagebuch"), "an unticked file the plan does not use sends nothing, not even its name");
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    failed++;
    console.log("FAIL", err.stack);
  }
  console.log(`${failed ? "FAIL" : "ok"} learning: ${passed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)} s)`);
  app.exit(failed ? 1 : 0);
});

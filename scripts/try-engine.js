// Developer check of the engine without the window, against a real provider:
//
//   node_modules/.bin/electron scripts/try-engine.js <dataDir> <book.pdf> <objectives.txt> [provider] [model]
//
// Adds the material to a fresh exam in <dataDir>, prints the estimate, works out the strategy,
// writes one quiz and corrects one written answer. Everything is cached in <dataDir>.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const [dataDir, book, objectives, provider = "claudeCode", model] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("try-engine.js"));
app.dock?.hide();
app.setPath("userData", path.resolve(dataDir));

app.whenReady().then(async () => {
  const store = require("../src/store");
  const files = require("../src/files");
  const secrets = require("../src/secrets");
  const planner = require("../src/planner");
  const engine = require("../src/engine");
  const ai = require("../src/ai");
  const dir = app.getPath("userData");
  files.init(dir);
  secrets.init(dir, { persist: false });
  if (process.env.SPURT_TEST_KEY) secrets.set(provider, process.env.SPURT_TEST_KEY);
  store.init({ dir, sample: false });
  ai.init(() => store.settings());
  store.setSettings({ ai: { provider, ...(model ? { model } : {}), ...(process.env.SPURT_TEST_BASE ? { baseURL: process.env.SPURT_TEST_BASE } : {}) } });
  const usage = { input: 0, cached: 0, output: 0, calls: 0 };
  const onUsage = (u) => {
    usage.input += u.input;
    usage.cached += u.cached;
    usage.output += u.output;
    usage.calls++;
  };
  try {
    const today = planner.todayIso();
    let exam = store.createExam({ name: "Quadratic functions", date: planner.addDays(today, 6), time: { mode: "perDay", minutes: 45 }, scale: "ch", target: 5, pace: "sprint" });
    const started = Date.now();
    store.addMaterial(exam.id, await files.add(path.resolve(book)), "book");
    store.addMaterial(exam.id, files.addText(fs.readFileSync(objectives, "utf8"), "Learning objectives"), "objectives");
    exam = store.exam(exam.id);
    console.log("material", JSON.stringify(exam.materials.map((m) => ({ kind: m.kind, pages: m.pages, chars: m.chars, offset: m.offset, scanned: m.scanned }))), "ms", Date.now() - started);
    console.log("estimate", JSON.stringify(engine.estimate(exam)));
    console.log("status", JSON.stringify(await ai.status()));
    const strategy = await engine.analyze(exam, { today, daysLeft: 6, minutesTotal: 270, minutesPerDay: 45 }, { onProgress: (p) => console.log("stage", p.stage), onUsage });
    store.setStrategy(exam.id, strategy);
    exam = store.exam(exam.id);
    fs.writeFileSync(path.join(dir, "strategy.json"), JSON.stringify(strategy, null, 2));
    console.log("checks", JSON.stringify(strategy.checks), "pagesRead", strategy.pagesRead, "seconds", Math.round((Date.now() - started) / 1000));
    for (const t of strategy.topics) {
      console.log(`- ${t.title} (share ${t.share})`);
      for (const s of t.steps) console.log("    ", s.kind, s.kind === "read" ? `${s.from}-${s.to} ${s.chapter}` : s.kind === "solve" ? `p${s.page} [${s.labels.join(", ")}]${s.unconfirmed.length ? " UNCONFIRMED " + s.unconfirmed.join(",") : ""}` : `${s.questions} questions`, s.minutes + " min");
    }
    const plan = planner.buildPlan(exam, today);
    console.log("plan", plan.days.map((d) => `${d.date.slice(5)}: ${d.tasks.map((t) => t.kind[0] + t.minutes).join(" ")}`).join(" | "), "dropped", plan.dropped.map((d) => d.title + ":" + d.reason).join("; "));
    const topic = strategy.topics[0];
    const quiz = await engine.writeQuiz(exam, { key: topic.id, topicIds: [topic.id], count: 4 }, { onUsage });
    fs.writeFileSync(path.join(dir, "quiz.json"), JSON.stringify(quiz, null, 2));
    for (const q of quiz.questions) console.log("Q", q.type, q.points + "p", "page", q.page, "|", q.prompt.slice(0, 140).replace(/\n/g, " "));
    const written = quiz.questions.find((q) => q.type !== "choice");
    if (written) {
      const result = await engine.grade(written, "I am not sure, but I think the vertex is at x = -b/(2a), then you plug that in.", { onUsage });
      console.log("grade", JSON.stringify(result).slice(0, 500));
    }
    console.log("usage", JSON.stringify(usage), "total seconds", Math.round((Date.now() - started) / 1000));
  } catch (err) {
    console.log("FAIL", err.code || "", err.detail || err.message);
    process.exitCode = 1;
  }
  app.quit();
});

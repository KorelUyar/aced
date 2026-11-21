// The whole path for real, in a hidden window, with a real book and a real model:
//
//   node_modules/.bin/electron scripts/e2e.js <book.pdf> <objectives.txt> <outDir> [exam name] [en|de]
//
// By default it uses "Claude Code on this Mac" (the person's own login, no key). It picks the
// provider in Settings and tests it, creates an exam, adds the PDF and the objectives, works
// out the strategy, opens the book at cited pages, takes a quiz and has answers corrected.
// Pictures and the saved data land in <outDir>. This costs real tokens: run it deliberately.
//
//   E2E_PROVIDER=openai E2E_BASE=http://127.0.0.1:11434/v1 E2E_MODEL=<name>   another server instead
//   E2E_RESUME=1               keep the data of the last run (answers already given are on disk)
//   E2E_PART=mock-review       with E2E_RESUME: a review of due questions, then a mock exam
//   E2E_BOOKS=0                do not open the book windows
const { app, dialog } = require("electron");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");
const planner = require("../src/planner");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("e2e.js"));
const [book, objectives, outArg, examName = "Quadratic functions", language = "en"] = args;
const provider = process.env.E2E_PROVIDER || "claudeCode";
const part = process.env.E2E_PART || "all";
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const userData = path.join(out, "data");
const dataFile = path.join(userData, "spurt.json");
const resume = process.env.E2E_RESUME === "1" && fs.existsSync(dataFile);
if (!resume) fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
const saved = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));
const today = planner.todayIso();

if (resume && part === "mock-review") {
  // Stand-in for "a day later": every question answered so far is due again today, and
  // nothing counts as done today.
  const data = saved();
  const exam = data.exams[0];
  for (const card of Object.values(exam.cards)) card.due = today;
  for (const key of Object.keys(exam.done)) if (key.startsWith("review:") || key === "mock") delete exam.done[key];
  delete exam.quizzes.mock;
  fs.writeFileSync(dataFile, JSON.stringify(data));
}

app.setPath("userData", userData);
quiet();
// The file dialog cannot be clicked from a script: it answers with the book.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.resolve(book)] });
const mainFile = path.join(__dirname, "..", "main.js");
const windows = [];
app.on("browser-window-created", (_e, w) => windows.push(w));
const window = hideWindowsOf(mainFile);
require(mainFile);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

app.whenReady().then(async () => {
  const win = await window;
  const errors = [];
  win.webContents.on("console-message", (e) => e.level === "error" && errors.push(e.message));
  win.setContentSize(1120 * SCALE, 800 * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector, timeout) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, timeout);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(120);
  };
  const type = (selector, text, event = "input") =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.innerText`);
  const shot = async (name) => {
    await sleep(350);
    fs.writeFileSync(path.join(out, name + ".png"), await capture(win));
    log("shot", name);
  };
  const go = ".wizard-foot .btn.primary";

  /** Answers every question of the quiz on screen: every second one right, the others wrong. */
  async function takeQuiz(name) {
    await until(`!!document.querySelector('.q-prompt') || !!document.querySelector('.page.focus .problem')`, 420000);
    if (await js(`!!document.querySelector('.page.focus .problem')`)) throw new Error(`${name}: ` + (await text(".page.focus .problem")));
    const bank = Object.values(saved().exams[0].quizzes).flatMap((q) => q.questions);
    const tally = { questions: 0, choiceAsExpected: 0, choices: 0, written: [] };
    for (let n = 0; n < 20; n++) {
      const id = await js(`document.querySelector('[data-question]').dataset.question`);
      const q = bank.find((x) => x.id === id);
      assert.ok(q, "the question on screen is in the saved quiz: " + id);
      const right = n % 2 === 0;
      tally.questions++;
      if (q.type === "choice") {
        const pick = right ? q.correct : (q.correct + 1) % q.choices.length;
        await click(`.choice:nth-child(${pick + 1})`);
      } else {
        await type("textarea.answer", right ? q.answer : language === "de" ? "Das weiss ich nicht." : "I do not know this one.");
      }
      await click("#check");
      await until(`!!document.querySelector('.feedback') || !!document.querySelector('.toast')`, 240000);
      if (!(await js(`!!document.querySelector('.feedback')`))) throw new Error(`${name}: correcting failed: ` + (await text(".toast")));
      const verdict = (await text(".verdict")).replace(/\n+/g, " ");
      const isRight = await js(`document.querySelector('.feedback').classList.contains('right')`);
      if (q.type === "choice") {
        tally.choices++;
        if (isRight === right) tally.choiceAsExpected++;
      } else {
        tally.written.push(`${right ? "model answer" : "no answer"} -> ${verdict}`);
      }
      if (n === 0) await shot(name + "-first");
      if (q.type !== "choice" && tally.written.length === 1) await shot(name + "-written");
      const last = await js(`/Finish|beenden/.test(document.querySelector('#next').textContent)`);
      await click("#next");
      if (last) break;
    }
    await until(`!!document.querySelector('.result')`);
    const result = await text(".result .grade");
    log(name, "->", result, "|", `${tally.questions} questions, choices as expected ${tally.choiceAsExpected}/${tally.choices}`, "| written:", tally.written.join(" ; ") || "none");
    assert.equal(tally.choiceAsExpected, tally.choices, "multiple choice is corrected as answered");
    await click(".result .btn");
    await until(`!!document.querySelector('.standing')`);
    return result;
  }

  try {
    await until(`!!window.__nav`);
    win.webContents.setZoomFactor(SCALE);

    if (resume) {
      await click(".exam-card");
      await until(`!!document.querySelector('.standing')`);
    } else {
      // 1. Settings: the provider, and a real test request.
      await click(".bar-btn.square");
      if (language === "de") await js(`document.querySelector('.setting').querySelectorAll('button')[1].click()`);
      await click(`.ai .pace:nth-child(${["claudeCode", "anthropic", "openrouter", "openai"].indexOf(provider) + 1})`);
      if (provider === "openai") {
        await until(`!!document.querySelector('#baseURL')`);
        await type("#baseURL", process.env.E2E_BASE, "change");
        await sleep(300);
        await type("#model", process.env.E2E_MODEL, "change");
        await sleep(300);
      }
      await click("#test");
      await until(`/works|funktioniert/.test(document.querySelector('.ai-fields [role=status]')?.textContent || '') || !!document.querySelector('.ai-fields .problem')`, 240000);
      log("provider test:", await text(".ai-fields [role=status]"));
      await shot("settings");
      await click(".bar-btn");

      // 2. A new exam: in 6 days, 45 min a day, a 5.0, sprint.
      await click(".empty .btn");
      await type(".field", examName);
      await click(go);
      await click(".seg button:nth-child(2)");
      for (let i = 0; i < 8; i++) await click(".stepper button:first-child");
      for (let i = 0; i < 4; i++) await click(go);
      await until(`!!document.querySelector('.drop.first')`);

      // 3. The book and the objectives.
      const started = Date.now();
      await click(".drop .btn");
      await until(`document.querySelectorAll('.materials li').length === 1`, 300000);
      log("book read in", Math.round((Date.now() - started) / 100) / 10, "s:", (await text(".materials li div")).replace(/\n+/g, " | "));
      await click("#paste");
      await type(".paste textarea", fs.readFileSync(objectives, "utf8"));
      await click("#addObjectives");
      await until(`document.querySelectorAll('.materials li').length === 2`);
      await shot("material");

      // 4. The estimate, then the strategy.
      await click("#workOut");
      await until(`!!document.querySelector('#startAnalysis')`);
      log("estimate:", (await text(".estimate")).replace(/\n+/g, " | "));
      await shot("estimate");
      const analysis = Date.now();
      await click("#startAnalysis");
      await until(`!!document.querySelector('.standing') || !!document.querySelector('.analysis .problem')`, 900000);
      if (await js(`!!document.querySelector('.analysis .problem')`)) throw new Error("analysis: " + (await text(".analysis .problem")));
      log("strategy ready in", Math.round((Date.now() - analysis) / 1000), "s");
      await shot("today");
      await click(".tabs button:nth-child(2)");
      await shot("strategy");
      await click(".tabs button:nth-child(3)");
      await shot("plan");
    }
    const exam = saved().exams[0];
    fs.writeFileSync(path.join(out, "strategy.json"), JSON.stringify(exam.strategy, null, 2));
    log("checks", JSON.stringify(exam.strategy.checks), "pages sent", exam.strategy.pagesRead, "topics", exam.strategy.topics.length);

    if (part === "mock-review") {
      // A review of what is due: old questions, the written ones corrected by the model again.
      await click(".tabs button:nth-child(1)");
      await until(`/due|fällig/.test(document.querySelector('.next h2')?.textContent || '')`);
      await shot("today-review-due");
      await click(".next .btn.primary");
      await takeQuiz("review");
      let now = saved().exams[0];
      assert.ok(now.done["review:" + today] && now.history.at(-1).kind === "review", "the review is recorded");
      // A mock exam across the planned topics, written by the model.
      await click(".tabs button:nth-child(4)");
      const mockStart = Date.now();
      await js(`(() => { const rows = document.querySelectorAll('.practice:not(.history) li .btn'); rows[rows.length - 1].click(); })()`);
      await takeQuiz("mock");
      now = saved().exams[0];
      const mock = now.quizzes.mock.questions;
      log("mock exam:", mock.length, "questions over", new Set(mock.map((q) => q.topicId)).size, "topics, types", [...new Set(mock.map((q) => q.type))].join("/"), "in", Math.round((Date.now() - mockStart) / 1000), "s");
      assert.ok(now.done.mock && now.history.at(-1).kind === "mock", "the mock exam is recorded");
      assert.ok(new Set(mock.map((q) => q.topicId)).size >= 2, "the mock exam covers more than one topic");
      await shot("today-after-mock");
      log("mastery", JSON.stringify(now.mastery), "usage", JSON.stringify(now.usage));
    } else {
      // 5. The book at cited pages, as the person would see it.
      if (process.env.E2E_BOOKS !== "0") {
        const cited = exam.strategy.topics.flatMap((t) => t.steps.filter((s) => s.kind === "solve").map((s) => ({ topic: t.title, ...s }))).slice(0, 3);
        const theory = exam.strategy.topics[0].steps.find((s) => s.kind === "read");
        for (const [name, materialId, page] of [...cited.map((c, i) => [`book-exercises-${i + 1}-p${c.page}`, c.material, c.page]), ...(theory ? [[`book-theory-p${theory.from}`, theory.material, theory.from]] : [])]) {
          await js(`window.spurt.openBook(${JSON.stringify(exam.id)}, ${JSON.stringify(materialId)}, ${page})`);
          await sleep(4500);
          const bookWindow = windows.find((w) => w.id !== win.id && !w.isDestroyed());
          if (!bookWindow) throw new Error("the book window did not open");
          bookWindow.setContentSize(1000, 1300);
          await sleep(1500);
          fs.writeFileSync(path.join(out, name + ".png"), await capture(bookWindow));
          log("shot", name);
        }
        for (const c of cited) log("cited", `p${c.page} [${c.labels.join(", ")}]`, c.unconfirmed.length ? "UNCONFIRMED " + c.unconfirmed.join(",") : "", "|", c.topic);
      }
      // 6. A quiz on the first topic.
      await click(".tabs button:nth-child(4)");
      await shot("practice");
      const quizStart = Date.now();
      await click(".practice li .btn");
      await until(`!!document.querySelector('.q-prompt') || !!document.querySelector('.page.focus .problem')`, 420000);
      log("quiz ready in", Math.round((Date.now() - quizStart) / 1000), "s");
      await takeQuiz("quiz");
      const end = saved().exams[0];
      log("usage", JSON.stringify(end.usage), "mastery", JSON.stringify(end.mastery), "cards", Object.keys(end.cards).length);
    }
    log(errors.length ? "PAGE ERRORS " + errors.join(" | ") : "no errors in the page");
    log("ok");
  } catch (e) {
    await shot("failure").catch(() => {});
    log("FAIL", e.message, errors.join(" | "));
    process.exitCode = 1;
  }
  app.quit();
});

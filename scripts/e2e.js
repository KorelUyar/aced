// The whole path for real, in a hidden window, with a real book and a real model:
//
//   node_modules/.bin/electron scripts/e2e.js <book.pdf> <objectives.txt> <outDir> [exam name] [en|de]
//
// Uses "Claude Code on this Mac" (the person's own login, no key). It picks the provider in
// Settings and tests it, creates an exam, adds the PDF and the objectives, works out the
// strategy, opens the book at cited pages, takes a quiz and has a written answer corrected.
// Pictures and the saved data land in <outDir>. This costs real tokens: run it deliberately.
const { app, dialog } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("e2e.js"));
const [book, objectives, outArg, examName = "Quadratic functions", language = "en"] = args;
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const userData = path.join(out, "data");
// E2E_RESUME=1 keeps the data of the last run and goes straight to the book and the quiz
// (answers the model already gave are on disk, so this costs next to nothing).
const resume = process.env.E2E_RESUME === "1" && fs.existsSync(path.join(userData, "spurt.json"));
if (!resume) fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
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
  const type = (selector, text) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.innerText`);
  const shot = async (name) => {
    await sleep(350);
    fs.writeFileSync(path.join(out, name + ".png"), await capture(win));
    log("shot", name);
  };
  const saved = () => JSON.parse(fs.readFileSync(path.join(userData, "spurt.json"), "utf8"));
  const go = ".wizard-foot .btn.primary";

  try {
    await until(`!!window.__nav`);
    win.webContents.setZoomFactor(SCALE);

    if (resume) {
      await click(".exam-card");
      await until(`!!document.querySelector('.standing')`);
    } else {
    // 1. Settings: Claude Code on this Mac, and a real test request.
    await click(".bar-btn.square");
    if (language === "de") await js(`document.querySelector('.setting').querySelectorAll('button')[1].click()`);
    await click(".ai .pace:nth-child(1)");
    await click("#test");
    await until(`/works|funktioniert/.test(document.querySelector('.ai-fields [role=status]')?.textContent || '') || !!document.querySelector('.ai-fields .problem')`, 120000);
    log("provider test:", await text(".ai-fields [role=status]"));
    await shot("settings");
    await click(".bar-btn");

    // 2. A new exam: in 6 days, 45 min a day, a 5.0, sprint.
    await click(".empty .btn");
    await type(".field", examName);
    await click(go);
    await click(".seg button:nth-child(2)");
    for (let i = 0; i < 8; i++) await click(".stepper button:first-child");
    await click(go);
    await click(go);
    await click(go);
    await click(go);
    await until(`!!document.querySelector('.drop.first')`);
    await shot("material-empty");

    // 3. The book and the objectives.
    const started = Date.now();
    await click(".drop .btn");
    await until(`document.querySelectorAll('.materials li').length === 1`, 180000);
    log("book read in", Math.round((Date.now() - started) / 100) / 10, "s:", await text(".materials li"));
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
    await sleep(1500);
    await shot("running");
    await until(`!!document.querySelector('.standing') || !!document.querySelector('.analysis .problem')`, 600000);
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
    log("checks", JSON.stringify(exam.strategy.checks), "pages sent", exam.strategy.pagesRead, "offset", exam.materials[0].offset);

    // 5. The book at cited pages, as the person would see it.
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

    // 6. A quiz on the first topic: every question answered, a written one corrected by the model.
    await click(".tabs button:nth-child(4)");
    await shot("practice");
    const quizStart = Date.now();
    await click(".practice li .btn");
    await until(`!!document.querySelector('.q-prompt') || !!document.querySelector('.page.focus .problem')`, 300000);
    if (await js(`!!document.querySelector('.page.focus .problem')`)) throw new Error("quiz: " + (await text(".page.focus .problem")));
    log("quiz written in", Math.round((Date.now() - quizStart) / 1000), "s");
    let written = false;
    for (let n = 0; n < 12; n++) {
      const isChoice = await js(`!!document.querySelector('.choice')`);
      if (isChoice) await click(".choice:nth-child(2)");
      else await type("textarea.answer", language === "de" ? "Ich bin nicht sicher. Ich glaube, man muss zuerst die Formel aufstellen und dann einsetzen." : "I am not sure. I think you take x = -b/(2a) and put it back into the function to get the vertex.");
      await click("#check");
      await until(`!!document.querySelector('.feedback')`, 180000);
      log("answered", isChoice ? "choice" : "written", "->", (await text(".verdict")).replace(/\n+/g, " "));
      if (!isChoice && !written) {
        written = true;
        await shot("quiz-written");
      } else if (n === 0) await shot("quiz-choice");
      const last = await js(`/Finish|beenden/.test(document.querySelector('#next').textContent)`);
      await click("#next");
      if (last) break;
    }
    await until(`!!document.querySelector('.result')`);
    log("result", await text(".result .grade"));
    await click(".result .btn");
    await until(`!!document.querySelector('.standing')`);
    await shot("today-after-quiz");

    const end = saved().exams[0];
    log("usage", JSON.stringify(end.usage), "mastery", JSON.stringify(end.mastery), "cards", Object.keys(end.cards).length);
    log(errors.length ? "PAGE ERRORS " + errors.join(" | ") : "no errors in the page");
    log("ok");
  } catch (e) {
    await shot("failure").catch(() => {});
    log("FAIL", e.message, errors.join(" | "));
    process.exitCode = 1;
  }
  app.quit();
});

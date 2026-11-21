// The whole path for real, in a hidden window, with a real book and a real model:
//
//   node_modules/.bin/electron scripts/e2e.js <book.pdf> <objectives.txt> <outDir> [exam name] [en|de]
//
// By default it uses "Claude Code on this Mac" (the person's own login, no key). It picks the
// provider in Settings and tests it, creates an exam, adds the PDF and the objectives, works
// out the strategy with its formula sheet, opens the exam screen with the book beside the plan,
// asks the helper about something outside the plan, and sits the final exam: right results in
// several notations, one topic wrong on purpose, results that are not numbers in another form
// than expected (those are the ones the model marks). Pictures and the saved data land in
// <outDir>. This costs real tokens: run it deliberately.
//
//   E2E_PROVIDER=openai E2E_BASE=http://127.0.0.1:11434/v1 E2E_MODEL=<name>   another server instead
//   E2E_PROVIDER=anthropic E2E_KEY_FILE=<file holding the key>                 the Anthropic API instead;
//                              the key is read from the file, kept in memory only and never printed
//   E2E_STOP=strategy          stop once the strategy is there
//   E2E_RESUME=1               keep the data of the last run (answers already given are on disk)
//   E2E_ASK="a question"       what the helper is asked (default: where logarithms are explained)
const { app, dialog } = require("electron");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("e2e.js"));
const [book, objectives, outArg, examName = "Quadratic functions", language = "en"] = args;
if (!book || !objectives || !outArg) {
  console.log("usage: electron scripts/e2e.js <book.pdf> <objectives.txt> <outDir> [exam name] [en|de]");
  process.exit(1);
}
const provider = process.env.E2E_PROVIDER || "claudeCode";
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const userData = path.join(out, "data");
const dataFile = path.join(userData, "aced.json");
const resume = process.env.E2E_RESUME === "1" && fs.existsSync(dataFile);
if (!resume) fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
const saved = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));
const exam = () => saved().exams[0];

app.setPath("userData", userData);
process.env.ACED_LANG = language;
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

app.whenReady().then(async () => {
  const win = await window;
  const errors = [];
  win.webContents.on("console-message", (e) => (e.level === "error" || e.level === 3) && errors.push(e.message));
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(200);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector, timeout) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, timeout);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(150);
  };
  const type = (selector, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const shot = async (name) => {
    await sleep(400);
    fs.writeFileSync(path.join(out, name + ".png"), await capture(win));
  };
  const seconds = (from) => ((Date.now() - from) / 1000).toFixed(0) + " s";

  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    if (!resume) {
      // ---- the provider, chosen and tested in Settings
      await js(`window.__nav({ name: 'settings', from: { name: 'home' } })`);
      await click(`.ai .provider:nth-child(${["claudeCode", "anthropic", "openrouter", "openai"].indexOf(provider) + 1}) .pace`);
      if (provider === "openai") await js(`window.aced.setSettings({ ai: { provider: 'openai', baseURL: ${JSON.stringify(process.env.E2E_BASE || "")}, model: ${JSON.stringify(process.env.E2E_MODEL || "")} } })`);
      else if (process.env.E2E_MODEL) await js(`window.aced.setSettings({ ai: { provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(process.env.E2E_MODEL)} } })`);
      if (process.env.E2E_KEY_FILE) await js(`window.aced.setKey(${JSON.stringify(provider)}, ${JSON.stringify(fs.readFileSync(process.env.E2E_KEY_FILE, "utf8").trim())}).then(() => 0)`);
      await js(`window.dispatchEvent(new Event('focus'))`);
      await sleep(600);
      await click("#test");
      await until(`/\\S/.test(document.querySelector('.ai-fields .with-button [role=status]')?.textContent || '') || !!document.querySelector('.cc-state:not(.ok)')`, 120000);
      log("provider test:", await js(`document.querySelector('.ai-fields .with-button [role=status]')?.textContent || document.querySelector('.cc-state')?.textContent`));

      // ---- the exam and its material
      const date = new Date(Date.now() + 6 * 864e5).toLocaleDateString("sv");
      const created = await js(`window.aced.createExam({ name: ${JSON.stringify(examName)}, date: ${JSON.stringify(date)}, time: { mode: 'perDay', minutes: 45 }, scale: 'ch', target: 5, pace: 'sprint' })`);
      await js(`window.dispatchEvent(new Event('focus'))`);
      await sleep(400);
      await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.resolve(book)] });
      let t0 = Date.now();
      await click("#chooseFiles");
      await until(`document.querySelectorAll('.materials li').length === 1`, 600000);
      const m = exam().materials[0];
      log("book read in", seconds(t0) + ":", m.title, "|", m.pages, "pages |", m.chars, "characters | offset", m.offset, m.recognised ? "| recognised" : "", m.scanned ? "| NO TEXT" : "");
      await click("#paste");
      await type(".paste textarea", fs.readFileSync(objectives, "utf8"));
      await click("#addObjectives");
      await until(`document.querySelectorAll('.materials li').length === 2`);

      // ---- the strategy, with its formula sheet
      await click("#workOut");
      await until(`!!document.querySelector('#startAnalysis') || !!document.querySelector('.estimate .cc-state')`, 120000);
      log("estimate:", (await js(`document.querySelector('.estimate').innerText`)).replace(/\n+/g, " | ").slice(0, 400));
      await shot("e2e-estimate");
      t0 = Date.now();
      await click("#startAnalysis");
      await until(`!!document.querySelector('.path .step') || !!document.querySelector('.analysis .problem-box')`, 900000);
      if (!exam().strategy) throw new Error("no strategy: " + (await js(`document.querySelector('.analysis')?.innerText`)));
      const s = exam().strategy;
      log("strategy and formula sheet in", seconds(t0), "| checks", JSON.stringify(s.checks), "| pages read", s.pagesRead, "| topics", s.topics.length);
      for (const t of s.topics) log("  ", t.title, "|", t.steps.map((st) => (st.kind === "read" ? `read ${st.from}-${st.to}` : st.kind === "solve" ? `solve p${st.page}: ${st.labels.join(",")}${st.unconfirmed.length ? " (unconfirmed: " + st.unconfirmed + ")" : ""}` : "")).filter(Boolean).join("; "));
      const f = exam().formulas || [];
      log("formulas:", f.map((g) => g.formulas.length).join("+") || "none", "| with a page:", f.flatMap((g) => g.formulas).filter((x) => x.page).length, "of", f.flatMap((g) => g.formulas).length);
    } else {
      await click(".exam-card");
    }
    if (process.env.E2E_STOP === "strategy") throw Object.assign(new Error("stopped after the strategy, as asked"), { fine: true });

    // ---- the exam on one screen
    await until(`!!document.querySelector('.path .step')`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 120000);
    log("exam screen:", await js(`document.querySelector('.percent b').textContent`), "% |", await js(`document.querySelector('.path-now').textContent.trim()`), "| book at", await js(`document.querySelector('.pager .num')?.textContent`));
    await shot("e2e-exam");
    await click(".step.now .mark");
    await sleep(600);
    await click(".tabs.panels button:nth-child(2)");
    await until(`!!document.querySelector('.formula') || !!document.querySelector('.sheet-panel .muted')`, 300000);
    await shot("e2e-formulas");
    await click(".tabs.panels button:nth-child(1)");

    // ---- the helper, asked about something that is not in the plan
    await click("#helperToggle");
    let t0 = Date.now();
    await type(".drawer .ask input", process.env.E2E_ASK || "Where in the book are logarithms explained, and are there exercises on them?");
    await click(".drawer .ask .btn");
    await until(`!!document.querySelector('.drawer .answered') || !!document.querySelector('.drawer .problem-box')`, 300000);
    log("helper in", seconds(t0) + ":", (await js(`document.querySelector('.drawer .turn').innerText`)).replace(/\n+/g, " | ").slice(0, 700));
    if (await js(`!!document.querySelector('.drawer .page-link')`)) {
      await click(".drawer .page-link");
      await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 120000);
      log("a page in the answer moved the book to", await js(`document.querySelector('.pager .num')?.textContent`), "| the answer is still there:", await js(`!!document.querySelector('.drawer .answered')`));
    }
    await shot("e2e-helper");
    await click(".drawer .mini");

    // ---- the final exam
    t0 = Date.now();
    await js(`document.querySelector('.plan').scrollTo(0, 1e6)`);
    await click((await js(`!!document.querySelector('#finalAnother')`)) ? "#finalAnother" : "#finalStart");
    await until(`!!document.querySelector('.question-card:not(.marked)') || !!document.querySelector('.set .problem-box')`, 600000);
    const set = Object.values(exam().sets).filter((x) => x.final && !x.result).pop();
    if (!set) throw new Error("no final exam: " + (await js(`document.querySelector('.set')?.innerText`)));
    log("final exam written in", seconds(t0) + ":", set.questions.length, "questions |", set.questions.map((q) => q.type).join(","), "| spare exercises for", Object.keys(set.spare).length, "topics");
    await shot("e2e-final");
    const weakTopic = set.questions[0].topicId;
    let k = 0;
    for (const q of set.questions) {
      const card = `[data-question="${q.id}"]`;
      const wrong = q.topicId === weakTopic;
      if (q.type === "choice") await js(`document.querySelectorAll('${card} .choice')[${wrong ? (q.correct + 1) % q.choices.length : q.correct}].click()`);
      else {
        let v;
        if (q.type === "number") v = wrong ? String(q.value + 7) : [String(q.value), String(q.value).replace(".", ","), "x = " + q.value, `${q.value} ${q.unit}`][k++ % 4];
        else if (q.type === "numbers") v = wrong ? "0" : [...q.values].reverse().join(k++ % 2 ? " und " : "; ");
        // Not a number: the right result, written another way than the expected one.
        else v = wrong ? "?" : q.answer.replace(/\$/g, "").replace(/^\s*(f\(x\)|y)\s*=\s*/, "").replace(/\\infty/g, "∞").replace(/\\(left|right|,)/g, "") + " ";
        await type(card + " input", v);
      }
      await sleep(100);
    }
    await sleep(700);
    t0 = Date.now();
    await click("#handIn");
    await until(`!!document.querySelector('.result-head') || !!document.querySelector('.set-foot .problem-box')`, 600000);
    const result = exam().sets[set.key].result;
    if (!result) throw new Error("not marked: " + (await js(`document.querySelector('.set-foot')?.innerText`)));
    log("marked in", seconds(t0) + ":", `${result.points}/${result.max}`, "| grade", result.grade, "| weak", JSON.stringify(result.weak));
    for (const q of set.questions) log("  ", q.type.padEnd(7), JSON.stringify(result.typed[q.id]), "expected", JSON.stringify(q.answer.slice(0, 50)), "->", `${result.marks[q.id].points}/${result.marks[q.id].max}`, result.marks[q.id].note);
    log("back on the list:", JSON.stringify(exam().again.map((a) => a.steps.map((st) => (st.kind === "solve" ? `solve p${st.page}: ${st.labels}${st.repeat ? " (again)" : ""}` : st.kind)))));
    await shot("e2e-result");
    await click("#toPlan");
    await until(`!!document.querySelector('.path .step')`);
    await js(`document.querySelector('.plan').scrollTo(0, 1e6)`);
    await shot("e2e-after");
    const u = exam().usage;
    log("tokens:", u.input, "in (", u.cached, "from cache),", u.output, "out | cost", u.cost ? "$" + u.cost.toFixed(2) : "not counted (subscription or unknown price)");
    assert.deepEqual(errors, [], "no errors in the page");
    log("ok");
  } catch (e) {
    if (e.fine) log(e.message);
    else {
      await shot("e2e-failure").catch(() => {});
      log("FAIL", e.message, errors.slice(0, 3).join(" | "));
      process.exitCode = 1;
    }
  }
  app.exit(process.exitCode || 0);
});

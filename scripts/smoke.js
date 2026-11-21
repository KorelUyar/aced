// Clicks through the real app in a hidden window and checks what happens:
//
//   node_modules/.bin/electron scripts/smoke.js           empty start: create an exam, add a PDF and objectives, edit, delete
//   node_modules/.bin/electron scripts/smoke.js sample    sample exams: strategy, plan, today's tasks, a quiz, settings
//
// Add the path of a built app.asar to run the packaged files instead of the source folder:
//   node_modules/.bin/electron scripts/smoke.js dist/mac-universal/Spurt.app/Contents/Resources/app.asar
const { app, dialog, BrowserWindow } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, hideWindowsOf, sleep } = require("./hidden");

const sample = process.argv.includes("sample");
const appDir = process.argv.find((a) => a.endsWith(".asar")) || path.join(__dirname, "..");
if (sample) process.env.SPURT_SAMPLE = "1";
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-smoke-"));
app.setPath("userData", userData);
// "Claude Code" in this run is a stand-in whose sign-in state the test sets (see scripts/fixtures):
// no real login is touched, and its sign-in runs without opening a Terminal window.
const stateFile = path.join(userData, "claude-state");
const stub = path.join(__dirname, "fixtures", "claude-stub.sh");
Object.assign(process.env, { SPURT_CLAUDE: stub, SPURT_STUB_STATE: stateFile, SPURT_SIGNIN: "run" });
const signInState = (word) => fs.writeFileSync(stateFile, word);
signInState("signedOut");
quiet();
const mainFile = path.join(path.resolve(appDir), "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
  const errors = [];
  win.webContents.on("console-message", (e) => e.level === "error" && errors.push(e.message));
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(80);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(60);
  };
  const type = (selector, text) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const saved = () => JSON.parse(fs.readFileSync(path.join(userData, "spurt.json"), "utf8"));
  const go = ".wizard-foot .btn.primary";

  try {
    await until(`!!window.__nav`);
    if (!sample) {
      await until(`!!document.querySelector('.empty')`);
      await click(".empty .btn");
      assert.equal(await js(`document.querySelector(${JSON.stringify(go)}).disabled`), true, "cannot continue without a name");
      await type(".field", "Chemie: Säuren und Basen");
      await click(go); // when: default, in 14 days
      await click(go); // time
      await click(".chips button:nth-child(2)");
      await click(go); // grade
      await click(".seg button:nth-child(2)"); // German scale
      assert.equal(await text(".grade"), "2.0");
      await click(go); // pace
      await click(".pace:nth-child(3)");
      await click(go);
      // A new exam lands on Material, ready for the book and the objectives.
      await until(`!!document.querySelector('.drop.first')`);
      assert.equal(await text(".exam-head h1"), "Chemie: Säuren und Basen");
      let e = saved().exams[0];
      assert.deepEqual([e.scale, e.target, e.pace, e.time.mode, e.time.minutes], ["de", 2, "efficient", "perDay", 30]);
      await click("#paste");
      await type(".paste textarea", "Ich kann den pH-Wert einer starken Säure berechnen.\nIch kann eine Neutralisation aufstellen.");
      await click("#addObjectives");
      await until(`document.querySelectorAll('.materials li').length === 1`);
      e = saved().exams[0];
      assert.equal(e.materials[0].kind, "objectives");
      assert.equal(fs.readdirSync(path.join(userData, "texts")).length, 1, "the pasted text is kept");
      // Objectives alone are not enough: the app says what is missing instead of starting.
      await click("#workOut");
      await until(`!!document.querySelector('.estimate')`);
      assert.match(await text(".estimate"), /book or other material/i);
      await click(".estimate .btn");
      // A real PDF with text in it, made here, added through "Choose files".
      const pdfFile = path.join(userData, "Chemie-Buch.pdf");
      const printer = new BrowserWindow({ show: false });
      const chapter = (n, title) => `<h1>Kapitel ${n} ${title}</h1>` + `<p>${"Eine Säure gibt Protonen ab, eine Base nimmt sie auf. ".repeat(12)}</p><p>Aufgabe ${n}. Berechne den pH-Wert.</p>`;
      await printer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`${chapter(1, "Säuren")}<div style="page-break-before: always">${chapter(2, "Basen")}</div>`));
      fs.writeFileSync(pdfFile, await printer.webContents.printToPDF({}));
      printer.destroy();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfFile] });
      await click(".drop .btn");
      await until(`document.querySelectorAll('.materials li').length === 2`, 20000);
      const pdf = saved().exams[0].materials.find((m) => m.type === "pdf");
      assert.deepEqual([pdf.kind, pdf.pages, pdf.scanned], ["book", 2, false], "the PDF's text was read, page by page");
      assert.ok(pdf.chars > 800 && fs.existsSync(path.join(userData, "library", pdf.hash + ".pdf")), "the book is kept in the app's folder");
      // If the text read from the PDF is lost, it is read again from the copy in the library.
      fs.rmSync(path.join(userData, "texts", pdf.hash + ".json"));
      await click("#workOut");
      await until(`!!document.querySelector('.estimate')`, 20000);
      assert.ok(fs.existsSync(path.join(userData, "texts", pdf.hash + ".json")), "lost text is read again");
      await click(".estimate .btn.plain");
      // Now only the AI is missing, and the app says so.
      await click("#workOut");
      await until(`!!document.querySelector('.estimate')`);
      assert.match(await text(".estimate"), /where the AI comes from/i);
      await click(".estimate .btn.plain");
      // The key for "another server" belongs to its address, and plain http is refused for other computers.
      await js(`window.spurt.setSettings({ ai: { provider: 'openai', baseURL: 'https://one.example/v1' } })`);
      await js(`window.spurt.setKey('openai', 'a-test-key')`);
      assert.equal(await js(`window.spurt.state().then((s) => s.ai.keys.openai)`), true);
      await js(`window.spurt.setSettings({ ai: { provider: 'openai', baseURL: 'https://two.example/v1' } })`);
      assert.equal(await js(`window.spurt.state().then((s) => s.ai.keys.openai)`), false, "a new address forgets the old key");
      assert.equal(await js(`window.spurt.setSettings({ ai: { provider: 'openai', baseURL: 'http://two.example/v1' } }).then(() => 'accepted', (e) => e.message)`), "insecureAddress");
      await js(`window.spurt.setSettings({ ai: { provider: null } })`);
      // An error from the main process arrives as a sentence, not as a code: a server that is not there.
      await click(".bar-btn.square");
      await click(".ai .provider:nth-child(4) .pace");
      await until(`!!document.querySelector('#baseURL')`);
      for (const [field, value] of [["#baseURL", "http://127.0.0.1:9/v1"], ["#model", "none"]]) {
        await js(`(() => { const el = document.querySelector(${JSON.stringify(field)});
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await sleep(250);
      }
      await click("#test");
      await until(`/No connection to the provider/.test(document.querySelector('.ai-fields [role=status]')?.textContent || '')`, 15000);
      await click(".bar-btn");
      await until(`!!document.querySelector('.exam-head')`);
      // ---- Claude Code on this Mac: every state has a sentence and a way forward.
      const cc = (state, timeout = 20000) => until(`document.querySelector('.cc-state')?.dataset.state === '${state}'`, timeout);
      await click(".bar-btn.square");
      await click(".ai .provider:nth-child(1) .pace");
      await cc("signedOut");
      assert.match(await text(".cc-state"), /not signed in/);
      await click("#ccSignIn"); // starts Claude Code's own sign-in (here: the stand-in's)
      await cc("waiting");
      const command = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("spurt-signin-")).map((d) => path.join(os.tmpdir(), d, "Sign in to Claude Code.command")).filter((f) => fs.existsSync(f)).pop();
      assert.ok(command && /auth login/.test(fs.readFileSync(command, "utf8")) && fs.statSync(command).mode & 0o100, "the sign-in is a script Terminal can run");
      await cc("ok"); // noticed by itself, no click
      await click("#test");
      await until(`/It works/.test(document.querySelector('.ai-fields .with-button [role=status]')?.textContent || '')`, 15000);
      // A stored login that the service no longer accepts (what "OAuth session expired" was).
      signInState("stale");
      await click("#test");
      await cc("expired");
      assert.match(await text(".cc-state"), /sign-in has expired/);
      assert.ok(!/OAuth|Failed to authenticate|answered with an error/.test(await text(".ai-fields")), "no raw sentence from the command line");
      await click("#ccSignIn");
      await cc("ok");
      // Not installed at all.
      process.env.SPURT_CLAUDE = path.join(userData, "no-claude-here");
      await click(".ai .provider:nth-child(2) .pace");
      await click(".ai .provider:nth-child(1) .pace");
      await cc("missing");
      assert.ok(await js(`!!document.querySelector('#ccGet')`), "a button leads to where Claude Code can be got");
      process.env.SPURT_CLAUDE = stub;
      await click(".cc-state .btn.plain"); // "Check again"
      await cc("ok");
      // In the middle of a run: the strategy is refused because the sign-in has gone stale.
      signInState("stale");
      await click(".bar-btn");
      await until(`!!document.querySelector('.exam-head')`);
      await click("#workOut");
      await click("#startAnalysis");
      await until(`!!document.querySelector('.analysis .cc-state')`, 30000);
      await cc("expired");
      assert.ok(!/OAuth|Failed to authenticate/.test(await text(".analysis")), "the run stops with the same sentence and button, not with the raw error");
      await click("#ccSignIn");
      await until(`!!document.querySelector('#startAnalysis')`, 30000); // signed in again: back at the estimate, by itself
      await click(".estimate .btn.plain");
      // Before a run, when the person is not signed in at all: the estimate says so first.
      signInState("signedOut");
      await click("#workOut");
      await until(`!!document.querySelector('.estimate .cc-state')`);
      await cc("signedOut");
      assert.ok(!(await js(`!!document.querySelector('#startAnalysis')`)), "nothing can be started before signing in");
      await click(".estimate .btn.plain");
      await js(`window.spurt.setSettings({ ai: { provider: null } })`);
      // Edit, then delete.
      await click(".exam-actions .link");
      await type(".field", "Chemie: Säuren, Basen, Puffer");
      for (let i = 0; i < 5; i++) await click(go);
      await until(`document.querySelector('.exam-head h1')?.textContent === 'Chemie: Säuren, Basen, Puffer'`);
      assert.equal(saved().exams[0].materials.length, 2, "editing keeps the material");
      await click(".tabs button:nth-child(5)");
      await click("#delete");
      await click("#deleteYes");
      await until(`!!document.querySelector('.empty')`);
      assert.equal(saved().exams.length, 0);
      assert.deepEqual([fs.readdirSync(path.join(userData, "library")), fs.readdirSync(path.join(userData, "texts"))], [[], []], "deleting the exam deletes its book and the text read from it");
      console.log("ok: created, filled (pasted objectives and a PDF), edited and deleted an exam from an empty start");
    } else {
      await until(`document.querySelectorAll('.exam-card').length === 3`);
      await click(".exam-card");
      await click(".tabs button:nth-child(2)");
      await until(`document.querySelectorAll('.topic').length === 4`);
      await click(".dropped > button");
      await until(`document.querySelectorAll('.dropped li').length === 2`);
      await click(".tabs button:nth-child(3)");
      await until(`document.querySelectorAll('.day').length === 7`);
      await click(".tabs button:nth-child(4)");
      await until(`document.querySelectorAll('.practice li').length >= 5`);
      await click(".tabs button:nth-child(1)");
      await click(".next .btn.plain"); // mark the exercises as done
      await until(`/Done for today/.test(document.querySelector('.next h2').textContent)`);
      await click(".next .btn.second"); // keep going: tomorrow's first task comes into today
      await until(`!!document.querySelector('.next .btn.plain')`);
      // A quiz from Practice: one wrong choice, the prepared written correction, one right choice.
      await click(".tabs button:nth-child(4)");
      await click(".practice li .btn");
      await click(".choice:nth-child(2)");
      await click("#check");
      await until(`!!document.querySelector('.feedback.wrong')`);
      assert.ok(await js(`!!document.querySelector('.q-prompt .katex')`), "formulas are drawn");
      await click("#next");
      await type("textarea.answer", "(x − 3)² + 4");
      await click("#check");
      await until(`!!document.querySelector('.feedback.partly')`);
      await click("#next");
      await click(".choice:nth-child(1)");
      await click("#check");
      await until(`!!document.querySelector('.feedback.right')`);
      await click("#next");
      await until(`!!document.querySelector('.result')`);
      assert.equal(await text(".result .grade"), "3/5");
      await click(".result .btn");
      // The missed questions are due again later, and the topic now has a measured result.
      await click(".tabs button:nth-child(4)");
      await until(`/60%/.test(document.querySelector('.practice li')?.textContent || '')`);
      // Settings: the AI section is there and choosing a provider sticks.
      await click(".bar-btn.square");
      await click(".ai .provider:nth-child(2) .pace");
      await until(`!!document.querySelector('#key')`);
      assert.ok(!fs.existsSync(path.join(userData, "spurt.json")), "sample data is never written to disk");
      console.log("ok: strategy, plan, practice, a quiz and settings on the sample exams");
    }
    assert.deepEqual(errors, [], "no errors in the page");
  } catch (e) {
    const toast = await js(`(document.querySelector('.toast')?.textContent || '') + ' || ' + (document.querySelector('.analysis')?.innerText || 'no analysis section') + ' || ' + (document.querySelector('.drop strong')?.textContent || '')`).catch(() => "");
    console.log("FAIL", e.message, errors.join(" | "), toast ? "| the app said: " + toast : "");
    process.exitCode = 1;
  }
  app.quit();
});

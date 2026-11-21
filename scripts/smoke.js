// Clicks through the real app in a hidden window and checks what happens:
//
//   node_modules/.bin/electron scripts/smoke.js           empty start: a new exam, material (pasted, dropped, chosen), settings,
//                                                          every state of Claude Code, a strategy, the plan, the helper, the final
//                                                          exam, a run that is left alone, cancelled and quit, edit, delete
//   node_modules/.bin/electron scripts/smoke.js sample    sample exams: the plan, formulas, the final exam, questions on a topic
//   node_modules/.bin/electron scripts/smoke.js damaged   a data file that cannot be read: nothing is lost, the backup comes back
//
// "Claude Code" in these runs is a stand-in (scripts/fixtures/claude-stub.sh): nothing is sent anywhere.
//
// Add the path of a built app.asar to run the packaged files instead of the source folder:
//   node_modules/.bin/electron scripts/smoke.js dist/mac-universal/Spurt.app/Contents/Resources/app.asar
const { app, dialog, BrowserWindow, Menu } = require("electron");
const { execSync } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, hideWindowsOf, sleep } = require("./hidden");

const sample = process.argv.includes("sample");
const damaged = process.argv.includes("damaged");
const appDir = process.argv.find((a) => a.endsWith(".asar")) || path.join(__dirname, "..");
if (sample) process.env.SPURT_SAMPLE = "1";
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-smoke-"));
app.setPath("userData", userData);
if (damaged) {
  // What a crash in the middle of a write could leave behind, next to the backup of the last good start.
  const good = { settings: { lang: "en", langFrom: "choice", appearance: "system", ai: { provider: null, models: {}, baseURL: "" } }, exams: [{ id: "e1", name: "Kept exam", date: "2099-01-01", time: { mode: "perDay", minutes: 30 }, scale: "ch", target: 5, pace: "sprint", materials: [], strategy: null, done: {} }] };
  fs.writeFileSync(path.join(userData, "spurt.backup.json"), JSON.stringify(good));
  fs.writeFileSync(path.join(userData, "spurt.json"), JSON.stringify(good).slice(0, 80));
}
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

  const count = (selector) => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const has = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)})`);
  const exam = () => saved().exams[0];
  const back = () => click(".bar > .bar-btn");

  try {
    await until(`!!window.__nav`);
    if (damaged) {
      // ---- a data file that cannot be read
      await until(`!!document.querySelector('#useBackup')`);
      assert.match(await text(".question h1"), /could not be read/);
      const broken = fs.readFileSync(path.join(userData, "spurt.json"), "utf8");
      await js(`window.spurt.setSettings({ appearance: 'dark' })`);
      assert.equal(fs.readFileSync(path.join(userData, "spurt.json"), "utf8"), broken, "nothing is written over the damaged file before the person has chosen");
      await click("#useBackup");
      await until(`document.querySelectorAll('.exam-card').length === 1`);
      assert.equal(await text(".exam-name"), "Kept exam");
      assert.ok(fs.readdirSync(userData).some((n) => n.startsWith("spurt.damaged-")), "the damaged file is kept under another name");
      assert.equal(saved().exams.length, 1, "and the data file is whole again");
      // ---- the menu: a Mac app's own, nothing that reloads the page or opens developer tools
      const labels = [];
      const walk = (menu) => menu.items.forEach((item) => (labels.push((item.role || "") + "|" + item.label), item.submenu && walk(item.submenu)));
      walk(Menu.getApplicationMenu());
      assert.ok(!labels.some((l) => /reload|devtools|developer/i.test(l)), "no Reload and no developer tools in the menu");
      const settingsItem = Menu.getApplicationMenu().items.flatMap((m) => (m.submenu ? m.submenu.items : [])).find((i) => /^Settings/.test(i.label));
      assert.ok(settingsItem && settingsItem.accelerator, "Settings… is in the menu, with its shortcut");
      settingsItem.click();
      await until(`!!document.querySelector('.settings')`);
      console.log("ok: a damaged data file is noticed, kept, and replaced by the backup; the menu is the app's own");
    } else if (!sample) {
      // ---- a new exam
      await until(`!!document.querySelector('.empty')`);
      await click(".empty .btn");
      assert.equal(await js(`document.querySelector(${JSON.stringify(go)}).disabled`), true, "cannot continue without a name");
      await type(".field", "Chemie: Säuren und Basen");
      await click(go); // when: default, in 14 days
      await click(go); // time
      await click(".chips button:nth-child(2)");
      await click(go); // grade
      await click(".grade-foot .seg button:nth-child(2)"); // German scale
      assert.equal(await text(".grade"), "2.0");
      await click(go); // pace
      await click(".pace:nth-child(3)");
      await click(go);
      // A new exam lands on its material, ready for the book and the objectives.
      await until(`!!document.querySelector('.drop.first')`);
      assert.equal(await text(".setup-title"), "Chemie: Säuren und Basen");
      let e = exam();
      assert.deepEqual([e.scale, e.target, e.pace, e.time.mode, e.time.minutes], ["de", 2, "efficient", "perDay", 30]);

      // ---- material: pasted text
      await click("#paste");
      assert.equal(await js(`document.activeElement === document.querySelector('.paste textarea')`), true, "the box to paste into has the keyboard");
      const objectives = "Ich kann den pH-Wert einer starken Säure berechnen.\nIch kann eine Neutralisation aufstellen.";
      await type(".paste textarea", objectives);
      await click("#addObjectives");
      await until(`document.querySelectorAll('.materials li').length === 1`);
      e = exam();
      assert.deepEqual([e.materials[0].kind, e.materials[0].title], ["objectives", "Ich kann den pH-Wert einer starken Säure berechnen."], "pasted text is named by its own first line");
      assert.equal(fs.readdirSync(path.join(userData, "texts")).length, 1, "the pasted text is kept");
      // It can be looked at and changed; the same text a second time is said to be there already.
      await click(".materials .link.strong");
      await until(`document.querySelector('.paste textarea')?.value.includes('Neutralisation')`);
      await type(".paste textarea", objectives + "\nIch kann einen Puffer erklären.");
      await click("#addObjectives");
      await until(`!document.querySelector('.paste')`);
      assert.equal(exam().materials.length, 1, "a changed text replaces the old one");
      await click("#paste");
      await type(".paste textarea", objectives + "\nIch kann einen Puffer erklären.");
      await click("#addObjectives");
      await until(`/already in this exam/.test(document.querySelector('.toast')?.textContent || '')`);
      await click(".paste .btn.plain");
      // Objectives alone are not enough: the app says what is missing instead of starting.
      await click("#workOut");
      await until(`!!document.querySelector('.estimate')`);
      assert.match(await text(".estimate"), /book or other material/i);
      await click(".estimate .btn");

      // ---- material: a real PDF with text in it, made here, dropped onto the window
      const pdfFile = path.join(userData, "Chemie-Buch.pdf");
      const printer = new BrowserWindow({ show: false });
      const chapter = (n, title) => `<h1>Kapitel ${n} ${title}</h1>` + `<p>${"Eine Säure gibt Protonen ab, eine Base nimmt sie auf. ".repeat(12)}</p><p>Aufgabe ${n}. Berechne den pH-Wert.</p>`;
      await printer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`${chapter(1, "Säuren")}<div style="page-break-before: always">${chapter(2, "Basen")}</div>`));
      fs.writeFileSync(pdfFile, await printer.webContents.printToPDF({}));
      printer.destroy();
      const [x, y] = await js(`(() => { const r = document.querySelector('.drop').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      win.webContents.debugger.attach("1.3");
      for (const kind of ["dragEnter", "dragOver", "drop"]) {
        await win.webContents.debugger.sendCommand("Input.dispatchDragEvent", { type: kind, x, y, data: { items: [], files: [pdfFile], dragOperationsMask: 1 } });
      }
      win.webContents.debugger.detach();
      await until(`document.querySelectorAll('.materials li').length === 2`, 20000);
      const pdf = exam().materials.find((m) => m.type === "pdf");
      assert.deepEqual([pdf.kind, pdf.pages, pdf.scanned], ["book", 2, false], "a dropped PDF is added, and its text read page by page");
      assert.ok(pdf.chars > 800 && fs.existsSync(path.join(userData, "library", pdf.hash + ".pdf")), "the book is kept in the app's folder");
      // The same file again, through "Choose files": nothing is added twice, and the app says so.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfFile] });
      await click("#chooseFiles");
      await until(`/already in this exam/.test(document.querySelector('.material .problem')?.textContent || '')`, 20000);
      assert.equal(exam().materials.length, 2);
      // Removed with one click, back with one click.
      await click(".materials li:nth-child(2) .mini");
      await until(`document.querySelectorAll('.materials li').length === 1`);
      await click(".toast-btn");
      await until(`document.querySelectorAll('.materials li').length === 2`);
      assert.ok(exam().materials.some((m) => m.hash === pdf.hash), "undo brings the book back");
      // If the text read from the PDF is lost, it is read again from the copy in the library.
      fs.rmSync(path.join(userData, "texts", pdf.hash + ".json"));
      await click("#workOut");
      await until(`!!document.querySelector('.estimate')`, 20000);
      assert.ok(fs.existsSync(path.join(userData, "texts", pdf.hash + ".json")), "lost text is read again");
      // Now only the AI is missing, and the app says so, with the way to Settings.
      assert.match(await text(".estimate"), /where the AI comes from/i);
      assert.ok(await has("#toSettings"));
      await click(".estimate .btn.plain");

      // ---- settings: another server
      await js(`window.spurt.setSettings({ ai: { provider: 'openai', baseURL: 'https://one.example/v1' } })`);
      await js(`window.spurt.setKey('openai', 'a-test-key')`);
      assert.equal(await js(`window.spurt.state().then((s) => s.ai.keys.openai)`), true);
      await js(`window.spurt.setSettings({ ai: { provider: 'openai', baseURL: 'https://two.example/v1' } })`);
      assert.equal(await js(`window.spurt.state().then((s) => s.ai.keys.openai)`), false, "a new address forgets the old key");
      assert.equal(await js(`window.spurt.setSettings({ ai: { provider: 'openai', baseURL: 'http://two.example/v1' } }).then(() => 'accepted', (e) => e.message)`), "insecureAddress");
      await js(`window.spurt.setSettings({ ai: { provider: null, baseURL: '' } })`);
      await click(".bar-btn.square");
      await click(".ai .provider:nth-child(4) .pace");
      await until(`!!document.querySelector('#baseURL')`);
      // Text that is no address stays in the field, with what is wrong with it.
      await type("#baseURL", "hello world");
      await js(`document.querySelector('#baseURL').dispatchEvent(new FocusEvent('blur'))`);
      await until(`/not an address/.test(document.querySelector('.ai-fields .problem')?.textContent || '')`);
      assert.equal(await js(`document.querySelector('#baseURL').value`), "hello world", "what was typed is still there");
      // An address without http:// on this computer is completed, and "Test" works on the first click.
      await type("#baseURL", "127.0.0.1:9/v1");
      await type("#model", "none");
      await click("#test");
      await until(`/No connection to the provider/.test(document.querySelector('.ai-fields .with-button [role=status]')?.textContent || '')`, 15000);
      assert.equal(saved().settings.ai.baseURL, "http://127.0.0.1:9/v1");

      // ---- Claude Code on this Mac: every state has a sentence and a way forward
      const cc = (state, timeout = 20000) => until(`document.querySelector('.cc-state')?.dataset.state === '${state}'`, timeout);
      const status = (re, timeout = 15000) => until(`${re}.test(document.querySelector('.ai-fields .with-button [role=status]')?.textContent || '')`, timeout);
      await click(".ai .provider:nth-child(1) .pace");
      await cc("signedOut");
      assert.match(await text(".cc-state"), /not signed in/);
      await click("#ccSignIn"); // starts Claude Code's own sign-in (here: the stand-in's)
      await cc("waiting");
      const command = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("spurt-signin-")).map((d) => path.join(os.tmpdir(), d, "Sign in to Claude Code.command")).filter((f) => fs.existsSync(f)).pop();
      assert.ok(command && /auth login/.test(fs.readFileSync(command, "utf8")) && fs.statSync(command).mode & 0o100, "the sign-in is a script Terminal can run");
      await cc("ok"); // noticed by itself, no click
      await click("#test");
      await status("/It works/");
      // A stored login that the service no longer accepts (what "OAuth session expired" was).
      signInState("stale");
      await click("#test");
      await cc("expired");
      assert.match(await text(".cc-state"), /sign-in has expired/);
      assert.ok(!/OAuth|Failed to authenticate|answered with an error/.test(await text(".ai-fields")), "no raw sentence from the command line");
      await click("#ccSignIn");
      await cc("ok");
      // Everything else Claude Code can fail with: a sentence each, never its own text.
      for (const [word, sentence] of [["usagelimit", "/usage limit is reached; it resets at 7pm \\(Europe\\/Zurich\\)/"], ["offline", "/No connection to the provider/"], ["overloaded", "/overloaded right now/"], ["badmodel", "/does not know this model/"]]) {
        signInState(word);
        await click("#test");
        await status(sentence);
        assert.ok(!/API Error|Run \/model|\{/.test(await text(".ai-fields .with-button [role=status]")), `"${word}" is said in plain words`);
      }
      signInState("ok");
      // Not installed at all: get it, or use another AI. No circle.
      process.env.SPURT_CLAUDE = path.join(userData, "no-claude-here");
      await click(".ai .provider:nth-child(2) .pace");
      await click(".ai .provider:nth-child(1) .pace");
      await cc("missing");
      assert.ok(await has("#ccGet"), "a button leads to where Claude Code can be got");
      await back();
      await until(`!!document.querySelector('.setup')`);
      await click("#workOut");
      await until(`!!document.querySelector('.estimate .cc-state')`);
      await cc("missing");
      assert.ok((await has(".estimate #ccGet")) && (await has(".estimate #ccOther")), "from the exam too: get Claude Code, or choose another AI");
      await click("#ccOther");
      await until(`!!document.querySelector('.settings')`);
      process.env.SPURT_CLAUDE = stub;
      await back();
      // In the middle of a run: the strategy is refused because the sign-in has gone stale.
      signInState("stale");
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
      assert.ok(!(await has("#startAnalysis")), "nothing can be started before signing in");
      await click(".estimate .btn.plain");
      // An answer with nothing in it is not kept: the next try asks again and succeeds.
      signInState("empty");
      await click("#workOut");
      await click("#startAnalysis");
      await until(`/could not be used/.test(document.querySelector('.analysis .problem')?.textContent || '')`, 30000);
      assert.ok(await has(".analysis #retry"), "the error stays on screen, with a way on");

      // ---- the strategy, and the exam on one screen
      signInState("ok");
      await click(".analysis #retry");
      assert.match(await text(".estimate"), /one to two minutes/, "the estimate says how long it usually takes");
      await click("#startAnalysis");
      await until(`!!document.querySelector('.path .step')`, 30000);
      e = exam();
      assert.deepEqual(e.strategy.topics.map((t) => t.steps.map((st) => st.kind).join()), ["read,solve,quiz", "read,quiz"]);
      assert.equal(e.formulas[0].formulas[0].page, 1, "the formula sheet is written with the strategy, each formula with its page");
      assert.deepEqual(await js(`[...document.querySelectorAll('.step .jump span')].map((x) => x.textContent)`), ["Read p. 1", "Solve p. 1: 1", "Read p. 2", "Answer 3 questions"], "steps say what to do, with page and number; questions only where the book has no exercises");
      assert.match(await text(".step.asks .jump"), /written by the AI/);
      assert.equal(await text(".percent b"), "0");
      assert.ok(await has(".stage.current .own-formulas .katex"), "the topic that is up shows its own formulas beside the book");
      await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 30000);
      // Ticking moves the percentage; a tick is taken back the same way.
      await click(".step.now .mark");
      await until(`document.querySelector('.percent b').textContent !== '0'`);
      const after = await text(".percent b");
      await click(".step.done .mark");
      await until(`document.querySelector('.percent b').textContent === '0'`);
      await click(".step.now .mark");
      await until(`document.querySelector('.percent b').textContent === ${JSON.stringify(after)}`);
      // The formula sheet: every formula with a link to its page, which moves the book.
      await click(".tabs.panels button:nth-child(2)");
      await until(`!!document.querySelector('.formula .katex')`);
      await click(".formula .page-ref");
      await until(`!!document.querySelector('.book')`);
      // The helper opens over the plan; a page in its answer moves the book and the conversation stays.
      await click("#helperToggle");
      await click(".drawer .idea");
      await until(`!!document.querySelector('.drawer .answered')`, 30000);
      assert.equal(await count(".drawer .page-link"), 1, "only a page that exists becomes a link");
      await click(".drawer .page-link");
      assert.ok((await has(".book")) && (await has(".drawer .answered")), "the book is beside it and the answer is still there");
      await click(".drawer .mini");
      await click("#helperToggle");
      assert.ok(await has(".drawer .answered"), "closed and opened again: the conversation is kept");
      await click(".drawer .mini");

      // ---- a run that is left alone, started twice, cancelled
      await click("#toSetup");
      await until(`!!document.querySelector('.facts')`);
      await click("#workOut");
      await until(`!!document.querySelector('.estimate .warn')`);
      assert.match(await text(".estimate"), /Nothing has changed since/);
      assert.match(await text(".estimate"), /ticked off 1 step/);
      signInState("slow");
      await click("#startAnalysis"); // "work it out again anyway"
      await until(`!!document.querySelector('.analysis .running')`);
      assert.match(await text(".analysis .running"), /0:0\d · usually one to two minutes/, "a run says how long it has been going and how long it usually takes");
      assert.equal(await js(`window.spurt.analyze(${JSON.stringify(e.id)}).then(() => 'started', (err) => err.message)`), "busy", "the same run cannot be started twice");
      await click(".bar > .bar-btn"); // back to the plan: the run is still shown there
      await until(`!!document.querySelector('.plan .running')`);
      await click(".bar > .bar-btn"); // and on the card at home
      await until(`!!document.querySelector('.exam-card .run-brief')`);
      await click(".exam-card");
      await click(".plan #cancelRun");
      await until(`!document.querySelector('.plan .running')`);
      await sleep(300);
      assert.ok(await has(".path .step.done"), "cancelling leaves the plan and its ticks as they were");
      assert.throws(() => execSync("pgrep -f claude-stub.sh", { stdio: "pipe" }), "the cancelled Claude Code process is gone");
      signInState("ok");

      // ---- the final exam: results only
      await click("#finalStart");
      await until(`document.querySelectorAll('.question-card').length === 4`, 30000);
      const set = Object.values(exam().sets).find((x) => x.final);
      assert.ok(!JSON.stringify(await js(`window.spurt.openSet(${JSON.stringify(e.id)}, { kind: 'final' })`)).includes("solution"), "the answers are not handed to the page before the exam is handed in");
      await type(`[data-question="${set.questions[0].id}"] input`, "pH = 3,0");
      await sleep(700);
      assert.equal(exam().sets[set.key].draft[set.questions[0].id], "pH = 3,0", "what is typed is kept at once");
      await click("#handIn");
      await until(`/3 questions have no result/.test(document.querySelector('.set-foot .hint')?.textContent || '')`);
      await click(`[data-question="${set.questions[1].id}"] .choice:nth-child(2)`); // wrong on purpose
      await type(`[data-question="${set.questions[2].id}"] input`, "Salz");
      await type(`[data-question="${set.questions[3].id}"] input`, "8 und 6");
      // Marking the one result that is not a number fails: the error stays, and so does what was typed.
      signInState("stale");
      await click("#handIn");
      await until(`!!document.querySelector('.set-foot .cc-state')`, 30000);
      assert.equal(await js(`document.querySelector('[data-question="${set.questions[2].id}"] input').value`), "Salz");
      assert.equal(exam().sets[set.key].result, null);
      await click(".set-foot #ccSignIn");
      await until(`!!document.querySelector('.result-head')`, 40000); // signed in again: handed in by itself
      const result = exam().sets[set.key].result;
      assert.deepEqual(set.questions.map((q) => result.marks[q.id].points), [2, 0, 2, 1], "a right number in another notation earns all its points; the text result was marked by the model");
      assert.deepEqual([result.points, result.max, result.weak], [5, 7, ["t1"]]);
      assert.equal(await js(`document.activeElement === document.querySelector('.set-head h1')`), true, "the keyboard is on the result");
      assert.match(await text(".result-topics"), /back on your list/);
      await click("#toPlan");
      await until(`!!document.querySelector('.stage.again')`);
      assert.match(await text(".stage.again"), /Again: Säuren und pH-Wert/);
      assert.match(await text(".stage.final"), /5 of 7 points/);
      // ---- questions on the topic whose book has no exercises
      await click(".step.asks .jump");
      await until(`document.querySelectorAll('.question-card').length === 4`, 30000);
      assert.match(await text(".set-head"), /written by the AI/);
      await click("#handIn");
      await click("#handIn"); // nothing answered: hand in anyway
      await until(`!!document.querySelector('.result-head')`, 30000);
      await click("#toPlan");
      await until(`/0 of 7 points/.test(document.querySelector('.step.asks')?.textContent || '')`);

      // ---- an exam whose date has passed can still be opened, read and given a new date
      const past = new Date(Date.now() - 3 * 864e5).toLocaleDateString("sv");
      await js(`window.spurt.editExam(${JSON.stringify(e.id)}, { date: ${JSON.stringify(past)} }).then(() => window.dispatchEvent(new Event('focus')))`);
      await until(`/This exam was on/.test(document.querySelector('.path-now')?.textContent || '')`);
      await click(".path-now .link");
      await until(`/This date has passed/.test(document.querySelector('.question .hint')?.textContent || '')`);
      assert.equal(await js(`document.querySelector(${JSON.stringify(go)}).disabled`), false, "the exam can be edited although its date has passed");
      const soon = new Date(Date.now() + 9 * 864e5).toLocaleDateString("sv");
      await type('.question input[type="date"]', soon);
      for (let i = 0; i < 4; i++) await click(go);
      await until(`!!document.querySelector('.facts')`);
      assert.equal(exam().date, soon);

      // ---- removing the book the plan points into is said, on the plan
      await click(".materials li:nth-child(2) .mini");
      await back();
      await until(`/points into a book that was removed/.test(document.querySelector('.plan-note')?.textContent || '')`);
      await click(".plan-note .link");
      await click(".toast-btn").catch(() => {});
      await js(`window.spurt.restoreMaterial(${JSON.stringify(e.id)}, ${JSON.stringify(pdf)}).catch(() => {})`);

      // ---- edit, then delete
      await until(`!!document.querySelector('#editExam')`);
      await click("#editExam");
      await type(".field", "Chemie: Säuren, Basen, Puffer");
      for (let i = 0; i < 5; i++) await click(go);
      await until(`/Säuren, Basen, Puffer/.test(document.querySelector('.facts')?.textContent || '')`);
      // ---- quitting in the middle of a run leaves no Claude Code process behind
      signInState("slow");
      await js(`window.__run = 'under way'; window.spurt.analyze(${JSON.stringify(e.id)}, { again: true }).then(() => (window.__run = 'done'), (err) => (window.__run = err.message)); 0`);
      await until(`!!document.querySelector('.analysis .running')`);
      await sleep(1500);
      execSync("pgrep -f claude-stub.sh", { stdio: "pipe" }); // it is running now (throws if not)
      app.emit("before-quit");
      await sleep(800);
      assert.throws(() => execSync("pgrep -f claude-stub.sh", { stdio: "pipe" }), "quitting stops the Claude Code process");
      await until(`!document.querySelector('.analysis .running')`);
      signInState("ok");
      await click("#delete");
      await click("#deleteYes");
      await until(`!!document.querySelector('.empty')`);
      assert.equal(saved().exams.length, 0);
      assert.deepEqual([fs.readdirSync(path.join(userData, "library")), fs.readdirSync(path.join(userData, "texts"))], [[], []], "deleting the exam deletes its book and the text read from it");
      console.log("ok: from an empty start: exam, material, settings, Claude Code states, strategy, plan, helper, final exam, runs, edit, delete");
    } else {
      // ---- the sample exams
      await until(`document.querySelectorAll('.exam-card').length === 3`);
      assert.match(await text(".exam-card .exam-percent"), /\d+%/);
      await click(".exam-card");
      await until(`document.querySelectorAll('.stage').length >= 5`);
      assert.match(await text(".left-out"), /Left out, because the time does not reach: Satz von Vieta/);
      assert.ok(await has(".stage.folded"), "a finished topic is folded away");
      assert.ok(await has(".day-end"), "one line shows where today's share ends");
      assert.ok(await has(".stage.current .own-formulas .katex"), "formulas are drawn");
      await click(".tabs.panels button:nth-child(2)");
      await until(`document.querySelectorAll('.formula').length === 5`);
      // The final exam of the sample: numbers in several notations, one wrong result.
      await click("#finalStart");
      await until(`document.querySelectorAll('.question-card').length === 6`);
      const typed = ["2", "3 und 2", null, "100 m²", "(x − 3)² + 4", "x = -1; x = 2"];
      for (let i = 0; i < typed.length; i++) {
        if (typed[i] === null) await click(`.question-card:nth-child(${i + 1}) .choice`);
        else await type(`.question-card:nth-child(${i + 1}) input`, typed[i]);
      }
      await click("#handIn");
      await until(`!!document.querySelector('.result-head')`);
      assert.equal(await text(".result-head .percent b"), "5.0");
      assert.match(await text(".result-line"), /8 of 10 points/);
      assert.match(await text(".question-card.wrong"), /Vorzeichen/);
      await click("#toPlan");
      await until(`!!document.querySelector('.stage.again')`);
      // The law exam has a topic without exercises in the book: questions written by the AI.
      await click(".bar > .bar-btn");
      await click(".exam-card:nth-child(2)");
      await click(".step.asks .jump");
      await until(`document.querySelectorAll('.question-card').length === 3`);
      await click(".question-card:nth-child(1) .choice");
      await type(".question-card:nth-child(2) input", "1 Jahr");
      await type(".question-card:nth-child(3) input", "grundlagenirrtum");
      await click("#handIn");
      await until(`!!document.querySelector('.result-head')`);
      assert.match(await text(".result-line"), /3 of 3 points/);
      await click("#toPlan");
      await until(`/3 of 3 points/.test(document.querySelector('.step.asks')?.textContent || '')`);
      // Settings: the AI section is there and choosing a provider sticks.
      await click(".bar > .bar-btn");
      await click(".bar-btn.square");
      await click(".ai .provider:nth-child(2) .pace");
      await until(`!!document.querySelector('#key')`);
      assert.ok(!fs.existsSync(path.join(userData, "spurt.json")), "sample data is never written to disk");
      console.log("ok: the sample exams: plan, formulas, a final exam, questions on a topic, settings");
    }
    assert.deepEqual(errors, [], "no errors in the page");
  } catch (e) {
    const said = await js(`(window.__run || '') + ' || ' + (document.querySelector('.toast')?.textContent || '') + ' || ' + (document.querySelector('.analysis, .set-foot, .cc-state')?.innerText || '').slice(0, 300)`).catch(() => "");
    console.log("FAIL", e.message, errors.join(" | "), said ? "| the app said: " + said : "");
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
});

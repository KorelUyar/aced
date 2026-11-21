// Screenshots of the real app on its sample exams, made without a person at the screen:
//
//   node_modules/.bin/electron scripts/shots.js <outDir> light|dark
//
// The window stays hidden. Pictures are 2x. In the dark run, three screens are also taken in German.
const { app, nativeTheme } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const [outArg, theme] = process.argv.slice(-2);
const out = path.resolve(outArg);
const W = 1120;
const H = 800;

process.env.SPURT_SAMPLE = "1";
// "Claude Code" in the pictures is the stand-in from scripts/fixtures, so each sign-in state can be shown.
const claudeState = path.join(os.tmpdir(), `spurt-shots-claude-${process.pid}`);
const stub = path.join(__dirname, "fixtures", "claude-stub.sh");
Object.assign(process.env, { SPURT_CLAUDE: stub, SPURT_STUB_STATE: claudeState, SPURT_SIGNIN: "run" });
fs.writeFileSync(claudeState, "ok");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "spurt-shots-")));
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
  nativeTheme.themeSource = theme === "dark" ? "dark" : "light";
  fs.mkdirSync(out, { recursive: true });
  win.setContentSize(W * SCALE, H * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.on("console-message", (e) => e.level === "error" && console.log("PAGE ERROR", e.message));
  const until = async (code, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error("timeout: " + code);
  };
  // The window's own buttons are drawn by macOS and missing from a capture; paint them in.
  const chrome = `(() => { if (document.getElementById('shotChrome')) return;
    const d = document.createElement('div'); d.id = 'shotChrome';
    Object.assign(d.style, { position: 'fixed', left: '18px', top: '20px', display: 'flex', gap: '8px', zIndex: 99, pointerEvents: 'none' });
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const s = document.createElement('span');
      Object.assign(s.style, { width: '12px', height: '12px', borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 .5px rgb(0 0 0 / .18)' }); d.append(s); }
    document.body.append(d); })()`;
  const ready = async () => {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    await js(chrome);
  };
  const shot = async (name) => {
    await sleep(300);
    fs.writeFileSync(path.join(out, `${name}-${theme}.png`), await capture(win));
    console.log("shot", name, theme);
  };
  const nav = (route) => js(`window.__nav(${JSON.stringify(route)})`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const type = (selector, text) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  const exam = { name: "exam", id: "sample-math" };
  const draft = { name: "Mathematik: Quadratische Funktionen", dateMode: "days", days: 6 };
  const quizFeedback = async () => {
    await nav({ name: "quiz", id: "sample-math", what: { kind: "topic", topicId: "t1" } });
    await until(`!!document.querySelector('.choice')`);
    await click(".choice");
    await click("#check");
    await until(`!!document.querySelector('.feedback')`);
    await click("#next");
    await until(`!!document.querySelector('textarea.answer')`);
    await type("textarea.answer", "f(x) = (x − 3)² + 4, also S(3 | 4)");
    await click("#check");
    await until(`!!document.querySelector('.feedback.partly')`);
  };
  const wizard = async (step, name) => {
    await nav({ name: "home" });
    await nav({ name: "new", step, draft });
    await until(`!!document.querySelector('.question')`);
    await shot(name);
  };
  const tab = async (name, suffix = "") => {
    await nav({ ...exam, tab: name });
    await shot(name + suffix);
  };

  try {
    await ready();
    // The theme is also set in the app's own settings, or the next change there would put it back to the Mac's.
    await js(`window.spurt.setSettings({ appearance: ${JSON.stringify(theme === "dark" ? "dark" : "light")} })`);
    await shot("home");
    await wizard(1, "new-name");
    await wizard(2, "new-when");
    await wizard(3, "new-time");
    await wizard(4, "new-grade");
    await wizard(5, "new-pace");
    await nav({ name: "exam", id: "sample-m323", tab: "material" });
    await shot("material-empty");
    for (const name of ["material", "today", "strategy", "plan", "practice"]) await tab(name);
    await nav({ name: "settings" });
    await until(`!!document.querySelector('.ai .provider .pace')`);
    await click(".ai .provider:nth-child(2) .pace");
    await until(`!!document.querySelector('#key')`);
    await shot("settings");
    if (theme === "light") {
      // Claude Code on this Mac, in each state the person can meet.
      const state = async (word, name, wanted = word) => {
        fs.writeFileSync(claudeState, word);
        await click(".ai .provider:nth-child(2) .pace");
        await click(".ai .provider:nth-child(1) .pace");
        await until(`document.querySelector('.cc-state')?.dataset.state === '${wanted}'`);
        await js(`document.querySelector('.ai h2').scrollIntoView({ block: 'start' })`);
        await shot(name);
      };
      await state("ok", "claude-signed-in");
      await state("expired", "claude-expired");
      await state("signedOut", "claude-signed-out");
      await click("#ccSignIn");
      await until(`document.querySelector('.cc-state')?.dataset.state === 'waiting'`);
      await js(`document.querySelector('.ai h2').scrollIntoView({ block: 'start' })`);
      await shot("claude-waiting");
      await until(`document.querySelector('.cc-state')?.dataset.state === 'ok'`, 20000);
      process.env.SPURT_CLAUDE = path.join(os.tmpdir(), "no-claude-here");
      await state("ok", "claude-missing", "missing");
      process.env.SPURT_CLAUDE = stub;
      fs.writeFileSync(claudeState, "ok");
      await click(".ai .provider:nth-child(2) .pace");
    }
    await nav({ name: "home" });
    await quizFeedback();
    await shot("quiz");

    if (theme === "dark") {
      // Switch to German the way a person does, in Settings.
      await nav({ name: "settings" });
      await until(`document.querySelectorAll('.setting').length === 2`);
      await js(`document.querySelector('.setting').querySelectorAll('button')[1].click()`);
      await until(`document.documentElement.lang === 'de'`);
      await nav({ name: "home" });
      await shot("home-de");
      for (const name of ["material", "today", "strategy", "plan"]) await tab(name, "-de");
      await quizFeedback();
      await shot("quiz-de");
    }
  } catch (e) {
    console.log("FAIL", e.message);
    process.exitCode = 1;
  }
  app.quit();
});

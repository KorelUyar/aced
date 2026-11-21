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
    await nav({ name: "quiz", id: "sample-math" });
    await until(`!!document.querySelector('.choice')`);
    await click(".choice");
    await click("#check");
    await click("#next");
    await until(`!!document.querySelector('textarea.answer')`);
    await type("textarea.answer", "f(x) = (x − 3)² + 4, also S(3 | 4)");
    await click("#check");
    await until(`!!document.querySelector('.feedback')`);
  };
  const wizard = async (step, name) => {
    await nav({ name: "home" });
    await nav({ name: "new", step, draft });
    await until(`!!document.querySelector('.question')`);
    await shot(name);
  };

  try {
    await ready();
    await shot("home");
    await wizard(1, "new-name");
    await wizard(2, "new-when");
    await wizard(3, "new-time");
    await wizard(4, "new-grade");
    await wizard(5, "new-pace");
    await nav({ ...exam, tab: "today" });
    await shot("today");
    await nav({ ...exam, tab: "strategy" });
    await shot("strategy");
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
      await nav({ ...exam, tab: "today" });
      await shot("today-de");
      await nav({ ...exam, tab: "strategy" });
      await shot("strategy-de");
      await quizFeedback();
      await shot("quiz-de");
    }
  } catch (e) {
    console.log("FAIL", e.message);
    process.exitCode = 1;
  }
  app.quit();
});

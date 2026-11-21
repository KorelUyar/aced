// Takes the pictures in docs/shots, in a hidden window at 2x:
//
//   node_modules/.bin/electron scripts/shots.js <outDir> <light|dark>             the invented sample exams:
//                                              home, the final exam, material and settings, a new exam, settings
//   node_modules/.bin/electron scripts/shots.js <outDir> <light|dark> <profile>   a real exam with a real book:
//                                              the plan with the book, the formula sheet, the helper, a result
//
// <profile> is a data folder the app has written (scripts/e2e.js leaves one in <its outDir>/data).
// It is copied first, so taking pictures changes nothing in it. The helper's answer in the
// picture is a real one: with a profile, this asks the provider that profile names once.
const { app, nativeTheme } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const [outArg, theme = "light", profile] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("shots.js"));
const out = path.resolve(outArg || "docs/shots");
fs.mkdirSync(out, { recursive: true });
if (profile) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-shots-"));
  fs.cpSync(path.resolve(profile), copy, { recursive: true });
  app.setPath("userData", copy);
} else {
  process.env.SPURT_SAMPLE = "1";
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-shots-"));
  app.setPath("userData", scratch);
  // "Claude Code" in the Settings picture is the stand-in from the tests, signed in: no real login is looked at.
  fs.writeFileSync(path.join(scratch, "claude-state"), "ok");
  Object.assign(process.env, { SPURT_CLAUDE: path.join(__dirname, "fixtures", "claude-stub.sh"), SPURT_STUB_STATE: path.join(scratch, "claude-state") });
}
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector, timeout) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, timeout);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  const type = (selector, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // The window's own buttons are not part of a capture: three dots stand in for them.
  const lights = `(() => { if (document.getElementById('shotChrome')) return;
    const d = document.createElement('div'); d.id = 'shotChrome';
    Object.assign(d.style, { position: 'fixed', left: '18px', top: '20px', display: 'flex', gap: '8px', zIndex: 99, pointerEvents: 'none' });
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const s = document.createElement('span');
      Object.assign(s.style, { width: '12px', height: '12px', borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 .5px rgb(0 0 0 / .18)' }); d.append(s); }
    document.body.append(d); })()`;
  const shot = async (name) => {
    await js(lights);
    await sleep(450);
    fs.writeFileSync(path.join(out, `${name}-${theme}.png`), await capture(win));
    console.log("shot", `${name}-${theme}`);
  };
  const lang = (code) => js(`window.spurt.setSettings({ lang: ${JSON.stringify(code)} }).then(() => window.dispatchEvent(new Event('focus')))`).then(() => sleep(500));

  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    nativeTheme.themeSource = theme;
    await js(`window.spurt.setSettings({ appearance: ${JSON.stringify(theme)}, lang: 'en' }).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(500);
    if (profile) {
      await click(".exam-card");
      await until(`!!document.querySelector('.path .step')`);
      await click(".step.now .jump");
      await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 120000);
      await sleep(600);
      await shot("exam");
      await click(".tabs.panels button:nth-child(2)");
      await until(`!!document.querySelector('.formula')`, 300000);
      await shot("formulas");
      await click(".tabs.panels button:nth-child(1)");
      await click("#helperToggle");
      await click(".drawer .idea");
      await until(`!!document.querySelector('.drawer .answered') || !!document.querySelector('.drawer .problem-box')`, 300000);
      if (await js(`!!document.querySelector('.drawer .page-link')`)) {
        await click(".drawer .page-link");
        await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 120000);
      }
      await sleep(600);
      await shot("helper");
      await click(".drawer .mini");
      if (await js(`!!document.querySelector('#finalSee')`)) {
        await click("#finalSee");
        await until(`!!document.querySelector('.result-head')`);
        await shot("result");
      }
    } else {
      await until(`document.querySelectorAll('.exam-card').length === 3`);
      await shot("home");
      await click(".exam-card");
      await until(`!!document.querySelector('.path .step')`);
      await click(".tabs.panels button:nth-child(2)");
      await until(`!!document.querySelector('.formula')`);
      await shot("plan");
      await click("#finalStart");
      await until(`document.querySelectorAll('.question-card').length === 6`);
      const typed = ["2", "x1 = 2; x2 = 3", null, "100 m²"];
      for (let i = 0; i < typed.length; i++) {
        if (typed[i] === null) await click(`.question-card:nth-child(${i + 1}) .choice`);
        else await type(`.question-card:nth-child(${i + 1}) input`, typed[i]);
      }
      await shot("final");
      await js(`window.__nav({ name: 'setup', id: 'sample-math' })`);
      await until(`!!document.querySelector('.facts')`);
      await shot("setup");
      await js(`window.__nav({ name: 'new', step: 2, draft: { name: 'Geschichte: Kalter Krieg' } })`);
      await until(`!!document.querySelector('input[type=date]')`);
      await shot("new-when");
      await js(`window.__nav({ name: 'new', step: 4, draft: { name: 'Geschichte: Kalter Krieg' } })`);
      await until(`!!document.querySelector('.grade-range')`);
      await shot("new-grade");
      await js(`window.__nav({ name: 'settings', from: { name: 'home' } })`);
      await click(".ai .provider:nth-child(1) .pace");
      await until(`!!document.querySelector('.cc-state')`);
      await sleep(1200);
      await shot("settings");
      if (theme === "dark") {
        // German, once: the interface follows the Mac's language or the choice in Settings.
        await lang("de");
        await js(`window.__nav({ name: 'exam', id: 'sample-math' })`);
        await until(`!!document.querySelector('.path .step')`);
        await shot("plan-de");
        await lang("en");
      }
    }
  } catch (e) {
    console.log("FAIL", e.message);
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
});

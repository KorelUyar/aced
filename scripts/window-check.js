// The few things only a real, visible window can show. It opens the app for a few seconds
// and closes it again:
//
//   node_modules/.bin/electron scripts/window-check.js
//
// - where macOS puts the traffic lights, against the app's own title bar
// - that the window cannot be made smaller than its minimum size
// - that the date field takes typing and opens its calendar, and the grade slider takes the arrow keys
const { app } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "spurt-window-")));
let found;
const first = new Promise((resolve) => (found = resolve));
const mainFile = path.join(__dirname, "..", "main.js");
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  const loaded = load.call(this, request, parent, ...rest);
  if (request === "electron" && parent && parent.filename === mainFile) {
    return new Proxy(loaded, {
      get: (target, key) =>
        key === "BrowserWindow"
          ? class extends target.BrowserWindow {
              constructor(options) {
                super(options);
                found(this);
              }
            }
          : target[key],
    });
  }
  return loaded;
};
require(mainFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = await first;
  const wc = win.webContents;
  const js = (code, gesture = false) => wc.executeJavaScript(code, gesture);
  try {
    await new Promise((resolve) => (win.isVisible() ? resolve() : win.once("show", resolve)));
    for (let i = 0; i < 50 && !(await js(`!!window.__nav`).catch(() => false)); i++) await sleep(100);

    const lights = win.getWindowButtonPosition();
    const bar = await js(`(() => { const b = document.querySelector('.bar').getBoundingClientRect(); const f = document.querySelector('.bar > *').getBoundingClientRect(); return { height: b.height, firstLeft: f.left } })()`);
    // The three buttons are 12 pt high and take about 52 pt of width from their left edge.
    console.log("traffic lights at", JSON.stringify(lights), "| title bar", bar.height, "pt high, first item starts at", Math.round(bar.firstLeft), "pt");
    assert.ok(Math.abs(lights.y + 6 - bar.height / 2) <= 2, "the lights sit in the vertical middle of the title bar");
    assert.ok(bar.firstLeft >= lights.x + 52 + 8, "nothing in the title bar runs under the lights");

    const min = win.getMinimumSize();
    win.setSize(400, 300);
    await sleep(250);
    const small = win.getSize();
    console.log("minimum size", min.join("x"), "| asked for 400x300, got", small.join("x"));
    assert.deepEqual(small, min, "the window stops at its minimum size");
    assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true, "nothing is cut off sideways at the minimum size");
    win.setSize(1120, 800);

    await js(`window.__nav({ name: 'new', step: 2, draft: { name: 'Check' } })`);
    await sleep(400);
    win.focus();
    wc.focus();
    await js(`document.querySelector('input[type=date]').focus()`);
    const before = await js(`document.querySelector('input[type=date]').value`);
    for (const k of ["2", "8"]) {
      wc.sendInputEvent({ type: "keyDown", keyCode: k });
      wc.sendInputEvent({ type: "char", keyCode: k });
      wc.sendInputEvent({ type: "keyUp", keyCode: k });
      await sleep(80);
    }
    const after = await js(`document.querySelector('input[type=date]').value`);
    console.log("date field:", before, "->", after, "after typing 28");
    assert.ok(after && after !== before, "the date field takes typing");
    const picker = await js(`(() => { try { document.querySelector('input[type=date]').showPicker(); return 'opened' } catch (e) { return 'error: ' + e.message } })()`, true);
    await sleep(700);
    console.log("calendar:", picker, "| at minimum width the wizard still fits:", await js(`document.querySelector('.wizard-foot').getBoundingClientRect().right <= window.innerWidth`));
    assert.equal(picker, "opened");
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });

    // The grade slider with the arrow keys.
    await js(`window.__nav({ name: 'home' })`);
    await js(`window.__nav({ name: 'new', step: 4, draft: { name: 'Check' } })`);
    await sleep(400);
    await js(`document.querySelector('.grade-range').focus()`);
    wc.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await sleep(150);
    console.log("grade after one arrow key to the right:", await js(`document.querySelector('.grade').textContent`));
    assert.equal(await js(`document.querySelector('.grade').textContent`), "5.5", "the arrow keys move the grade");
    console.log("ok: real window");
  } catch (err) {
    console.log("FAIL", err.message);
    process.exitCode = 1;
  }
  app.quit();
});

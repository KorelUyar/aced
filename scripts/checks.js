// Things a click-through does not show, checked in a hidden window on an empty start:
//
//   node_modules/.bin/electron scripts/checks.js [folder for pictures]
//
// - the new-exam flow with the keyboard only (Tab, Enter, arrow keys), with a visible focus ring
// - "in total" time and the percent scale
// - reduced motion: no view animation, no spinning
const { app } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const shots = process.argv.slice(2).find((a) => !a.startsWith("--") && !a.endsWith("checks.js"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "aced-checks-"));
app.setPath("userData", userData);
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  const until = async (code, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(80);
    }
    throw new Error("timeout: " + code);
  };
  const key = async (keyCode) => {
    wc.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
    if (/^[0-9]$/.test(keyCode)) wc.sendInputEvent({ type: "char", keyCode });
    wc.sendInputEvent({ type: "keyUp", keyCode });
    await sleep(90);
  };
  const focused = () => js(`(() => { const el = document.activeElement; return el ? (el.id || el.className || el.tagName) + '|' + (el.textContent || '').trim().slice(0, 30) : '' })()`);
  const saved = () => JSON.parse(fs.readFileSync(path.join(userData, "aced.json"), "utf8"));
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(shots, name + ".png"), await capture(win));
  };

  try {
    await until(`!!window.__nav && !!document.querySelector('.empty')`);
    win.setContentSize(1120 * SCALE, 800 * SCALE);
    wc.setZoomFactor(SCALE);
    wc.focus();

    // ---- keyboard only
    for (let i = 0; i < 6 && !/New exam/.test(await focused()); i++) await key("Tab");
    assert.match(await focused(), /New exam/, "Tab reaches the primary action");
    assert.equal(await js(`getComputedStyle(document.activeElement).outlineStyle`), "solid", "the focused button shows a ring");
    await key("Enter");
    await until(`!!document.querySelector('.question .field')`);
    assert.equal(await js(`document.activeElement === document.querySelector('.question .field')`), true, "the name field has the focus");
    await wc.insertText("Physik: Optik");
    await sleep(120);
    await key("Enter"); // -> when
    await until(`!!document.querySelector('input[type=date]')`);
    // (Typing into the date field needs a real, focused window: scripts/window-check.js does that.)
    await key("Enter"); // -> time
    await until(`!!document.querySelector('.chips')`);
    await key("Enter"); // -> grade
    await until(`!!document.querySelector('.grade-range')`);
    for (let i = 0; i < 8 && !/grade-range/.test(await focused()); i++) await key("Tab");
    assert.match(await focused(), /grade-range/, "Tab reaches the grade slider (its arrow keys are checked in window-check.js)");
    await key("Enter"); // -> pace
    await until(`!!document.querySelector('.paces')`);
    await key("Enter"); // create
    await until(`!!document.querySelector('.drop.first')`);
    assert.deepEqual([saved().exams[0].name, saved().exams[0].target], ["Physik: Optik", 5]);
    console.log("ok: new exam with the keyboard only");

    // ---- "in total" and percent
    await js(`window.__nav({ name: 'home' })`);
    await js(`window.__nav({ name: 'new', step: 3, draft: { name: 'Geschichte: Kalter Krieg', dateMode: 'days', days: 10 } })`);
    await until(`!!document.querySelector('.chips')`);
    await js(`document.querySelectorAll('.seg button')[1].click()`);
    await until(`!!document.querySelector('.stepper')`);
    for (let i = 0; i < 2; i++) {
      await js(`document.querySelectorAll('.stepper button')[1].click()`);
      await sleep(80);
    }
    assert.equal(await js(`document.querySelector('.stepper output').textContent`), "12");
    assert.match(await js(`document.querySelector('.hint').textContent`), /about 1 h 12 min a day over 10 days/, "time in total is shared out to the minute");
    // More than sixteen hours a day is not on offer: with one day left, the hours stop at 16.
    await js(`window.__nav({ name: 'home' })`);
    await js(`window.__nav({ name: 'new', step: 3, draft: { name: 'Morgen', dateMode: 'days', days: 1, timeMode: 'total', totalHours: 200 } })`);
    await until(`document.querySelector('.stepper output')?.textContent === '16'`);
    assert.match(await js(`document.querySelector('.hint').textContent`), /More does not fit/);
    await js(`window.__nav({ name: 'home' })`);
    await js(`window.__nav({ name: 'new', step: 3, draft: { name: 'Geschichte: Kalter Krieg', dateMode: 'days', days: 10, timeMode: 'total', totalHours: 12 } })`);
    await until(`document.querySelector('.stepper output')?.textContent === '12'`);
    await shot("check-total");
    await js(`document.querySelector('.wizard-foot .btn.primary').click()`);
    await until(`!!document.querySelector('.grade-range')`);
    await js(`document.querySelectorAll('.grade-foot .seg button')[2].click()`);
    await until(`document.querySelector('.grade').textContent === '80%'`);
    await js(`(() => { const el = document.querySelector('.grade-range');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '65');
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`document.querySelector('.grade').textContent === '65%'`);
    assert.deepEqual(await js(`[...document.querySelectorAll('.grade-ticks span')].map((s) => s.textContent)`), ["0", "25", "50", "75", "100"]);
    await shot("check-percent");
    // German scale: 1 is best and sits at the right end.
    await js(`document.querySelectorAll('.grade-foot .seg button')[1].click()`);
    await until(`document.querySelector('.grade').textContent === '2.0'`);
    assert.equal(await js(`document.querySelector('.grade-range').dir`), "rtl");
    assert.deepEqual(await js(`[...document.querySelectorAll('.grade-ticks span')].map((s) => s.textContent)`), ["6", "5", "4", "3", "2", "1"]);
    await shot("check-german");
    await js(`document.querySelectorAll('.grade-foot .seg button')[2].click()`);
    await sleep(100);
    await js(`document.querySelector('.wizard-foot .btn.primary').click()`);
    await until(`!!document.querySelector('.paces')`);
    await js(`document.querySelector('.wizard-foot .btn.primary').click()`);
    await until(`!!document.querySelector('.drop.first')`);
    const e = saved().exams[0];
    assert.deepEqual([e.time, e.scale, e.target], [{ mode: "total", minutes: 720 }, "pct", 80]);
    console.log("ok: time in total, percent and German scale");

    // ---- the wizard never gets stuck
    const go = ".wizard-foot .btn.primary";
    const disabled = () => js(`document.querySelector(${JSON.stringify(go)}).disabled`);
    const setDate = (value) =>
      js(`(() => { const el = document.querySelector('input[type=date]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await js(`window.__nav({ name: 'home' })`);
    await js(`window.__nav({ name: 'new', step: 2, draft: { name: 'Datum' } })`);
    await until(`!!document.querySelector('input[type=date]')`);
    // A date that is none (what a year with five digits leaves in the field): said, and nothing freezes.
    await setDate("");
    await until(`/Pick the date/.test(document.querySelector('.hint').textContent)`);
    assert.equal(await disabled(), true);
    await js(`window.__nav({ name: 'home' })`);
    await js(`window.__nav({ name: 'new', step: 2, draft: { name: 'Datum', date: '20266-12-05' } })`);
    await until(`/Pick the date/.test(document.querySelector('.hint')?.textContent || '')`);
    await js(`document.querySelectorAll('.question .seg button')[1].click()`); // the other way to say when still works
    await until(`!!document.querySelector('.stepper')`);
    await js(`document.querySelectorAll('.question .seg button')[0].click()`);
    await until(`!!document.querySelector('input[type=date]')`);
    const far = new Date(Date.now() + 1200 * 864e5).toLocaleDateString("sv");
    await setDate(far);
    await until(`/more than two years away/.test(document.querySelector('.hint').textContent)`);
    assert.equal(await disabled(), true, "a date decades away is not accepted");
    await setDate(new Date(Date.now() + 20 * 864e5).toLocaleDateString("sv"));
    await until(`/in 20 days/.test(document.querySelector('.hint').textContent) || /20/.test(document.querySelector('.hint').textContent)`);
    assert.equal(await disabled(), false, "a corrected date lets the person go on");
    await js(`document.querySelector('.wizard-foot .btn.plain').click()`); // Back works too
    await until(`!!document.querySelector('.question .field:not([type=date])')`);
    assert.equal(await js(`document.querySelector('.question .field').maxLength`), 120, "a name cannot grow past what is kept");
    await key("Enter");
    await key("Enter"); // -> time
    await until(`!!document.querySelector('.chips')`);
    // Arrow keys move through the choices, and Enter goes on from a focused choice.
    await js(`document.querySelector('.chips [aria-checked="true"]').focus()`);
    const chosen = () => js(`document.querySelector('.chips [aria-checked="true"]').textContent`);
    const first = await chosen();
    await key("Right");
    await until(`document.querySelector('.chips [aria-checked="true"]').textContent !== ${JSON.stringify(first)}`);
    assert.equal(await js(`document.activeElement.getAttribute('aria-checked')`), "true", "the keyboard stays on the choice it made");
    await key("Enter");
    await until(`!!document.querySelector('.grade-range')`);
    // Escape, or the cross at the top, leaves at any step.
    assert.ok(await js(`!!document.querySelector('#wizardCancel')`));
    await key("Escape");
    await until(`!!document.querySelector('.exam-card, .empty')`);
    console.log("ok: the wizard: dates that are none or far away, arrow keys, Enter, Escape");

    // ---- German: nothing is cut off in the grade step
    await js(`window.aced.setSettings({ lang: 'de' }).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(400);
    await js(`window.__nav({ name: 'new', step: 4, draft: { name: 'Noten' } })`);
    await until(`!!document.querySelector('.grade-foot .seg')`);
    await shot("check-grade-de");
    assert.deepEqual(await js(`[...document.querySelectorAll('.grade-foot .seg button')].map((b) => b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight <= b.clientHeight + 1)`), [true, true, true], "the scale names fit their buttons");
    assert.equal(await js(`(() => { const s = document.querySelector('.grade-foot'); return s.scrollWidth <= s.clientWidth + 1; })()`), true);
    await js(`window.aced.setSettings({ lang: 'en' }).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(300);
    await js(`window.__nav({ name: 'home' })`);
    console.log("ok: German labels fit");

    // ---- reduced motion
    wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await js(`window.__nav({ name: 'home' })`);
    await until(`!!document.querySelector('.exam-card')`);
    assert.equal(await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    assert.equal(await js(`getComputedStyle(document.querySelector('.view')).animationName`), "none", "views do not animate in");
    assert.equal(await js(`getComputedStyle(document.querySelector('.exam-card')).transitionDuration`), "0s", "cards do not move on hover");
    wc.debugger.detach();
    console.log("ok: reduced motion is respected");
  } catch (err) {
    const where = await js(`[document.querySelector('.wizard-top .muted')?.textContent, document.querySelector('.hint')?.textContent, document.activeElement?.outerHTML.slice(0, 120)].join(' | ')`).catch(() => "");
    console.log("FAIL", err.message, "| on screen:", where);
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
});

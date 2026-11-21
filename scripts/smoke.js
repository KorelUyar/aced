// Clicks through the real app in a hidden window and checks what happens:
//
//   node_modules/.bin/electron scripts/smoke.js           empty start: create an exam, check it is saved
//   node_modules/.bin/electron scripts/smoke.js sample    sample exams: finish today's tasks and a quiz
const { app } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, hideWindowsOf, sleep } = require("./hidden");

const sample = process.argv[process.argv.length - 1] === "sample";
if (sample) process.env.SPURT_SAMPLE = "1";
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-smoke-"));
app.setPath("userData", userData);
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
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
      await until(`!!document.querySelector('.exam-head')`);
      assert.equal(await text(".exam-head h1"), "Chemie: Säuren und Basen");
      const saved = JSON.parse(fs.readFileSync(path.join(userData, "spurt.json"), "utf8"));
      assert.equal(saved.exams.length, 1);
      const e = saved.exams[0];
      assert.deepEqual([e.scale, e.target, e.pace, e.time.mode, e.time.minutes], ["de", 2, "efficient", "perDay", 30]);
      await click(".bar-btn"); // back to the exams
      await until(`document.querySelectorAll('.exam-card').length === 1`);
      console.log("ok: created an exam from an empty start, saved to spurt.json");
    } else {
      await until(`document.querySelectorAll('.exam-card').length === 3`);
      await click(".exam-card");
      await click(".tabs button:nth-child(2)");
      await until(`document.querySelectorAll('.topic').length === 4`);
      await click(".dropped > button");
      await until(`document.querySelectorAll('.dropped li').length === 2`);
      await click(".tabs button:nth-child(1)");
      await click(".next .btn.plain"); // mark the exercises as done
      await click(".next .btn.primary"); // the quiz is next: start it
      await click(".choice:nth-child(2)"); // a wrong choice
      await click("#check");
      await until(`!!document.querySelector('.feedback.wrong')`);
      await click("#next");
      await type("textarea.answer", "(x − 3)² − 4");
      await click("#check");
      await until(`!!document.querySelector('.feedback.partly')`);
      await click("#next");
      await click(".choice:nth-child(1)");
      await click("#check");
      await until(`!!document.querySelector('.feedback.right')`);
      await click("#next");
      assert.equal(await text(".result .grade"), "3/5");
      await click(".result .btn");
      await until(`!!document.querySelector('.next')`);
      assert.equal(await js(`document.querySelectorAll('.next .btn').length`), 0, "nothing left to do today");
      assert.ok(!fs.existsSync(path.join(userData, "spurt.json")), "sample data is never written to disk");
      console.log("ok: strategy, today's tasks and a quiz on the sample exams");
    }
    assert.deepEqual(errors, [], "no errors in the page");
  } catch (e) {
    console.log("FAIL", e.message, errors.join(" | "));
    process.exitCode = 1;
  }
  app.quit();
});

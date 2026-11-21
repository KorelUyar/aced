// Asks the real Anthropic and OpenRouter services with a key that is obviously not one, through
// the app's own Settings, and shows what goes out and what the person is told:
//
//   node_modules/.bin/electron scripts/wrong-key.js
//
// One tiny request each ('Answer with {"ok": true}'), no material, nothing personal.
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, hideWindowsOf, sleep } = require("./hidden");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "spurt-wrong-key-")));
quiet();

// Note every request the main process sends: where to, and the names (not the values) of its headers.
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
  let body = {};
  try {
    body = JSON.parse(init.body);
  } catch {
    // not JSON
  }
  const res = await realFetch(input, init);
  sent.push({
    url,
    status: res.status,
    headers: [...headers.keys()].sort(),
    agent: headers.get("user-agent") || "(the runtime's default)",
    title: headers.get("x-title"),
    model: body.model,
    chars: JSON.stringify(body.messages || "").length,
  });
  return res;
};

const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout: " + code);
  };
  const type = (selector, text) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  try {
    await until(`!!window.__nav`);
    await js(`window.__nav({ name: 'settings' })`);
    for (const [n, name, key] of [
      [2, "Anthropic", "sk-ant-api03-not-a-real-key-000000000000"],
      [3, "OpenRouter", "sk-or-v1-not-a-real-key-000000000000"],
    ]) {
      await until(`!!document.querySelector('.ai .provider .pace')`);
      await js(`document.querySelector('.ai .provider:nth-child(${n}) .pace').click()`);
      await until(`!!document.querySelector('#key')`);
      await type("#key", key);
      await until(`!!document.querySelector('#saveKey')`);
      await js(`document.querySelector('#saveKey').click()`);
      await until(`!document.querySelector('#test').disabled`);
      sent.length = 0;
      await js(`document.querySelector('#test').click()`);
      await until(`(document.querySelector('.ai-fields [role=status]')?.textContent || '').length > 3 && !/Testing/.test(document.querySelector('#test').textContent)`);
      const message = await js(`document.querySelector('.ai-fields [role=status]').textContent`);
      const last = sent.at(-1) || {};
      console.log(`${name}: "${message}"`);
      console.log(`   requests ${sent.length} | ${last.url} -> HTTP ${last.status} | model ${last.model} | message size ${last.chars} characters`);
      console.log(`   headers: ${(last.headers || []).join(", ")} | user agent: ${last.agent}${last.title ? " | X-Title: " + last.title : ""}`);
      if (!/key was not accepted/i.test(message)) process.exitCode = 1;
    }
    console.log(process.exitCode ? "FAIL" : "ok: both services refuse the key and the app says so");
  } catch (err) {
    console.log("FAIL", err.message);
    process.exitCode = 1;
  }
  app.quit();
});

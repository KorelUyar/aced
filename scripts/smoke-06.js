// 0.6 in the app, in a hidden window, with a fresh profile and a share service on this Mac:
//
//   node_modules/.bin/electron scripts/smoke-06.js
//
// - The share window: what this Mac has not set up says so; AirDrop, Messages, Mail and "Copy
//   file" get an Aced file that outlives the app (the helper itself is stood in for here: it
//   would put windows on the screen and the file on the clipboard); "Copy link" locks the file,
//   puts it on the service and shows the link.
// - The friend: the link opened as macOS hands it over (aced://), fetched and opened at 0%; the
//   same link again asks; hostile, broken and run-out links make no exam.
// - Writing in the book with the mouse: pen, highlighter, a note, the eraser, undo and redo,
//   zoom, kept on this Mac and back after the book is opened again; gone with the exam.
const { app, dialog, BrowserWindow } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { SCALE, quiet, hideWindowsOf, sleep } = require("./hidden");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "aced-smoke-06-"));
app.setPath("userData", userData);
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);

// The clipboard as main.js sees it: only what it writes as text is caught here.
const clip = { text: "" };
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  const loaded = load.call(this, request, parent, ...rest);
  if (request === "electron" && parent && parent.filename === mainFile) {
    const clipboard = new Proxy(loaded.clipboard, { get: (target, key) => (key === "writeText" ? (text) => (clip.text = text) : target[key]) });
    return new Proxy(loaded, { get: (target, key) => (key === "clipboard" ? clipboard : target[key]) });
  }
  return loaded;
};
// The helper's ways, stood in for: what they were handed is noted.
const macShare = require("../src/mac-share");
const handed = [];
macShare.services = async () => ({ airdrop: true, messages: false, mail: true });
macShare.send = async (way, file) => (handed.push({ way, file, bytes: fs.readFileSync(file) }), way === "messages" ? { missing: true } : { opened: true });
macShare.copyFile = async (file) => void handed.push({ way: "copy", file, bytes: fs.readFileSync(file) });

const service = require("../service/server");
const link = require("../src/link");
require(mainFile);

app.whenReady().then(async () => {
  const share = await service.start({ ...service.settings({}), port: 0, dataDir: path.join(userData, "service") }, { quiet: true });
  // (main.js reads it whenever a link is made or opened)
  process.env.ACED_LINK_HOST = `http://127.0.0.1:${share.port}`;
  const win = await window;
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const errors = [];
  win.webContents.on("console-message", (e) => (e.level === "error" || e.level === 3) && errors.push(e.message));
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(120);
    }
    throw new Error("timeout: " + code);
  };
  const waitFor = async (check, what, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out: " + what);
      await sleep(100);
    }
  };
  const click = async (selector) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  const toast = () => js(`document.querySelector('.toast')?.textContent || ''`);
  const store = require("../src/store");
  let step = "start";
  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    step = "an exam with a real book";
    const book = path.join(userData, "Mathematik 1.pdf");
    const printer = new BrowserWindow({ show: false });
    const pages = Array.from({ length: 6 }, (_, i) => `<section style="break-after:page;padding:60px;font:16px/1.6 serif"><h1>Seite ${i + 1}</h1>${"<p>Eine quadratische Funktion hat die Form f(x) = ax² + bx + c.</p>".repeat(12)}</section>`).join("");
    await printer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<meta charset="utf-8">${pages}`));
    fs.writeFileSync(book, await printer.webContents.printToPDF({}));
    printer.destroy();
    const sample = require("../src/sample").exams("en")[0];
    const created = await js(`window.aced.createExam(${JSON.stringify({ name: sample.name, date: sample.date, time: sample.time, scale: sample.scale, target: sample.target, pace: sample.pace })})`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(400);
    await js(`window.__nav({ name: 'setup', id: ${JSON.stringify(created.id)} })`);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] });
    await click("#chooseFiles");
    await until(`document.querySelectorAll('.materials li').length === 1`, 120000);
    await js(`window.aced.addText(${JSON.stringify(created.id)}, 'notes', 'Meine Notizen', 'Scheitelpunkt: d = -b / 2a. Diskriminante: b² - 4ac.')`);
    const bookItem = store.exam(created.id).materials[0];
    const strategy = structuredClone(sample.strategy);
    for (const t of strategy.topics)
      for (const st of t.steps) {
        if (!st.material) continue;
        st.material = bookItem.id;
        if (st.kind === "read") Object.assign(st, { from: 2, to: 3 });
        if (st.kind === "solve") st.page = 2;
      }
    store.change(created.id, (e) => {
      e.strategy = strategy;
      e.done = { "t1/r0": { date: "2026-11-21", minutes: 15, at: 1 } };
    });
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(400);
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 60000);

    // ------------------------------------------------ the share window
    step = "the share window";
    await click("#shareOpen");
    await until(`!!document.querySelector('.share-win') && !!document.querySelector('#share-messages.missing')`);
    assert.equal(await js(`document.querySelectorAll('.sw-tile.missing').length`), 1, "only Messages is not set up here");
    await click("#share-messages");
    assert.match(await js(`document.querySelector('.sw-problem')?.textContent || ''`), /Messages is not set up/);
    assert.equal(handed.length, 0, "a way that is not set up is not tried");
    // AirDrop: the Aced file, in a folder that outlives the app
    await click("#share-airdrop");
    await until(`!document.querySelector('.share-win')`);
    assert.equal(handed[0].way, "airdrop");
    assert.match(path.basename(path.dirname(handed[0].file)), /^aced-sent-/);
    assert.equal(path.extname(handed[0].file), ".aced");
    assert.match(await toast(), /AirDrop is open/);
    // what went is an Aced file: the notes (ticked by default), the book only as its fingerprint
    const sent = share_unpack(handed[0].file);
    assert.deepEqual(sent.materials.map((m) => [m.kind, m.missing === true]), [["book", true], ["notes", false]]);
    // Copy file
    await click("#shareOpen");
    await click("#share-copy");
    await until(`!document.querySelector('.share-win')`);
    assert.equal(handed[1].way, "copy");
    assert.match(await toast(), /Paste it into WhatsApp/);
    // the material choice holds for every way: notes left out
    await click("#shareOpen");
    await click("#shareChange");
    await js(`document.querySelectorAll('.share-material input')[1].click()`);
    await sleep(150);
    assert.match(await js(`document.querySelector('.sw-along p').textContent`), /0 of 2 files/);
    await click("#share-mail");
    await until(`!document.querySelector('.share-win')`);
    assert.equal(handed[2].way, "mail");
    assert.deepEqual(share_unpack(handed[2].file).materials.map((m) => m.kind), ["book"], "the unticked notes stay home");

    // ------------------------------------------------ Copy link
    step = "copy link";
    await click("#shareOpen");
    await click("#share-link");
    await until(`!!document.querySelector('.sw-link.done')`, 60000);
    const url = await js(`document.querySelector('.sw-url').value`);
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${share.port}/s/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$`));
    assert.equal(clip.text, url, "the link is on the clipboard");
    assert.equal(share.stored().count, 1);
    const kept = fs.readFileSync(path.join(userData, "service", fs.readdirSync(path.join(userData, "service"))[0]));
    assert.ok(!kept.includes(Buffer.from("aced.json")) && !kept.includes(Buffer.from(sample.name.split(":")[0])), "the service holds no readable exam");
    assert.match(await js(`document.querySelector('.sw-link.done small').textContent`), /works until/);
    await click(".sw-close");

    // ------------------------------------------------ the friend opens the link
    step = "the friend opens the link";
    const { id, key } = link.parse(url, process.env.ACED_LINK_HOST);
    const before = store.exams().length;
    app.emit("open-url", { preventDefault() {} }, `aced://s/${id}#${key}`);
    await waitFor(() => store.exams().length === before + 1, "the shared exam");
    const friend = store.exams().find((e) => e.shared);
    assert.ok(friend, "made from the link, as from a file");
    assert.equal(Object.keys(friend.done).length, 0, "at 0%");
    assert.deepEqual(friend.materials.map((m) => m.kind).sort(), ["book", "notes"]);
    await until(`!!document.querySelector('.shared-note')`);
    // the same link again: the person is asked
    let asked = 0;
    dialog.showMessageBox = async () => (asked++, { response: 0 });
    app.emit("open-url", { preventDefault() {} }, `aced://s/${id}#${key}`);
    await waitFor(() => asked === 1, "the question");
    await sleep(500);
    assert.equal(store.exams().length, before + 1, "“Open it” adds nothing");
    // hostile and broken links: a sentence, no exam, nothing fetched from anywhere else
    const hostile = [`aced://s/../../etc#${key}`, `aced://evil.example/s/${id}#${key}`, `aced://s/${id}#${key.slice(1)}`, `aced://s/${id}?x=https://evil.example#${key}`, `aced://s/${id}#${link.seal(Buffer.from("x")).key}`, "aced://", `aced://s/${"A".repeat(22)}#${key}`];
    for (const bad of hostile) {
      await js(`document.querySelector('.toast')?.remove()`);
      app.emit("open-url", { preventDefault() {} }, bad);
      await until(`/not complete|run out/.test(document.querySelector('.toast')?.textContent || '')`, 15000);
    }
    assert.equal(store.exams().length, before + 1, "no exam from a bad link");
    // a link that has run out
    for (const name of fs.readdirSync(path.join(userData, "service"))) fs.rmSync(path.join(userData, "service", name));
    await share.close();
    const again = await service.start({ ...service.settings({}), port: share.port, dataDir: path.join(userData, "service") }, { quiet: true });
    app.emit("open-url", { preventDefault() {} }, `aced://s/${id}#${key}`);
    await until(`/run out/.test(document.querySelector('.toast')?.textContent || '')`, 15000);
    await again.close();

    // ------------------------------------------------ writing in the book
    step = "writing in the book";
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 60000);
    await click("#inkToggle");
    await until(`!!document.querySelector('.ink-bar')`);
    const leafOf = (n) => js(`(() => { const r = document.querySelector('.leaf[data-page="${n}"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const page = await js(`Number(document.querySelector('.book-page').dataset.page)`);
    let r = await leafOf(page);
    const P = (fx, fy) => [r.x + fx * r.w, r.y + fy * r.w];
    const send = (type, [x, y], extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x * SCALE), y: Math.round(y * SCALE), button: "left", clickCount: 1, ...extra });
    const drag = async (points) => {
      send("mouseMove", points[0]);
      send("mouseDown", points[0]);
      for (const p of points.slice(1)) {
        send("mouseMove", p, { buttons: 1 });
        await sleep(10);
      }
      send("mouseUp", points[points.length - 1]);
      await sleep(150);
    };
    const across = (fy) => Array.from({ length: 20 }, (_, i) => P(0.2 + i * 0.03, fy));
    await drag(across(0.3)); // the pen is in the hand when writing starts
    await click("#ink-hl");
    await drag(across(0.4));
    assert.equal(await js(`document.querySelectorAll('.leaf[data-page="${page}"] .ink-pen path').length`), 1);
    assert.equal(await js(`document.querySelectorAll('.leaf[data-page="${page}"] .ink-hl path').length`), 1);
    const hash = bookItem.hash;
    const saved = async () => (await js(`window.aced.inkLoad(${JSON.stringify(hash)})`))[page] || { s: [], n: [] };
    await sleep(600);
    let ink = await saved();
    assert.deepEqual(ink.s.map((s) => s.t), ["pen", "hl"], "kept on this Mac");
    assert.ok(ink.s[0].p.length >= 20 && Math.abs(ink.s[0].p[0] - 2000) < 40, "in the page's own units");
    // zoom: the line grows with the page
    const width = () => js(`document.querySelector('.leaf[data-page="${page}"] .ink-pen path').getBoundingClientRect().width`);
    const w1 = await width();
    await js(`document.querySelector('.zoom button:last-child').click()`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`);
    await sleep(300);
    const w2 = await width();
    assert.ok(Math.abs(w2 / w1 - 1.25) < 0.03, `the line scales with the zoom (${w1} → ${w2})`);
    await js(`document.querySelector('.zoom button:first-child').click()`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`);
    await sleep(300);
    // undo and redo, with the keys and the buttons
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "z", modifiers: ["meta"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "z", modifiers: ["meta"] });
    await until(`document.querySelectorAll('.leaf[data-page="${page}"] .ink-hl path').length === 0`);
    await click("#ink-redo");
    await until(`document.querySelectorAll('.leaf[data-page="${page}"] .ink-hl path').length === 1`);
    // a note
    r = await leafOf(page);
    await click("#ink-text");
    send("mouseDown", P(0.5, 0.6));
    send("mouseUp", P(0.5, 0.6));
    await until(`document.activeElement?.classList.contains('ink-note')`);
    await js(`(() => { const el = document.activeElement; el.value = 'Prüfung <b>nicht fett</b>'; el.dispatchEvent(new Event('input')); })()`);
    await click("#ink-eraser"); // another tool: the note is kept
    await until(`!!document.querySelector('.leaf[data-page="${page}"] .ink-note:not(.editing)')`);
    assert.equal(await js(`document.querySelector('.leaf[data-page="${page}"] .ink-note').textContent`), "Prüfung <b>nicht fett</b>", "a note is text, never markup");
    assert.equal(await js(`document.querySelector('.leaf[data-page="${page}"] .ink-note b')`), null);
    // the eraser takes the pen line it crosses, and nothing else
    await drag([P(0.5, 0.25), P(0.5, 0.3), P(0.5, 0.35)]);
    await sleep(600);
    ink = await saved();
    assert.deepEqual([ink.s.map((s) => s.t), ink.n.map((n) => n.text)], [["hl"], ["Prüfung <b>nicht fett</b>"]]);
    await click("#ink-done");
    assert.equal(await js(`!!document.querySelector('.ink-bar')`), false);
    // the book opened again (another view and back): the ink is there
    await js(`window.__nav({ name: 'home' })`);
    await sleep(400);
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown' && document.querySelectorAll('.leaf[data-page="${page}"] .ink-hl path').length === 1 && !!document.querySelector('.leaf[data-page="${page}"] .ink-note')`, 30000);
    // nothing written travels: not in the Aced file
    await click("#shareOpen");
    await click("#share-airdrop");
    await until(`!document.querySelector('.share-win')`);
    const last = handed[handed.length - 1];
    assert.ok(!last.bytes.includes(Buffer.from("Prüfung <b>")) && !share_unpack(last.file).raw.includes("nicht fett"), "ink is never shared");
    // with the exam (and the friend's copy, which uses the same book) gone, so is the ink
    assert.ok(fs.existsSync(path.join(userData, "ink", `${hash}.json`)));
    for (const e of store.exams()) await js(`window.aced.deleteExam(${JSON.stringify(e.id)})`);
    assert.equal(fs.existsSync(path.join(userData, "ink", `${hash}.json`)), false, "pruned with the book");
    assert.deepEqual(errors, [], "no errors in the page");
    console.log("ok: share window (not set up, AirDrop, Copy file, Mail, the material choice), Copy link (locked, on the service, on the clipboard), the friend's link (0%, asked again, 7 hostile links refused, run out), writing in the book (pen, highlighter, zoom, undo/redo, note as text, eraser, kept and back, never shared, pruned)");
  } catch (err) {
    console.log("FAIL", step, "-", err.message, errors.slice(0, 3).join(" | "));
    process.exitCode = 1;
  } finally {
    await share.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    for (const h of handed) fs.rmSync(path.dirname(h.file), { recursive: true, force: true });
  }
  app.exit(process.exitCode || 0);
});

/** An Aced file as the friend's Aced reads it: its exam and materials, and the JSON as text. */
function share_unpack(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aced-smoke-06-unpack-"));
  try {
    const got = require("../src/share").unpack(file, dir);
    const raw = require("../src/formats/zip").open(file, { entries: 400, entry: 1e9, total: 1e9 });
    const text = raw.read("aced.json", 16e6).toString("utf8");
    raw.close();
    return { ...got, raw: text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

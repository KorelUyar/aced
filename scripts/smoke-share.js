// Sharing in the app, in a hidden window, with a fresh profile: the sample exam with a real
// book, shared through the share window (Save file, PDF and Web page),
// then the Aced file opened as a double-click in the Finder opens it: a new exam at 0%, the book
// waiting, and the same book added from "Choose files" taking its place in the panel.
// AirDrop, Messages, Mail and macOS's menu are not opened here: they would show on the screen
// (scripts/smoke-06.js covers the rest of the window: links, copying, what this Mac has).
//
//   node_modules/.bin/electron scripts/smoke-share.js [<folder for pictures>]
const { app, dialog, BrowserWindow } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const pictures = process.argv.slice(2).find((a) => !a.startsWith("--") && !a.endsWith("smoke-share.js"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "aced-smoke-share-"));
app.setPath("userData", userData);
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const errors = [];
  win.webContents.on("console-message", (e) => (e.level === "error" || e.level === 3) && errors.push(e.message));
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  const shot = async (name) => {
    if (!pictures) return;
    await sleep(600);
    fs.mkdirSync(pictures, { recursive: true });
    fs.writeFileSync(path.join(pictures, name + ".png"), await capture(win));
  };
  const store = require("../src/store");
  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    // ---- the sender's exam: the sample exam, with a real book of 112 pages
    const book = path.join(userData, "Mathematik 1.pdf");
    const printer = new BrowserWindow({ show: false });
    const pages = Array.from({ length: 112 }, (_, i) => `<section style="break-after:page"><h2>Seite ${i + 1}</h2><p>Aufgabe ${i + 1}. Berechne.</p></section>`).join("");
    await printer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<meta charset="utf-8">${pages}`));
    fs.writeFileSync(book, await printer.webContents.printToPDF({}));
    printer.destroy();
    const sample = require("../src/sample").exams("en")[0];
    const created = await js(`window.aced.createExam(${JSON.stringify({ name: sample.name, date: sample.date, time: sample.time, scale: sample.scale, target: sample.target, pace: sample.pace })})`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(500);
    await js(`window.__nav({ name: 'setup', id: ${JSON.stringify(created.id)} })`);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] });
    await click("#chooseFiles");
    await until(`document.querySelectorAll('.materials li').length === 1`, 60000);
    const bookId = store.exam(created.id).materials[0].id;
    // The plan of the sample exam, pointing into this book (no AI asked).
    const strategy = structuredClone(sample.strategy);
    for (const t of strategy.topics) for (const st of t.steps) if (st.material) st.material = bookId;
    store.change(created.id, (e) => {
      e.strategy = strategy;
      e.formulas = sample.formulas.map((g) => ({ ...g, formulas: g.formulas.map((f) => ({ ...f, material: bookId })) }));
      e.done = { "t1/r0": { date: "2026-11-21", minutes: 15, at: 1 } };
    });
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(500);
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`!!document.querySelector('.path .step')`);

    // ---- the share window: the book stays out unless ticked; Save file, PDF and Web page
    // each write their file, from Downloads unless the person chooses another place
    await click("#shareOpen");
    await until(`!!document.querySelector('.share-win')`);
    await click("#shareChange");
    assert.equal(await js(`document.querySelector('.share-material input').checked`), false, "the book is not ticked: it stays out");
    const saved = {};
    for (const [way, ext] of [["save", "aced"], ["pdf", "pdf"], ["web", "html"]]) {
      if (way !== "save") {
        await click("#shareOpen");
        await until(`!!document.querySelector('.share-win')`);
      }
      const target = path.join(userData, `out.${ext}`);
      let offered = "";
      dialog.showSaveDialog = async (_w, options) => {
        offered = options.defaultPath;
        return { canceled: false, filePath: target };
      };
      await click(`#share-${way}`);
      await until(`!document.querySelector('.share-win')`, 60000);
      assert.equal(path.dirname(offered), app.getPath("downloads"), `${way}: offered in Downloads`);
      assert.equal(path.extname(offered), "." + ext);
      saved[ext] = target;
      assert.ok(fs.existsSync(target) && fs.statSync(target).size > 1000, `${way} writes the ${ext}`);
    }
    assert.equal(fs.readFileSync(saved.pdf).subarray(0, 5).toString(), "%PDF-", "the PDF is a PDF");
    assert.match(fs.readFileSync(saved.html, "utf8"), /<math[\s\S]*Made with Aced · uyarid\.com/, "the web page has its formulas and its line at the foot");

    // ---- the friend: the Aced file opened from the Finder. On this Mac the book is there already
    // (same SHA-256): the plan opens with it at once.
    app.emit("open-file", { preventDefault() {} }, saved.aced);
    await until(`!!document.querySelector('.shared-note') && document.querySelector('.book-page')?.dataset.state === 'shown'`, 60000);
    assert.equal(store.exams().find((e) => e.shared).materials[0].missing, undefined, "a book this Mac has is found at once");
    // On a Mac without the book (both exams deleted, and with them the book's copy): it waits.
    for (const e of store.exams()) await js(`window.aced.deleteExam(${JSON.stringify(e.id)})`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(500);
    app.emit("open-file", { preventDefault() {} }, saved.aced);
    await until(`!!document.querySelector('.shared-note') && !!document.querySelector('.missing-book')`, 60000);
    assert.equal(await js(`document.querySelector('.percent b').textContent`), "0", "the shared exam starts at 0%");
    const friendId = store.exams().find((e) => e.shared).id;
    await shot("friend-book-missing");
    // The same book, chosen: found by its SHA-256, and the book is in the panel.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] });
    await click("#chooseCopy");
    await until(`!document.querySelector('.missing-book') && !!document.querySelector('.book-page')`, 60000);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 60000);
    const m = store.exam(friendId).materials.find((x) => x.kind === "book");
    assert.deepEqual([m.missing, m.edition], [undefined, "same"], "the same book takes its place");
    await shot("friend-book-added");
    // A file that is no Aced file, opened the same way: a sentence, no new exam.
    const broken = path.join(userData, "kaputt.aced");
    fs.writeFileSync(broken, "not an exam");
    const count = store.exams().length;
    app.emit("open-file", { preventDefault() {} }, broken);
    await until(`/not an Aced file that can be read/.test(document.querySelector('.toast')?.textContent || '')`);
    assert.equal(store.exams().length, count, "a damaged file makes no exam");
    const waitFor = async (check, what) => {
      const end = Date.now() + 60000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out: " + what);
        await sleep(100);
      }
    };
    // The same shared file again while its exam is here: the person is asked.
    let asked = 0;
    dialog.showMessageBox = async () => (asked++, { response: 0 });
    app.emit("open-file", { preventDefault() {} }, saved.aced);
    await waitFor(() => asked === 1, "the question");
    await sleep(800);
    assert.equal(store.exams().length, count, "the same shared file again: asked, and “Open it” adds nothing");
    dialog.showMessageBox = async () => ({ response: 1 });
    app.emit("open-file", { preventDefault() {} }, saved.aced);
    await waitFor(() => store.exams().length === count + 1, "another copy");
    const copyId = store.exams().find((e) => e.shared && e.id !== friendId).id;
    await sleep(1000); // the window goes to the new copy
    // Other files from the Finder: material for the exam on screen. A shared exam inside a folder
    // is left out, with a sentence.
    const folder = path.join(userData, "Ordner");
    fs.mkdirSync(folder);
    fs.copyFileSync(saved.aced, path.join(folder, "drin.aced"));
    fs.writeFileSync(path.join(folder, "Notiz.txt"), "Dichte ist Masse durch Volumen.");
    const had = store.exam(copyId).materials.length;
    app.emit("open-file", { preventDefault() {} }, folder);
    await waitFor(() => store.exam(copyId).materials.length === had + 1, "the note added to the exam on screen");
    await until(`/inside a folder/.test(document.querySelector('.toast')?.textContent || '')`);
    assert.equal(store.exams().length, count + 1, "the Aced file in the folder made no exam");
    // With no exam on screen: a sentence, nothing added anywhere.
    await js(`window.__nav({ name: "home" })`);
    await sleep(500);
    const totals = () => store.exams().reduce((n, e) => n + e.materials.length, 0);
    const all = totals();
    app.emit("open-file", { preventDefault() {} }, book);
    await until(`/open an exam first/.test(document.querySelector('.toast')?.textContent || '')`);
    await sleep(500);
    assert.equal(totals(), all, "a file from the Finder with no exam open is not added anywhere");
    assert.deepEqual(errors, [], "no errors in the page");
    console.log("ok: the share window (Save file, PDF, Web page, from Downloads), a shared exam opened from the Finder at 0%, its book added by its SHA-256, a damaged file refused, the same file again asked about, other Finder files added to the exam on screen (or a sentence)");
  } catch (err) {
    console.log("FAIL", err.message, errors.slice(0, 3).join(" | "));
    process.exitCode = 1;
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
  app.exit(process.exitCode || 0);
});

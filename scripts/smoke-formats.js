// Material handed over without the Finder, in the app, in a hidden window: a folder dropped
// (system files left out), "Choose files" without a filter, ⌘V of a screenshot, of files copied
// in the Finder and of text, picture data dropped without a file (as a browser hands it over),
// a web link dropped, and the AI reading pictures right after (Claude Code is the stand-in in
// scripts/fixtures/claude-stub.sh: nothing is sent anywhere), with "Read with AI" when it could
// not. The clipboard is put back as it was.
//
//   node_modules/.bin/electron scripts/smoke-formats.js
const { app, clipboard, dialog, ClipboardItem } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { quiet, hideWindowsOf, sleep } = require("./hidden");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "aced-smoke-formats-"));
app.setPath("userData", userData);
const stateFile = path.join(userData, "claude-state");
fs.writeFileSync(stateFile, "ok");
Object.assign(process.env, { ACED_CLAUDE: path.join(__dirname, "fixtures", "claude-stub.sh"), ACED_STUB_STATE: stateFile });
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
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
  const saved = () => JSON.parse(fs.readFileSync(path.join(userData, "aced.json"), "utf8")).exams[0];
  const text = (m) => JSON.parse(fs.readFileSync(path.join(userData, "texts", m.hash + ".json"), "utf8"));
  const count = () => js(`document.querySelectorAll('.materials li').length`);
  const paste = () => js(`document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }))`);
  // What was on the clipboard, to put it back afterwards.
  const before = [];
  for (const item of await clipboard.read().catch(() => [])) {
    const kept = {};
    for (const type of item.types) kept[type] = await item.getType(type).catch(() => null);
    before.push(Object.fromEntries(Object.entries(kept).filter(([, v]) => v)));
  }
  const putPng = (file) => clipboard.write([new ClipboardItem({ "image/png": new Blob([fs.readFileSync(file)], { type: "image/png" }) })]);

  try {
    await until(`!!window.__nav`);
    await js(`window.aced.setSettings({ ai: { provider: 'claudeCode' } })`);
    const date = new Date(Date.now() + 9 * 864e5).toLocaleDateString("sv");
    const created = await js(`window.aced.createExam({ name: 'Formate', date: '${date}', time: { mode: 'perDay', minutes: 30 }, scale: 'ch', target: 5, pace: 'sprint' })`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(300);
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`!!document.querySelector('.drop')`);
    assert.match(await js(`document.querySelector('.drop').innerText`), /Drop files or a folder here[\s\S]*Word, Excel, PowerPoint[\s\S]*⌘V/, "the drop area says what it takes, and that ⌘V works");

    // ---- "Choose files" offers every file, and folders
    let asked = null;
    dialog.showOpenDialog = async (_w, options) => {
      asked = options;
      return { canceled: true, filePaths: [] };
    };
    await js(`document.querySelector('#chooseFiles').click()`);
    await sleep(300);
    assert.ok(asked && !asked.filters && asked.properties.includes("openDirectory") && asked.properties.includes("multiSelections"), "Choose files: no filter, folders and several files");

    // ---- a folder, dropped: what is in it, without what macOS and Office leave there
    const folder = path.join(userData, "Unterlagen");
    fs.mkdirSync(path.join(folder, "Kapitel 2"), { recursive: true });
    const sample = path.join(userData, "sample.png");
    execFileSync(path.join(__dirname, "..", "build", "bin", "aced-ocr"), ["--sample", sample]);
    fs.copyFileSync(sample, path.join(folder, "Bildschirmfoto 1.png"));
    fs.copyFileSync(sample, path.join(folder, "Bildschirmfoto 2.png"));
    fs.writeFileSync(path.join(folder, "Kapitel 2", "Lernziele.txt"), "Ich kann Brüche addieren.\n");
    fs.writeFileSync(path.join(folder, "Blatt.docx"), require("./fixtures/formats").docx());
    fs.writeFileSync(path.join(folder, ".DS_Store"), "x");
    fs.writeFileSync(path.join(folder, "~$Blatt.docx"), "x");
    const [x, y] = await js(`(() => { const r = document.querySelector('.drop').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    win.webContents.debugger.attach("1.3");
    for (const type of ["dragEnter", "dragOver", "drop"]) await win.webContents.debugger.sendCommand("Input.dispatchDragEvent", { type, x, y, data: { items: [], files: [folder], dragOperationsMask: 1 } });
    win.webContents.debugger.detach();
    await until(`document.querySelectorAll('.materials li').length === 3`, 60000);
    let e = saved();
    const pictures = e.materials.find((m) => m.from === "pictures");
    assert.deepEqual(e.materials.map((m) => m.from).sort(), ["docx", "pictures", "text"], "a folder: its pictures as one document, the Word file, the text file in the folder inside it");
    assert.equal(pictures.pages, 2, "the two screenshots are one document of two pages");
    assert.equal(await js(`document.querySelectorAll('.material .problem').length`), 0, "the system files were left out, without a word");
    // ---- the AI reads the pictures right after, and the row says so
    await until(`/read by Claude Opus 5\\.5/.test(document.querySelector('.materials').innerText)`, 60000);
    assert.match(text(saved().materials.find((m) => m.from === "pictures")).pages[1], /read by the stand-in/, "the AI's text takes the place of the recognised one, page by page");
    assert.equal(saved().materials.find((m) => m.from === "pictures").read, "ai");

    // ---- links are never followed: in a dropped folder, dropped on their own, or named by the page
    const secretFile = path.join(userData, "geheim.txt");
    fs.writeFileSync(secretFile, "GEHEIM-4711 must never become material\n");
    const unpacked = path.join(userData, "Entpackt");
    fs.mkdirSync(unpacked);
    fs.writeFileSync(path.join(unpacked, "Kapitel 1.txt"), "Kapitel 1: Aufgabe 1.\n");
    fs.symlinkSync(secretFile, path.join(unpacked, "Kapitel 2.txt"));
    fs.symlinkSync(userData, path.join(unpacked, "Mehr"));
    const before2 = saved().materials.length;
    const drag = async (files) => {
      // (The drop area has moved up since the first drop: the lead text above it is gone.)
      const [dx, dy] = await js(`(() => { const r = document.querySelector('.drop').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      win.webContents.debugger.attach("1.3");
      for (const type of ["dragEnter", "dragOver", "drop"]) await win.webContents.debugger.sendCommand("Input.dispatchDragEvent", { type, x: dx, y: dy, data: { items: [], files, dragOperationsMask: 1 } });
      win.webContents.debugger.detach();
    };
    await drag([unpacked]);
    await until(`/are only links/.test([...document.querySelectorAll('.material .problem')].map((p) => p.textContent).join(" "))`, 60000);
    e = saved();
    assert.equal(e.materials.length, before2 + 1, "of a folder with links, only the real file is added");
    const leaked = e.materials.some((m) => /GEHEIM/.test(JSON.stringify(text(m))));
    assert.ok(!leaked && !JSON.stringify(fs.readdirSync(path.join(userData, "originals"), { recursive: true })).includes("Kapitel 2"), "nothing behind a link was read or copied");
    await drag([path.join(unpacked, "Kapitel 2.txt")]);
    await until(`/“Kapitel 2\.txt” is only a link/.test(document.querySelector('.material .problem')?.textContent || '')`);
    assert.equal(saved().materials.length, before2 + 1, "a link dropped on its own is not followed either");
    await js(`window.aced.addMaterial(${JSON.stringify(created.id)}, [${JSON.stringify(secretFile)}])`);
    await sleep(500);
    assert.equal(saved().materials.length, before2 + 1, "a path the page names is not read: only files a drop brought are");

    // ---- ⌘V of a screenshot (⌃⇧⌘4 puts a picture on the clipboard)
    await putPng(sample);
    await paste();
    await until(`document.querySelectorAll('.materials li').length === 5`, 60000);
    e = saved();
    const pasted = e.materials[4];
    assert.match(pasted.title, /^Pasted picture \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d$/, "a pasted screenshot is named for what it is");
    await until(`(window.__rows = [...document.querySelectorAll('.materials li span')].map((s) => s.textContent)) && /read by/.test(window.__rows[4])`, 60000);

    // ---- ⌘V of files copied in the Finder
    const csv = path.join(userData, "Punkte.csv");
    fs.writeFileSync(csv, "Aufgabe;Punkte\n1;4\n2;6\n");
    // (The Finder puts the files' addresses on the clipboard; Electron hands them over as a list of file URLs.)
    await clipboard.write([new ClipboardItem({ "text/uri-list": require("url").pathToFileURL(csv).href + "\r\n" })]);
    await paste();
    await until(`document.querySelectorAll('.materials li').length === 6`, 60000);
    assert.equal(saved().materials[5].from, "csv", "files copied in the Finder are added as files");

    // ---- ⌘V of a bookmark to a file (as "Copy Link" leaves it): the address stays text
    await clipboard.write([new ClipboardItem({ "electron application/bookmark": { title: "Lösungen", url: require("url").pathToFileURL(secretFile).href } })]);
    const countBefore = saved().materials.length;
    await paste();
    await until(`/^file:/.test(document.querySelector('.paste textarea')?.value || '')`);
    assert.equal(saved().materials.length, countBefore, "a link to a file is not read as the file");
    await js(`document.querySelector('.paste .btn.plain').click()`);

    // ---- ⌘V of text: the box for text opens with it
    await clipboard.writeText("Lernziel: Ich kann Prozentaufgaben lösen.");
    await paste();
    await until(`document.querySelector('.paste textarea')?.value === 'Lernziel: Ich kann Prozentaufgaben lösen.'`);
    await js(`document.querySelector('.paste .btn.plain').click()`);
    // In a text field, ⌘V is the text field's own.
    await Promise.resolve(clipboard.clear());
    await paste();
    await until(`/nothing to paste/.test(document.querySelector('.material .problem')?.textContent || '')`);

    // ---- a picture dropped as data, without a file (as a browser hands one over)
    const bytes = [...fs.readFileSync(sample)];
    await js(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], 'Foto aus Safari.png', { type: 'image/png' }));
      document.querySelector('.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await until(`document.querySelectorAll('.materials li').length === 7`, 60000);
    assert.equal(saved().materials[6].title, "Foto aus Safari", "dropped picture data becomes a picture, under its own name");
    // ---- a file:// address dropped as a link (not as a file): never opened
    await js(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', ${JSON.stringify(require("url").pathToFileURL(secretFile).href)});
      document.querySelector('.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await until(`/came as a link, not as a file/.test(document.querySelector('.material .problem')?.textContent || '')`);
    assert.ok(!saved().materials.some((m) => m.title === "geheim"), "a dropped file:// link is not read");
    // ---- only a link to a picture on the web: said, not downloaded
    await js(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.com/aufgabe.png');
      document.querySelector('.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await until(`/link to the web/.test(document.querySelector('.material .problem')?.textContent || '')`);

    // ---- the AI cannot be reached: the text read on this Mac stays, and the row offers another try
    fs.writeFileSync(stateFile, "offline");
    const other = path.join(userData, "other.png");
    execFileSync("/usr/bin/sips", ["-r", "90", sample, "--out", other], { stdio: "ignore" });
    await putPng(other);
    await paste();
    await until(`document.querySelectorAll('.materials li').length === 8`, 60000);
    await until(`/could not be reached/.test(document.querySelectorAll('.materials li')[7]?.innerText || '')`, 60000);
    assert.equal(saved().materials[7].read, "local");
    fs.writeFileSync(stateFile, "ok");
    await js(`[...document.querySelectorAll('.materials li')[7].querySelectorAll('.link')].find((b) => /Read with AI/.test(b.textContent)).click()`);
    await until(`/read by Claude/.test(document.querySelectorAll('.materials li')[7]?.innerText || '')`, 60000);
    assert.equal(saved().materials[7].read, "ai", "Read with AI: a second try reads it");

    assert.deepEqual(errors, [], "no errors in the page");
    console.log("ok: a folder, links never followed, paths the page names refused, Choose files, ⌘V of a screenshot, of Finder files, of a bookmark and of text, picture data and links dropped, the AI reading pictures and trying again");
  } catch (err) {
    console.log("FAIL", err.message, errors.slice(0, 3).join(" | "));
    process.exitCode = 1;
  } finally {
    // The clipboard as it was.
    await Promise.resolve(clipboard.clear()).catch(() => {});
    const back = before.filter((kept) => Object.keys(kept).length);
    if (back.length) await clipboard.write(back.map((kept) => new ClipboardItem(kept))).catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
  app.exit(process.exitCode || 0);
});

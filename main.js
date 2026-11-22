const { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu, dialog, session, protocol, net, clipboard, ShareMenu } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const brand = require("./src/brand");
const store = require("./src/store");
const move = require("./src/move");
const files = require("./src/files");
const formats = require("./src/formats");
const convert = require("./src/convert");
const see = require("./src/see");
const share = require("./src/share");
const { examPage, footerOf } = require("./src/export");
const { print } = require("./src/print");
const ocr = require("./src/ocr");
const secrets = require("./src/secrets");
const planner = require("./src/planner");
const engine = require("./src/engine");
const ai = require("./src/ai");
const models = require("./src/ai/models");
const claudeCode = require("./src/ai/claude-code");
const { origin } = require("./src/address");

// Settings for the Anthropic SDK that may sit in the environment (another server, extra
// headers) have no say in this app.
require("./src/ai/anthropic").ignoreEnvironment();

// The book is drawn inside the app's own page (ui/book.js). Its bytes come through this
// address, which serves nothing but the copies of PDFs in the app's library.
// Files that are not PDFs are printed to one by a locked-down hidden page, served from
// "aced-print" (see src/print.js), which only ever hands out the page being printed.
protocol.registerSchemesAsPrivileged([
  { scheme: "aced-book", privileges: { supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: "aced-print", privileges: { standard: true, secure: true } },
]);

// Only one copy of the app at a time: two would overwrite each other's file.
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// `--sample` (or ACED_SAMPLE=1) starts with invented exams kept in memory only. It is how the
// screenshots are made; nothing is read from or written to the person's real data.
const SAMPLE = process.argv.includes("--sample") || process.env.ACED_SAMPLE === "1";

let win;
const jobs = new Map(); // AbortController -> exam id: everything under way that "Cancel" must reach
// What is running, per exam: { kind, stage, title, done, total, startedAt }. The window shows it
// wherever the person is, and nothing is started twice.
const runs = new Map();

const isMac = process.platform === "darwin";
const colors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#0e1116", symbols: "#f4f6fa" }
    : { background: "#f4f5f7", symbols: "#14161b" };

function applyAppearance(value) {
  nativeTheme.themeSource = value === "light" || value === "dark" ? value : "system";
}

/** German on a German Mac, English everywhere else. (ACED_LANG stands in for the Mac's language in tests.) */
function systemLang() {
  const forced = !app.isPackaged && process.env.ACED_LANG;
  const first = forced || (app.getPreferredSystemLanguages ? app.getPreferredSystemLanguages()[0] : "") || app.getLocale() || "en";
  return first.toLowerCase().startsWith("de") ? "de" : "en";
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 19 } }
      : { titleBarOverlay: { color: colors().background, symbolColor: colors().symbols, height: 52 } }),
    backgroundColor: colors().background,
    title: brand.name,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--aced-name=${brand.name}`, `--aced-sample=${SAMPLE ? 1 : 0}`],
    },
  });
  win.once("ready-to-show", () => win.show());
  nativeTheme.on("updated", () => {
    if (!win || win.isDestroyed()) return;
    const c = colors();
    win.setBackgroundColor(c.background);
    if (!isMac) win.setTitleBarOverlay({ color: c.background, symbolColor: c.symbols, height: 52 });
  });
  win.on("closed", () => app.quit());
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  // The page never leaves the app's own files (a file dropped beside the drop area would otherwise open).
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

/** The app's own menu: what a Mac app has, and nothing that reloads the page or opens developer tools. */
function buildMenu() {
  const de = store.settings().lang === "de";
  const tell = (what) => () => win && !win.isDestroyed() && win.webContents.send("menu", what);
  const template = [
    ...(isMac
      ? [
          {
            label: brand.name,
            submenu: [
              { role: "about", label: de ? `Über ${brand.name}` : `About ${brand.name}` },
              { type: "separator" },
              { label: de ? "Einstellungen …" : "Settings…", accelerator: "Cmd+,", click: tell("settings") },
              { type: "separator" },
              { role: "hide", label: de ? `${brand.name} ausblenden` : `Hide ${brand.name}` },
              { role: "hideOthers", label: de ? "Andere ausblenden" : "Hide Others" },
              { role: "unhide", label: de ? "Alle einblenden" : "Show All" },
              { type: "separator" },
              { role: "quit", label: de ? `${brand.name} beenden` : `Quit ${brand.name}` },
            ],
          },
        ]
      : []),
    {
      label: de ? "Ablage" : "File",
      submenu: [
        { label: de ? "Neue Prüfung" : "New Exam", accelerator: "CmdOrCtrl+N", click: tell("new") },
        { label: de ? "Geteilte Prüfung öffnen …" : "Open Shared Exam…", accelerator: "CmdOrCtrl+O", click: () => chooseShared() },
        ...(isMac ? [] : [{ label: de ? "Einstellungen …" : "Settings…", accelerator: "Ctrl+,", click: tell("settings") }, { type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: de ? "Bearbeiten" : "Edit",
      submenu: [
        { role: "undo", label: de ? "Widerrufen" : "Undo" },
        { role: "redo", label: de ? "Wiederholen" : "Redo" },
        { type: "separator" },
        { role: "cut", label: de ? "Ausschneiden" : "Cut" },
        { role: "copy", label: de ? "Kopieren" : "Copy" },
        { role: "paste", label: de ? "Einsetzen" : "Paste" },
        { role: "selectAll", label: de ? "Alles auswählen" : "Select All" },
      ],
    },
    {
      label: de ? "Darstellung" : "View",
      submenu: [
        { role: "resetZoom", label: de ? "Originalgrösse" : "Actual Size" },
        { role: "zoomIn", label: de ? "Vergrössern" : "Zoom In" },
        { role: "zoomOut", label: de ? "Verkleinern" : "Zoom Out" },
        { type: "separator" },
        { role: "togglefullscreen", label: de ? "Vollbild" : "Toggle Full Screen" },
      ],
    },
    { label: de ? "Fenster" : "Window", submenu: [{ role: "minimize", label: de ? "Im Dock ablegen" : "Minimize" }, { role: "zoom", label: de ? "Zoomen" : "Zoom" }] },
    { role: "help", label: de ? "Hilfe" : "Help", submenu: [{ label: de ? `${brand.name} auf GitHub` : `${brand.name} on GitHub`, click: () => shell.openExternal(brand.home) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName(brand.name);

// An Aced file opened from the Finder (a double-click, or dropped on the Dock icon). Files that
// come before the window is ready wait for it.
const waiting = [];
let ready = false;
app.on("open-file", (e, file) => {
  e.preventDefault();
  if (ready) openShared([file]);
  else waiting.push(file);
});

app.whenReady().then(() => {
  if (!single) return;
  // Nothing in this app needs the camera, the location or any other permission a page can ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // The book panel asks for a large file in parts (a 300 MB scan need not sit in memory whole):
  // a request with a Range gets exactly that part, said the way a web server says it.
  protocol.handle("aced-book", async (request) => {
    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/+/, "");
    // "parts": what pdf.js needs to draw a page, from the app's own files, by exact name.
    if (url.hostname === "parts") {
      const part = /^(wasm|cmaps|iccs|standard_fonts)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? path.join(__dirname, "ui", "vendor", "pdfjs", name) : null;
      return part && fs.existsSync(part) ? net.fetch(pathToFileURL(part).href) : new Response("not found", { status: 404 });
    }
    const file = url.hostname === "book" && /^[a-f0-9]{64}$/.test(name) ? files.pdfPath(name) : null;
    if (!file || !fs.existsSync(file)) return new Response("not found", { status: 404 });
    const size = fs.statSync(file).size;
    const headers = { "Content-Type": "application/pdf", "Accept-Ranges": "bytes" };
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") || "");
    if (!range) return new Response((await net.fetch(pathToFileURL(file).href)).body, { headers: { ...headers, "Content-Length": String(size) } });
    const from = Number(range[1]);
    const to = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (from > to) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const part = await net.fetch(pathToFileURL(file).href, { headers: { Range: `bytes=${from}-${to}` } });
    return new Response(part.body, { status: 206, headers: { ...headers, "Content-Length": String(to - from + 1), "Content-Range": `bytes ${from}-${to}/${size}` } });
  });
  // Run from the source folder, the Dock would show Electron's icon.
  const devIcon = path.join(__dirname, "build", "icon.png");
  if (isMac && !app.isPackaged && fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  const userData = app.getPath("userData");
  files.init(SAMPLE ? fs.mkdtempSync(path.join(os.tmpdir(), "aced-sample-")) : userData);
  // Test runs from the source folder can keep keys in memory only (ACED_KEYS=memory), so they
  // leave nothing in the keychain. The app people install always stores them.
  secrets.init(userData, { persist: !SAMPLE && !(process.env.ACED_KEYS === "memory" && !app.isPackaged) });
  // What a person had in Spurt (the app's earlier name) comes along on the first start.
  // (ACED_OLD_DATA names that folder in tests; the installed app looks where Spurt kept it.)
  const oldData = app.isPackaged ? path.join(app.getPath("appData"), "Spurt") : process.env.ACED_OLD_DATA || null;
  let moved = null;
  try {
    moved = SAMPLE ? null : move.fromSpurt(userData, oldData);
  } catch (err) {
    moved = { failed: String(err && err.message) };
  }
  store.init({ dir: userData, sample: SAMPLE, systemLang: systemLang() });
  if (moved) store.noteMove(moved);
  ai.init(() => store.settings());
  // Whatever an earlier run left without an owner goes. Not while the data file is unreadable:
  // then nothing is known to be without an owner.
  if (!SAMPLE && !store.problem()) files.prune(store.references());
  applyAppearance(store.settings().appearance);
  buildMenu();
  createWindow();
  ready = true;
  win.webContents.once("did-finish-load", () => waiting.length && openShared(waiting.splice(0)));
  // The first time after an install or an update, macOS needs about a minute to get its text
  // recognition ready. That is started now, quietly, so it is done by the time a book without
  // text is added. (Only in the installed app: test runs do not need it.)
  if (app.isPackaged && !SAMPLE && ocr.available()) setTimeout(() => ocr.prepare().catch(() => {}), 4000);
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
// Nothing that was started outlives the app: requests are cancelled, Claude Code processes stopped.
app.on("before-quit", () => {
  for (const dir of shareDirs) fs.rmSync(dir, { recursive: true, force: true });
  for (const controller of jobs.keys()) controller.abort();
  claudeCode.stopAll();
});

// ---------------------------------------------------------------- IPC

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });
// Only the app's own page, in its own window, may ask for anything.
const fromApp = (e) => win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
const wrap = (fn) => async (e, ...args) => {
  try {
    if (!fromApp(e)) throw coded("unknown");
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.code || "unknown", detail: String(err.detail || (err.code ? "" : err.message) || "").slice(0, 400) };
  }
};
const handle = (channel, fn) => ipcMain.handle(channel, wrap(fn));
const tell = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);
// Tokens are counted per exam, and where the price is known (Anthropic's own models) the cost.
const usageOf = (id) => (u) => {
  const { provider, model } = ai.config();
  const price = models.price(provider, model);
  store.addUsage(id, { ...u, cost: u.cost === undefined && price ? models.cost(price, u) : u.cost });
};
// Every kept answer is noted with its exam, so deleting the exam deletes it too.
const tracked = (id, signal) => ({ onUsage: usageOf(id), onKey: (key) => store.addAnswer(id, key), signal });

/**
 * Runs something for an exam that takes a while and that "Cancel" can stop. Only one thing
 * runs per exam; the window is told what it is at every change. `fn(signal, say)`: `say`
 * updates what is shown (a stage, how many pages are read).
 */
async function run(id, kind, fn) {
  if (runs.has(id)) throw coded("busy");
  const controller = new AbortController();
  const say = (patch) => {
    if (!runs.has(id)) return;
    runs.set(id, { ...runs.get(id), ...patch });
    tell("runs", Object.fromEntries(runs));
  };
  jobs.set(controller, id);
  runs.set(id, { kind, stage: kind, startedAt: Date.now() });
  tell("runs", Object.fromEntries(runs));
  try {
    return await fn(controller.signal, say);
  } finally {
    jobs.delete(controller);
    runs.delete(id);
    tell("runs", Object.fromEntries(runs));
  }
}
const today = () => planner.todayIso();
// The material the AI is reading right now, per exam (see "material: the AI reads pictures").
const reading = new Map(); // exam id -> Set of material ids
const decorate = (v) => ({ ...v, reading: [...(reading.get(v.id) || [])] });
const view = (id) => decorate(store.view(store.exam(id)));
/** Something changed in an exam without the window asking (the AI read a picture): the window gets the exam anew. */
const tellExam = (id) => {
  try {
    tell("exam", view(id));
  } catch {
    // the exam was deleted meanwhile
  }
};

handle("state", async () => ({ settings: store.settings(), exams: store.exams().map(decorate), ai: await ai.status(), runs: Object.fromEntries(runs), damaged: store.problem() }));

// The data file could not be read: the person chooses the backup or an empty start. The
// unreadable file is kept under another name either way.
handle("data:recover", (how) => {
  store.recover(how === "backup" ? "backup" : "empty", systemLang());
  if (!SAMPLE) files.prune(store.references());
  buildMenu();
});
handle("data:reveal", () => shell.showItemInFolder(path.join(app.getPath("userData"), "aced.json")));

handle("settings:set", async (patch) => {
  const before = origin(store.settings().ai.baseURL);
  const next = store.setSettings(patch);
  // Whether the AI can see is found out again for what is chosen now.
  if (patch.ai) ai.forgetSight();
  // The key for "another server" belongs to that server: at a new address it is forgotten.
  if (origin(next.ai.baseURL) !== before) await secrets.set("openai", "");
  applyAppearance(next.appearance);
  if (patch.lang) buildMenu();
  return { settings: next, ai: await ai.status() };
});
handle("ai:key", async (provider, key) => {
  if (!["anthropic", "openrouter", "openai"].includes(provider)) throw coded("unknown");
  await secrets.set(provider, key);
  ai.forgetSight();
  return ai.status();
});
handle("ai:test", () => ai.test());
// Claude Code on this Mac: installed? signed in? And its own sign-in, started for the person.
handle("claude:status", () => claudeCode.status());
handle("claude:signIn", () => claudeCode.signIn(store.settings().lang));
handle("claude:setup", () => shell.openExternal(claudeCode.SETUP_PAGE));

handle("exam:create", (draft) => decorate(store.view(store.createExam(draft))));
handle("exam:edit", (id, draft) => decorate(store.view(store.editExam(id, draft))));
handle("exam:delete", (id) => {
  for (const [controller, examId] of jobs) if (examId === id) controller.abort();
  store.deleteExam(id);
  // Its book copies, the text read from them and the answers kept for it go too, unless another exam uses them.
  if (!SAMPLE) files.prune(store.references());
});

// ------------------------------------------------ material

const GUESS = [
  ["objectives", /lernziel|objective|ziele|kompetenz|syllabus/i],
  ["oldExam", /pr(ü|ue)fung|exam|klausur|test|probe/i],
  ["slides", /folien|slides|pr(ä|ae)sentation|foliensatz/i],
  ["notes", /notiz|notes|zusammenfassung|summary|skript/i],
];
const SLIDES = new Set(["pptx", "ppt", "odp"]);
const guessKind = (item, title) => (item.pages > 40 ? "book" : (GUESS.find(([, re]) => re.test(title)) || [SLIDES.has(item.from) || item.format === "key" ? "slides" : "book"])[0]);

const MOST_FILES = 200; // files taken from one drop, choice, paste or folder
const MOST_DOCUMENTS = 40; // of them, files other than pictures (each is read on its own)
const MOST_DEPTH = 4; // folders inside folders
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * The files behind what was dropped or chosen: folders opened (four deep), what macOS and Office
 * leave in folders left out. A symbolic link is never followed, at the top or inside a folder
 * (an unpacked archive can hold one pointing at any file on this Mac): the person is told, once
 * for all of them.
 */
function expand(paths, problems) {
  const out = [];
  const links = [];
  let over = 0;
  const visit = (p, depth) => {
    const name = path.basename(p);
    if (depth > 0 && formats.isJunk(name)) return;
    const id = formats.identify(p);
    if (id.why === "link") {
      links.push(name);
      return;
    }
    if (id.kind === "folder") {
      if (depth >= MOST_DEPTH) return;
      let names = [];
      try {
        names = fs.readdirSync(p);
      } catch {
        problems.push({ title: name, code: "unreadable" });
        return;
      }
      for (const n of names.sort(natural)) visit(path.join(p, n), depth + 1);
      return;
    }
    if (out.length >= MOST_FILES) {
      over++;
      return;
    }
    out.push({ file: p, ...id });
  };
  for (const p of paths) visit(p, 0);
  if (links.length) problems.push({ title: links[0], code: links.length > 1 ? "links" : "link", detail: links.length > 1 ? links.slice(0, 6).map((n) => `“${n}”`).join(", ") + (links.length > 6 ? " …" : "") : "" });
  if (over) problems.push({ title: "", code: "tooMany", detail: String(MOST_FILES) });
  return out;
}

/** Pictures in the order they were taken: the time in the picture, else when the file was made, then by name. */
async function inOrderTaken(pictures, signal) {
  const info = await convert.pictureInfo(pictures.map((p) => p.file), signal).catch(() => []);
  return pictures
    .map((p, i) => {
      const taken = info[i] && info[i].taken ? Date.parse(info[i].taken) : NaN;
      let made = NaN;
      try {
        made = fs.statSync(p.file).birthtimeMs;
      } catch {
        // gone meanwhile: it fails later, with its name
      }
      return { ...p, time: Number.isFinite(taken) ? taken : made };
    })
    .sort((a, b) => (a.time || 0) - (b.time || 0) || natural(path.basename(a.file), path.basename(b.file)));
}

/** An error while adding, as a code the interface has a sentence for. */
const problemCode = (err) => {
  const code = err.code || err.message;
  if (["unsupported", "empty", "zip", "protected", "tooLarge", "tooManyPixels", "link"].includes(code)) return code;
  return /password/i.test(err.message) ? "protected" : "unreadable";
};

/**
 * Adds files: folders are opened, pictures added together become one document (in the order
 * they were taken), everything else is read file by file. Whatever could not be added, or
 * was there already, comes back as `problems` with a reason each. `names`: what to call files
 * that have no name of their own (a pasted screenshot). Pictures are read by the AI right after.
 */
function addFiles(id, paths, { names = new Map() } = {}) {
  return run(id, "read", async (signal, say) => {
    const problems = [];
    const lang = store.settings().lang;
    const shown = (file) => names.get(file) || path.basename(file);
    let items = expand(paths, problems);
    // An Aced file is an exam a friend shared: it becomes an exam of its own.
    const shared = items.filter((x) => x.ext === "aced");
    items = items.filter((x) => x.ext !== "aced");
    let opened = null;
    if (shared.length) {
      const r = await importShared(shared.map((x) => x.file), { signal });
      problems.push(...r.problems);
      opened = r.id;
    }
    for (const it of items.filter((x) => !x.kind)) problems.push({ title: shown(it.file), code: it.why === "zip" || it.why === "empty" ? it.why : "unsupported" });
    const pictures = items.filter((x) => x.kind === "picture");
    const others = items.filter((x) => x.kind && x.kind !== "picture");
    if (others.length > MOST_DOCUMENTS) problems.push({ title: "", code: "tooMany", detail: String(MOST_DOCUMENTS) });
    const progress = (title) => (done, total, phase, state) => say({ stage: "read", phase, state, title, done, total });
    const keep = (item, title) => {
      const already = store.addMaterial(id, item, guessKind(item, title));
      if (already) problems.push({ title, code: "duplicate", detail: already });
      else {
        if (item.cut) problems.push({ title, code: item.from === "xlsx" || item.from === "xls" || item.from === "ods" || item.from === "csv" ? "sheetCut" : "cut" });
        if (item.partial) problems.push({ title, code: "partial" });
        if (item.missingPictures) problems.push({ title, code: "missingPictures" });
        if (item.leftOut) problems.push({ title, code: "leftOut" });
      }
    };
    if (pictures.length) {
      const ordered = await inOrderTaken(pictures, signal);
      const title = shown(ordered[0].file);
      try {
        say({ stage: "read", phase: "convert", title, done: 0, total: 0 });
        const item = await files.addPictures(ordered.map((p) => p.file), progress(title), signal, { lang });
        for (const f of item.failed) problems.push({ title: shown(f.file), code: f.why === "large" ? "tooManyPixels" : "unreadable", detail: f.size });
        delete item.failed;
        // A pasted picture is named for what it is, not for the file it was kept in on the way.
        const first = ordered.find((p) => names.has(p.file));
        if (first) item.title = item.title.replace(path.basename(first.file, path.extname(first.file)), names.get(first.file));
        keep(item, item.title);
      } catch (err) {
        if (err.code === "cancelled") return { exam: view(id), problems };
        problems.push({ title, code: problemCode(err), detail: err.detail || "" });
      }
    }
    for (const it of others.slice(0, MOST_DOCUMENTS)) {
      const title = shown(it.file);
      try {
        say({ stage: "read", phase: it.kind === "pdf" ? "read" : "convert", title, done: 0, total: 0 });
        const item = await files.add(it.file, progress(title), signal, { lang });
        if (names.has(it.file)) item.title = names.get(it.file);
        keep(item, title);
      } catch (err) {
        if (err.code === "cancelled") break;
        problems.push({ title, code: problemCode(err), detail: err.detail || "" });
      }
    }
    // Right after, in the background: the AI reads what is only pictures.
    readPictures(id);
    // The same sentence twice says nothing new.
    const said = new Set();
    return { exam: view(id), problems: problems.filter((p) => !said.has(JSON.stringify(p)) && said.add(JSON.stringify(p))), opened: opened ? view(opened) : null };
  });
}

handle("material:choose", async (id) => {
  // Every file can be chosen, and folders too: what cannot be read is said, not hidden.
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "openDirectory", "multiSelections"] });
  return r.canceled ? { exam: view(id), problems: [] } : addFiles(id, r.filePaths);
});
handle("material:add", (id, paths) => addFiles(id, (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p)));

// Pasted and dropped data that is not a file on disk (a screenshot on the clipboard, a picture
// dragged out of a browser) is kept in a folder of the app's own until it has been added.
const pasteFolder = () => fs.mkdtempSync(path.join(app.getPath("temp"), "aced-pasted-"));
const safeName = (name, fallback) => String(name || "").replace(/[\/:\u0000-\u001f]/g, " ").replace(/^\.+/, "").trim().slice(0, 120) || fallback;
const EXT_OF_TYPE = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic", "image/tiff": ".tiff", "image/bmp": ".bmp", "image/svg+xml": ".svg", "application/pdf": ".pdf", "text/plain": ".txt", "text/html": ".html" };
const pastedName = (lang) => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${lang === "de" ? "Eingefügtes Bild" : "Pasted picture"} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
};

/**
 * What is on the clipboard: files copied in the Finder (⌘C: every one of them, by its address),
 * else a picture (a screenshot taken with ⌃⇧⌘4, a picture copied in Preview, Photos or a
 * browser), else text. Returns { files } | { image, ext } | { text } | {}.
 */
async function fromClipboard() {
  let items = [];
  try {
    items = await clipboard.read();
  } catch {
    return {};
  }
  const read = async (item, type) => item.getType(type).catch(() => null);
  // Files copied in the Finder come as a list of file addresses with the Finder's own list of
  // file names beside it. A link (a bookmark, "Copy Link" in a browser, a file:// address in
  // text) is not a file that was copied: its address is never opened, it stays text.
  const raw = (item, name) => item.types.includes(`electron application/osclipboard;format="${name}"`);
  const isLink = (item) =>
    item.types.includes("electron application/bookmark") || raw(item, "WebURLsWithTitlesPboardType") || raw(item, "CorePasteboardFlavorType 0x75726C20") || raw(item, "CorePasteboardFlavorType 0x75726C6E");
  const files = [];
  for (const item of items) {
    if (!item.types.includes("text/uri-list") || !raw(item, "NSFilenamesPboardType") || isLink(item)) continue;
    const list = await read(item, "text/uri-list");
    for (const line of String(list ? await list.text() : "").split(/\r?\n/)) {
      if (!line.startsWith("file://")) continue;
      try {
        files.push(fileURLToPath(line.trim()));
      } catch {
        // not an address of a file
      }
    }
  }
  const existing = files.filter((p) => fs.existsSync(p));
  if (existing.length) return { files: existing };
  for (const item of items) {
    const type = item.types.includes("image/png") ? "image/png" : item.types.find((t) => /tiff/i.test(t));
    if (!type) continue;
    const blob = await read(item, type);
    if (blob && blob.size > 0 && blob.size <= 200 * 1024 * 1024) return { image: Buffer.from(await blob.arrayBuffer()), ext: type === "image/png" ? ".png" : ".tiff" };
  }
  for (const item of items) {
    if (!item.types.includes("text/plain")) continue;
    const blob = await read(item, "text/plain");
    const text = blob ? await blob.text() : "";
    if (text.trim()) return { text };
  }
  return {};
}

/**
 * ⌘V on the material: files copied in the Finder are added as files; a picture as a picture;
 * text comes back so the window can open it in the box for pasted text.
 */
handle("material:paste", async (id) => {
  const found = await fromClipboard();
  if (found.files) return addFiles(id, found.files);
  if (found.image) {
    const folder = pasteFolder();
    const name = pastedName(store.settings().lang);
    const file = path.join(folder, "pasted" + found.ext);
    fs.writeFileSync(file, found.image);
    try {
      return await addFiles(id, [file], { names: new Map([[file, name]]) });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
  if (found.text) return { exam: view(id), problems: [], text: found.text.slice(0, 3000000) };
  return { exam: view(id), problems: [{ title: "", code: "emptyClipboard" }] };
});

/**
 * Dropped data without a place on disk: a picture dragged out of a browser or an app that
 * hands over the picture itself. At most 20 items of 60 MB each; they are written to the app's
 * own folder and added like files. (No path comes from the window here: only the bytes.)
 */
handle("material:bytes", async (id, items) => {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw coded("unknown");
  const folder = pasteFolder();
  try {
    const names = new Map();
    const paths = items.map((item, i) => {
      const data = item && item.data;
      if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 60 * 1024 * 1024) throw coded("unknown");
      const shownName = safeName(item.name, pastedName(store.settings().lang));
      const ext = path.extname(shownName) || EXT_OF_TYPE[String(item.type || "").toLowerCase()] || "";
      const file = path.join(folder, `${i + 1}${ext}`);
      fs.writeFileSync(file, data);
      names.set(file, path.basename(shownName, path.extname(shownName)) || shownName);
      return file;
    });
    return await addFiles(id, paths, { names });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// ------------------------------------------------ material: the AI reads pictures

const readings = new Map(); // exam id -> the reading under way (a promise), so a run can wait for it

/**
 * Has the AI read the pictures of an exam's material, one document after the other, in the
 * background: the material just added, or (`ids`) the ones the person asked for again.
 * Nothing is asked of the person first (a document has at most twenty pages). The window is
 * told about every change. When the AI cannot see, fails or is not reachable, the text read on
 * this Mac stays, and the material says so.
 */
function readPictures(id, ids = null) {
  let exam;
  try {
    exam = store.exam(id);
  } catch {
    return;
  }
  const todo = exam.materials.filter((m) => see.eligible(m) && m.read !== "ai" && (ids ? ids.includes(m.id) : m.read === undefined)).map((m) => m.id);
  if (!todo.length) return;
  const mine = reading.get(id) || new Set();
  todo.forEach((m) => mine.add(m));
  reading.set(id, mine);
  tellExam(id);
  const before = readings.get(id) || Promise.resolve();
  const job = before.then(() => readEach(id, todo));
  readings.set(id, job);
  job.finally(() => {
    if (readings.get(id) === job) readings.delete(id);
  });
}

async function readEach(id, todo) {
  for (const materialId of todo) {
    const controller = new AbortController();
    jobs.set(controller, id);
    try {
      const m = store.exam(id).materials.find((x) => x.id === materialId);
      if (!m) continue;
      const text = files.readText(m.hash);
      // Read by an AI before (in another exam, or before an undo): nothing to ask again.
      if (text && text.reader === "ai") {
        store.patchMaterials(m.hash, { read: "ai", model: text.model, readFailed: undefined });
        continue;
      }
      const { provider, model: chosen } = ai.config();
      const price = models.price(provider, chosen);
      let cost = 0;
      let priced = false;
      const usage = usageOf(id);
      const onUsage = (u) => {
        usage(u);
        if (typeof u.cost === "number") {
          cost += u.cost;
          priced = true;
        } else if (price) {
          cost += models.cost(price, u);
          priced = true;
        }
      };
      const { pages, model } = await see.read(m, { signal: controller.signal, onUsage, onKey: (key) => store.addAnswer(id, key) });
      files.writeText(m.hash, { ...(text || { outline: [] }), pages, recognised: true, reader: "ai", model });
      store.patchMaterials(m.hash, {
        read: "ai",
        model,
        readFailed: undefined,
        chars: pages.reduce((sum, p) => sum + p.length, 0),
        scanned: files.textless(pages),
        offset: files.printedOffset(pages),
        ...(priced && provider !== "claudeCode" ? { readCost: cost } : {}),
      });
    } catch (err) {
      const known = ["cannotSee", "noProvider", "offline", "noKey", "badKey", "signIn", "usageLimit", "noClaudeCode", "noCredit", "rateLimit"];
      const busy = { slow: "offline", overloaded: "rateLimit", serverError: "rateLimit" };
      const code = err.code === "cancelled" ? "cancelled" : known.includes(err.code) ? err.code : busy[err.code] || "failed";
      try {
        const m = store.exam(id).materials.find((x) => x.id === materialId);
        if (m) store.patchMaterials(m.hash, { read: "local", readFailed: code });
      } catch {
        // the exam is gone
      }
    } finally {
      jobs.delete(controller);
      reading.get(id)?.delete(materialId);
      tellExam(id);
    }
  }
}

/** "Read with AI": another try for material the AI could not read. */
handle("material:see", (id, materialId) => {
  readPictures(id, [String(materialId)]);
  return view(id);
});

/** A title for pasted text: its own first words, so two pasted texts can be told apart. */
const titleOf = (text, fallback) => {
  const first = String(text).split("\n").map((l) => l.replace(/^[\s\-–•*#\d.)]+/, "").trim()).find(Boolean) || "";
  return first ? first.slice(0, 60) + (first.length > 60 ? "…" : "") : fallback;
};

handle("material:text", (id, kind, title, text) => {
  let item;
  try {
    item = files.addText(text, titleOf(text, String(title).slice(0, 80)));
  } catch {
    throw coded("empty");
  }
  const already = store.addMaterial(id, item, kind);
  if (already) throw coded("duplicate", already);
  return view(id);
});
/** The text of a pasted material, to look at or change. */
handle("material:read", (id, materialId) => {
  const m = store.exam(id).materials.find((x) => x.id === materialId);
  const data = m && m.type === "text" ? files.readText(m.hash) : null;
  if (!data) throw coded("unknown");
  return data.pages.join("\n\n");
});
/** A pasted text, changed: the new text takes the place of the old one. */
handle("material:retext", (id, materialId, text) => {
  const old = store.exam(id).materials.find((x) => x.id === materialId);
  if (!old || old.type !== "text") throw coded("unknown");
  let item;
  try {
    item = files.addText(text, titleOf(text, old.title));
  } catch {
    throw coded("empty");
  }
  if (item.hash === old.hash) return view(id);
  store.change(id, (exam) => {
    const at = exam.materials.findIndex((x) => x.id === materialId);
    if (exam.materials.some((x) => x.hash === item.hash)) exam.materials.splice(at, 1);
    else exam.materials[at] = { ...old, ...item };
    if (exam.strategy) exam.strategy.stale = true;
  });
  return view(id);
});
handle("material:kind", (id, materialId, kind) => decorate(store.view(store.setMaterialKind(id, materialId, kind))));
// Removing keeps the files until the app is next started, so "Undo" can bring the material back.
handle("material:remove", (id, materialId) => {
  const removed = store.exam(id).materials.find((m) => m.id === materialId) || null;
  return { exam: decorate(store.view(store.removeMaterial(id, materialId))), removed };
});
handle("material:restore", (id, item) => {
  if (!item || !/^[a-f0-9]{64}$/.test(String(item.hash)) || !files.readText(item.hash)) throw coded("unknown");
  const { id: materialId, kind, hash, type, title, pages, chars, offset, scanned, recognised } = item;
  const word = (v, re) => (typeof v === "string" && re.test(v) ? v : undefined);
  const extra = {
    from: word(item.from, /^[a-z]{2,10}$/),
    format: word(item.format, /^[a-z0-9]{1,10}$/),
    files: Number.isInteger(item.files) ? item.files : undefined,
    read: word(item.read, /^(ai|local)$/),
    model: word(item.model, /^[\w.:/@-]{1,120}$/),
    readCost: typeof item.readCost === "number" && Number.isFinite(item.readCost) ? item.readCost : undefined,
    readFailed: word(item.readFailed, /^[a-zA-Z]{1,30}$/),
    hiddenSheets: Array.isArray(item.hiddenSheets) ? item.hiddenSheets.filter((n) => typeof n === "string").slice(0, 50).map((n) => n.slice(0, 100)) : undefined,
    missingPictures: Number.isInteger(item.missingPictures) ? item.missingPictures : undefined,
    leftOut: Number.isInteger(item.leftOut) ? item.leftOut : undefined,
    cut: item.cut === true || undefined,
    partial: item.partial === true || undefined,
  };
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
  store.addMaterial(id, { id: String(materialId).slice(0, 8), hash, type: type === "pdf" ? "pdf" : "text", title: String(title).slice(0, 200), pages: Number(pages) || 1, chars: Number(chars) || 0, offset: Number(offset) || 0, scanned: Boolean(scanned), recognised: Boolean(recognised), ...extra }, kind);
  return view(id);
});

// ------------------------------------------------ sharing an exam

const shareDirs = new Set(); // made for a share; deleted when the app quits (the share menu may still be reading them)
const shareFolder = () => {
  const dir = share.tempDir();
  shareDirs.add(dir);
  return dir;
};

/** The file to share: an Aced file, a PDF or a web page of the exam, in a folder of its own. Resolves to its path. */
async function makeShare(id, output, chosen) {
  const exam = store.exam(id);
  if (!exam.strategy) throw coded("unknown");
  const dir = shareFolder();
  const lang = store.settings().lang;
  if (output === "aced") {
    const file = path.join(dir, share.fileName(exam.name, "aced"));
    const known = new Set(exam.materials.map((m) => m.id));
    const bytes = share.pack(exam, {
      chosen: (Array.isArray(chosen) ? chosen : []).filter((m) => known.has(m)),
      appVersion: app.getVersion(),
      pdfOf: (m) => (fs.existsSync(files.pdfPath(m.hash)) ? fs.readFileSync(files.pdfPath(m.hash)) : null),
      textOf: (m) => files.readText(m.hash),
    });
    fs.writeFileSync(file, bytes);
    return file;
  }
  const page = await examPage(exam, { lang });
  const html = path.join(dir, share.fileName(exam.name, "html"));
  fs.writeFileSync(html, page);
  if (output === "web") return html;
  const pdf = path.join(dir, share.fileName(exam.name, "pdf"));
  await print(html, pdf, { footer: footerOf(lang) });
  fs.rmSync(html, { force: true });
  return pdf;
}

/**
 * Shares an exam: `how` is "menu" (macOS's share menu: AirDrop, Messages, Mail …) or "save"
 * (a place the person chooses). Resolves to { saved: name } or { shown: true } or { cancelled }.
 */
handle("share:send", async (id, options) => {
  const output = ["aced", "pdf", "web"].includes(options && options.output) ? options.output : "aced";
  const file = await makeShare(id, output, options && options.materials);
  if (options && options.how === "save") {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), path.basename(file)) });
    if (r.canceled || !r.filePath) return { cancelled: true };
    fs.copyFileSync(file, r.filePath);
    return { saved: path.basename(r.filePath) };
  }
  if (process.platform === "darwin" && ShareMenu) {
    new ShareMenu({ filePaths: [file] }).popup({ window: win });
    return { shown: true };
  }
  shell.showItemInFolder(file);
  return { shown: true };
});

const today_ = () => planner.todayIso();

/**
 * Opens Aced files a friend sent: each becomes a new exam at 0%, with the material that came
 * along added the way any file is, and the books that did not come along waiting for the
 * person's own copy (found at once when this Mac already has the same file). Resolves to the
 * id of the last exam made, and the problems ([{ title, code, detail }]).
 */
async function importShared(paths, { signal } = {}) {
  const problems = [];
  let last = null;
  for (const file of paths) {
    try {
      last = await share.importExam(file, { store, files, lang: store.settings().lang, today: today_(), signal });
      readPictures(last);
    } catch (err) {
      if (err.code === "cancelled") break;
      problems.push({ title: path.basename(file), code: err.code === "newer" ? "aceNewer" : err.code === "tooLarge" ? "tooLarge" : "aceDamaged", detail: err.detail || "" });
    }
  }
  return { id: last, problems };
}

/** Aced files from the Finder or the menu: imported, and the window goes to the new exam. */
async function openShared(paths) {
  const { id, problems } = await importShared(paths.filter((p) => typeof p === "string"));
  tell("opened", { id, exam: id ? view(id) : null, problems });
}

async function chooseShared() {
  if (!win || win.isDestroyed()) return;
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters: [{ name: "Aced", extensions: ["aced"] }, { name: "*", extensions: ["*"] }] });
  if (!r.canceled && r.filePaths.length) openShared(r.filePaths);
}

/**
 * The person's own copy of a book that a shared exam names: chosen in a dialog, or dropped
 * (`files` from a drop). It takes the book's place in the plan. The same file (same SHA-256)
 * fits at once; another one is compared by its pages and title, and called another edition when
 * they differ.
 */
handle("material:supply", async (id, materialId, paths) => {
  const exam = store.exam(id);
  const wanted = exam.materials.find((m) => m.id === materialId && m.missing);
  if (!wanted) throw coded("unknown");
  let file = Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : null;
  if (!file) {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile"] });
    if (r.canceled || !r.filePaths.length) return { exam: view(id), problems: [] };
    file = r.filePaths[0];
  }
  return run(id, "read", async (signal, say) => {
    const { edition, item, expect } = await share.supplyBook(id, materialId, file, {
      store,
      files,
      lang: store.settings().lang,
      signal,
      onProgress: (done, total, phase, state) => say({ stage: "read", phase, state, title: wanted.title, done, total }),
    });
    readPictures(id);
    return { exam: view(id), problems: edition === "other" ? [{ title: item.title, code: "otherEdition", detail: `${item.pages}|${expect.pages}` }] : [] };
  });
});

// ------------------------------------------------ analysis

/** A model's price from OpenRouter's public list (fetched once, when an estimate needs it). */
async function openRouterPrice(model) {
  try {
    const p = (await ai.openRouterModels()).find((m) => m.id === model)?.pricing;
    return p ? [Number(p.prompt) * 1e6, Number(p.completion) * 1e6] : null;
  } catch {
    return null;
  }
}

/**
 * The text of every material of an exam is there: the AI has finished reading pictures (a
 * plan made meanwhile would use the weaker text read on this Mac), and a PDF whose text was
 * lost is read again from the library.
 */
async function ensureTexts(id, signal, say) {
  if (readings.has(id)) {
    say({ stage: "seeing" });
    await Promise.race([readings.get(id).catch(() => {}), new Promise((resolve) => signal.addEventListener("abort", resolve))]);
    if (signal.aborted) throw coded("cancelled");
  }
  for (const m of store.exam(id).materials) {
    await files.ensureText(m, (done, total, phase, state) => say({ stage: "read", phase, state, title: m.title, done, total }), signal);
  }
}

/** What a strategy was made from: the material, the exam's own numbers and the model. The same again gives the same strategy. */
function basisOf(exam) {
  const { provider, model } = ai.config();
  return files.sha(JSON.stringify([exam.materials.map((m) => (m.read === "ai" ? [m.hash, m.kind, "ai"] : [m.hash, m.kind])), exam.name, exam.date, exam.time, exam.scale, exam.target, exam.pace, provider, model]));
}

handle("analysis:estimate", async (id) => {
  await run(id, "read", (signal, say) => ensureTexts(id, signal, say));
  const exam = store.exam(id);
  const est = engine.estimate(exam);
  const status = await ai.status();
  const price = status.provider === "openrouter" ? await openRouterPrice(status.model) : status.price;
  // With Anthropic's own key the pages are written to its cache once and read from it for the formula sheet.
  const cached = status.provider === "anthropic" && price && price[2] !== undefined;
  const cost = (input) => (price ? (input * price[0] * (cached ? 1.25 : 1) + est.again * (cached ? price[2] : price[0]) + est.output * price[1]) / 1e6 : null);
  return {
    ...est,
    input: est.input + est.again,
    inputMax: est.inputMax + Math.round(est.again * (est.inputMax / Math.max(1, est.input))),
    provider: status.provider,
    model: status.model,
    ready: status.ready,
    // With Claude Code the person may have to sign in first: the panel says so before anything starts.
    claude: status.provider === "claudeCode" ? await claudeCode.status() : null,
    cost: cost(est.input),
    costMax: price ? cost(est.inputMax) * 1.6 : null,
    // Nothing has changed since the strategy was made: running it again would give the same one.
    unchanged: Boolean(exam.strategy && !exam.strategy.stale && exam.strategy.basis === basisOf(exam)),
    // Pages the AI is still reading: the plan waits for them.
    reading: exam.materials.filter((m) => (reading.get(id) || new Set()).has(m.id)).reduce((sum, m) => sum + m.pages, 0),
    ticked: exam.strategy ? exam.strategy.topics.flatMap((t) => t.steps).filter((step) => exam.done[step.id]).length : 0,
  };
});

/** Works out the strategy and, right after, the formula sheet. `again`: ask the model anew even though nothing changed. */
handle("analysis:run", (id, options) =>
  run(id, "strategy", async (signal, say) => {
    await ensureTexts(id, signal, say);
    const exam = store.exam(id);
    const daysLeft = Math.max(0, planner.diffDays(today(), exam.date));
    const days = Math.max(1, daysLeft);
    const minutesPerDay = exam.time.mode === "perDay" ? exam.time.minutes : Math.round(exam.time.minutes / days);
    const minutesTotal = exam.time.mode === "perDay" ? minutesPerDay * days : exam.time.minutes;
    say({ stage: "strategy" });
    // Exercises that are ticked off are named, so the new plan hands out others where the book has them.
    const strategy = await engine.analyze(exam, { today: today(), daysLeft, minutesTotal, minutesPerDay, solved: store.solved(exam) }, { onProgress: (p) => say(p), ...tracked(id, signal), fresh: Boolean(options && options.again) });
    strategy.basis = basisOf(exam);
    store.setStrategy(id, strategy);
    const progress = store.exam(id).previous || { kept: 0, lost: 0 };
    // The formula sheet belongs to the strategy. If it fails, the strategy still stands; the sheet is asked for again when it is opened.
    try {
      say({ stage: "formulas" });
      const formulas = await engine.writeFormulas(store.exam(id), tracked(id, signal));
      store.change(id, (e) => (e.formulas = formulas));
    } catch (err) {
      if (err.code === "cancelled") throw err;
    }
    return { exam: view(id), kept: progress.kept, lost: progress.lost };
  }),
);

/** Takes the last new strategy back: the plan before it, with its ticks, results and formula sheet. */
handle("strategy:undo", (id) => {
  if (runs.has(id)) throw coded("busy");
  return decorate(store.view(store.undoStrategy(id)));
});

/** Stops what is running for one exam (or everything, when no exam is named). */
handle("cancel", (id) => {
  for (const [controller, examId] of jobs) if (!id || examId === id) controller.abort();
});

// ------------------------------------------------ formula sheet and helper

handle("formulas", async (id) => {
  const exam = store.exam(id);
  if (!exam.strategy) throw coded("unknown");
  if (!exam.formulas) {
    const formulas = await run(id, "formulas", async (signal, say) => {
      await ensureTexts(id, signal, say);
      say({ stage: "formulas" });
      return engine.writeFormulas(exam, tracked(id, signal));
    });
    store.change(id, (e) => (e.formulas = formulas));
  }
  return view(id);
});

// A question to the helper is short and may run beside anything else: it is not a "run".
handle("help", async (id, question, context) => {
  const controller = new AbortController();
  jobs.set(controller, id);
  try {
    const exam = store.exam(id);
    if (!exam.strategy) throw coded("unknown");
    if (readings.has(id)) await readings.get(id).catch(() => {});
    for (const m of exam.materials) await files.ensureText(m, () => {}, controller.signal);
    const earlier = Array.isArray(context && context.earlier) ? context.earlier.filter((x) => x && typeof x.question === "string" && typeof x.answer === "string").slice(-3) : [];
    return await engine.help(exam, question, { earlier, now: String((context && context.now) || "").slice(0, 300) }, tracked(id, controller.signal));
  } finally {
    jobs.delete(controller);
  }
});

// ------------------------------------------------ plan

const taskOf = (exam, taskId) => planner.buildPlan(exam, today())?.stages.flatMap((stage) => stage.tasks).find((t) => t.id === taskId);

handle("task:done", (id, taskId) => {
  const task = taskOf(store.exam(id), taskId);
  // Questions are done by answering them, not by a tick.
  if (!task || task.kind === "quiz") throw coded("unknown");
  return decorate(store.view(store.change(id, (e) => (e.done[taskId] = { date: today(), minutes: task.minutes, at: Date.now() }))));
});
handle("task:undo", (id, taskId) => {
  const task = taskOf(store.exam(id), taskId);
  if (!task || task.kind === "quiz") throw coded("unknown");
  return decorate(store.view(store.change(id, (e) => delete e.done[taskId])));
});

// ------------------------------------------------ the final exam, and questions on a topic

/** A question as it is asked: without its answer. */
const asked = ({ id, topicId, type, prompt, unit, choices, points }) => ({ id, topicId, type, prompt, unit: unit || "", choices: choices || [], points });
const topicTitle = (exam, topicId, set) => (exam.strategy.topics.find((t) => t.id === topicId) || {}).title || (set && set.titles && set.titles[topicId]) || "";

/** A set as the window gets it. The answers come along only once it has a result. */
function shown(exam, set) {
  return {
    key: set.key,
    final: set.final,
    title: set.final ? "" : topicTitle(exam, set.topicIds[0], set),
    questions: set.result ? set.questions : set.questions.map(asked),
    draft: set.draft || {},
    result: set.result || null,
    topics: Object.fromEntries([...new Set([...set.topicIds, ...Object.keys((set.result && set.result.topics) || {})])].map((t) => [t, topicTitle(exam, t, set)])),
    scale: exam.scale,
    target: exam.target,
  };
}

/**
 * Opens the final exam (`{ kind: "final" }`) or the questions of one step (`{ kind: "topic",
 * stepId }`): the one that is waiting to be answered, or a new one. `another`: write a new
 * final exam although the last one has a result.
 */
handle("set:open", async (id, what) => {
  const exam = store.exam(id);
  const strategy = exam.strategy;
  if (!strategy) throw coded("unknown");
  let request;
  let kind;
  if (what && what.kind === "final") {
    kind = "final";
    const last = store.latestSet(exam, kind);
    if (last && (!last.result || !what.another)) return shown(exam, last);
    const plan = planner.buildPlan(exam, today());
    const dropped = new Set(plan.dropped.map((d) => d.topicId));
    const topicIds = strategy.topics.filter((t) => !dropped.has(t.id)).map((t) => t.id);
    const variant = last ? last.variant + 1 : 0;
    request = { key: `final#${variant}`, final: true, topicIds, count: Math.max(6, Math.min(12, topicIds.length * 2)), variant };
  } else {
    const task = taskOf(exam, what && what.stepId);
    if (!task || task.kind !== "quiz") throw coded("unknown");
    kind = `topic:${task.id}`;
    const last = store.latestSet(exam, kind);
    if (last) return shown(exam, last);
    // Other questions than an earlier set on the same topic asked.
    const variant = Object.values(exam.sets).filter((x) => !x.final && x.topicIds[0] === task.topicId).length;
    request = { key: `${kind}#0`, topicIds: [task.topicId], count: task.step.questions || 4, variant, stepId: task.id };
  }
  if (SAMPLE) throw coded("sampleOnly");
  const set = await run(id, "questions", async (signal, say) => {
    await ensureTexts(id, signal, say);
    say({ stage: "questions" });
    return engine.writeQuestions(exam, request, tracked(id, signal));
  });
  const titles = Object.fromEntries(set.topicIds.map((t) => [t, topicTitle(exam, t)]));
  store.change(id, (e) => (e.sets[set.key] = { ...set, titles, variant: request.variant, stepId: request.stepId || null, createdOn: today(), draft: {}, result: null }));
  return shown(store.exam(id), store.exam(id).sets[set.key]);
});

/** What has been typed so far is kept, so leaving the exam loses nothing. */
handle("set:draft", (id, key, draft) => {
  store.change(id, (e) => {
    const set = e.sets[key];
    if (!set || set.result || !draft || typeof draft !== "object") return;
    set.draft = Object.fromEntries(set.questions.map((q) => [q.id, draft[q.id]]).filter(([, v]) => (typeof v === "string" && v.length <= 4000) || Number.isInteger(v)));
  });
});

/** What goes back on the list for a topic that went badly: its theory again, and exercises not yet done. */
function againFor(exam, set, topicId, ratio) {
  const topic = exam.strategy.topics.find((t) => t.id === topicId);
  const id = `${topicId}/a${Date.now().toString(36)}`;
  const reads = topic.steps.filter((s) => s.kind === "read").map((s, i) => ({ ...s, id: `${id}/r${i}`, minutes: Math.max(3, Math.round(s.minutes / 2)) }));
  const spare = (set.spare && set.spare[topicId]) || [];
  const solves = spare.length
    ? spare.map((x, i) => ({ id: `${id}/s${i}`, kind: "solve", material: x.material, page: x.page, labels: x.labels, minutes: x.minutes, unconfirmed: [] }))
    : topic.steps.filter((s) => s.kind === "solve").map((s, i) => ({ ...s, id: `${id}/s${i}`, repeat: true }));
  const quiz = topic.steps.find((s) => s.kind === "quiz");
  // A topic whose book has no exercises is asked again with new questions.
  const steps = solves.length || !quiz ? [...reads, ...solves] : [...reads, { ...quiz, id: `${id}/q` }];
  return { id, topicId, from: set.key, score: ratio, steps };
}

/** What the marks of a set add up to: points, a grade, and the topics that went badly (under 60% of their points). */
function resultOf(exam, set, typed, marks, at = Date.now()) {
  const points = Object.values(marks).reduce((sum, m) => sum + m.points, 0);
  const max = Object.values(marks).reduce((sum, m) => sum + m.max, 0) || 1;
  const byTopic = {};
  for (const q of set.questions) {
    const t = byTopic[q.topicId] || { points: 0, max: 0 };
    byTopic[q.topicId] = { points: t.points + marks[q.id].points, max: t.max + marks[q.id].max };
  }
  const weak = Object.entries(byTopic).filter(([, t]) => t.max && t.points / t.max < 0.6).map(([topicId]) => topicId);
  return { date: today(), at, typed, marks, points, max, grade: planner.gradeFor(exam.scale, points / max), weak, topics: byTopic };
}

/** Writes a result into the exam: the record, the step it belongs to, and the list (weak topics come back, others leave it again). */
function settle(e, key, result) {
  const set = e.sets[key];
  const first = !set.result;
  set.result = result;
  set.draft = {};
  const entry = { date: result.date, at: result.at, final: Boolean(set.final), points: result.points, max: result.max, grade: result.grade };
  const at = e.results.findIndex((r) => r.at === result.at);
  if (at >= 0) e.results[at] = entry;
  else e.results.push(entry);
  if (first && set.stepId) e.done[set.stepId] = { date: today(), minutes: Math.max(5, set.questions.length * 2), at: Date.now() };
  // A topic that is no longer weak (a mark was put right) leaves the list again, with its ticks.
  for (const a of e.again.filter((x) => x.from === key && !result.weak.includes(x.topicId))) for (const step of a.steps) delete e.done[step.id];
  e.again = e.again.filter((x) => x.from !== key || result.weak.includes(x.topicId));
  for (const topicId of result.weak) {
    if (!e.strategy.topics.some((t) => t.id === topicId) || e.again.some((a) => a.from === key && a.topicId === topicId)) continue;
    // At most twice per topic: after that it is the person's call, not the list's.
    if (e.again.filter((a) => a.topicId === topicId).length >= 2) continue;
    const again = againFor(e, set, topicId, result.topics[topicId].points / result.topics[topicId].max);
    if (again.steps.length) e.again.push(again);
  }
}

handle("set:submit", async (id, key, typed) => {
  const before = store.exam(id);
  const set = before.sets[key];
  if (!set || set.result || !typed || typeof typed !== "object") throw coded("unknown");
  // Kept first: if marking fails, what was typed is still there.
  store.change(id, (e) => (e.sets[key].draft = typed));
  const marks = SAMPLE ? require("./src/sample").marks(set, typed) : await run(id, "marks", (signal) => engine.mark(set.questions, typed, tracked(id, signal)));
  store.change(id, (e) => settle(e, key, resultOf(e, set, typed, marks)));
  const exam = store.exam(id);
  return { exam: decorate(store.view(exam)), set: shown(exam, exam.sets[key]) };
});

/** "My result was right": the person overrules a mark. The points, the grade and the list follow. */
handle("set:overrule", (id, key, questionId) => {
  const exam = store.exam(id);
  const set = exam.sets[key];
  const q = set && set.result && set.questions.find((x) => x.id === questionId);
  if (!q) throw coded("unknown");
  store.change(id, (e) => {
    const r = e.sets[key].result;
    const marks = { ...r.marks, [questionId]: { points: q.points, max: q.points, note: "", by: "you" } };
    settle(e, key, resultOf(e, e.sets[key], r.typed, marks, r.at));
  });
  const after = store.exam(id);
  return { exam: decorate(store.view(after)), set: shown(after, after.sets[key]) };
});

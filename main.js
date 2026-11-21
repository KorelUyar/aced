const { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu, dialog, session, protocol, net } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const brand = require("./src/brand");
const store = require("./src/store");
const files = require("./src/files");
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
protocol.registerSchemesAsPrivileged([{ scheme: "spurt-book", privileges: { supportFetchAPI: true, stream: true, corsEnabled: true } }]);

// Only one copy of the app at a time: two would overwrite each other's file.
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// `--sample` (or SPURT_SAMPLE=1) starts with invented exams kept in memory only. It is how the
// screenshots are made; nothing is read from or written to the person's real data.
const SAMPLE = process.argv.includes("--sample") || process.env.SPURT_SAMPLE === "1";

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

/** German on a German Mac, English everywhere else. (SPURT_LANG stands in for the Mac's language in tests.) */
function systemLang() {
  const forced = !app.isPackaged && process.env.SPURT_LANG;
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
      additionalArguments: [`--spurt-name=${brand.name}`, `--spurt-sample=${SAMPLE ? 1 : 0}`],
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

app.whenReady().then(() => {
  if (!single) return;
  // Nothing in this app needs the camera, the location or any other permission a page can ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // The book panel asks for a large file in parts (a 300 MB scan need not sit in memory whole):
  // a request with a Range gets exactly that part, said the way a web server says it.
  protocol.handle("spurt-book", async (request) => {
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
  files.init(SAMPLE ? fs.mkdtempSync(path.join(os.tmpdir(), "spurt-sample-")) : userData);
  // Test runs from the source folder can keep keys in memory only (SPURT_KEYS=memory), so they
  // leave nothing in the keychain. The app people install always stores them.
  secrets.init(userData, { persist: !SAMPLE && !(process.env.SPURT_KEYS === "memory" && !app.isPackaged) });
  store.init({ dir: userData, sample: SAMPLE, systemLang: systemLang() });
  ai.init(() => store.settings());
  // Whatever an earlier run left without an owner goes. Not while the data file is unreadable:
  // then nothing is known to be without an owner.
  if (!SAMPLE && !store.problem()) files.prune(store.references());
  applyAppearance(store.settings().appearance);
  buildMenu();
  createWindow();
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
const view = (id) => store.view(store.exam(id));

handle("state", async () => ({ settings: store.settings(), exams: store.exams(), ai: await ai.status(), runs: Object.fromEntries(runs), damaged: store.problem() }));

// The data file could not be read: the person chooses the backup or an empty start. The
// unreadable file is kept under another name either way.
handle("data:recover", (how) => {
  store.recover(how === "backup" ? "backup" : "empty", systemLang());
  if (!SAMPLE) files.prune(store.references());
  buildMenu();
});
handle("data:reveal", () => shell.showItemInFolder(path.join(app.getPath("userData"), "spurt.json")));

handle("settings:set", async (patch) => {
  const before = origin(store.settings().ai.baseURL);
  const next = store.setSettings(patch);
  // The key for "another server" belongs to that server: at a new address it is forgotten.
  if (origin(next.ai.baseURL) !== before) await secrets.set("openai", "");
  applyAppearance(next.appearance);
  if (patch.lang) buildMenu();
  return { settings: next, ai: await ai.status() };
});
handle("ai:key", async (provider, key) => {
  if (!["anthropic", "openrouter", "openai"].includes(provider)) throw coded("unknown");
  await secrets.set(provider, key);
  return ai.status();
});
handle("ai:test", () => ai.test());
// Claude Code on this Mac: installed? signed in? And its own sign-in, started for the person.
handle("claude:status", () => claudeCode.status());
handle("claude:signIn", () => claudeCode.signIn(store.settings().lang));
handle("claude:setup", () => shell.openExternal(claudeCode.SETUP_PAGE));

handle("exam:create", (draft) => store.view(store.createExam(draft)));
handle("exam:edit", (id, draft) => store.view(store.editExam(id, draft)));
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

/** Adds files. Whatever could not be added, or was there already, comes back as `problems` with a reason each. */
function addFiles(id, paths) {
  return run(id, "read", async (signal, say) => {
    const problems = [];
    for (const file of paths.slice(0, 20)) {
      const title = path.basename(file);
      try {
        say({ stage: "read", phase: "read", title, done: 0, total: 0 });
        const item = await files.add(file, (done, total, phase, state) => say({ stage: "read", phase, state, title, done, total }), signal);
        const guess = item.pages > 40 ? "book" : (GUESS.find(([, re]) => re.test(title)) || ["book"])[0];
        const already = store.addMaterial(id, item, guess);
        if (already) problems.push({ title, code: "duplicate", detail: already });
        else if (item.cut) problems.push({ title, code: "cut" });
      } catch (err) {
        if (err.code === "cancelled") break;
        const code = ["unsupported", "empty"].includes(err.message) ? err.message : /password/i.test(err.message) ? "protected" : "unreadable";
        problems.push({ title, code });
      }
    }
    return { exam: view(id), problems };
  });
}

handle("material:choose", async (id) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF, text", extensions: ["pdf", "txt", "md"] }],
  });
  return r.canceled ? { exam: view(id), problems: [] } : addFiles(id, r.filePaths);
});
handle("material:add", (id, paths) => addFiles(id, (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p)));

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
handle("material:kind", (id, materialId, kind) => store.view(store.setMaterialKind(id, materialId, kind)));
// Removing keeps the files until the app is next started, so "Undo" can bring the material back.
handle("material:remove", (id, materialId) => {
  const removed = store.exam(id).materials.find((m) => m.id === materialId) || null;
  return { exam: store.view(store.removeMaterial(id, materialId)), removed };
});
handle("material:restore", (id, item) => {
  if (!item || !/^[a-f0-9]{64}$/.test(String(item.hash)) || !files.readText(item.hash)) throw coded("unknown");
  const { id: materialId, kind, hash, type, title, pages, chars, offset, scanned, recognised } = item;
  store.addMaterial(id, { id: String(materialId).slice(0, 8), hash, type: type === "pdf" ? "pdf" : "text", title: String(title).slice(0, 200), pages: Number(pages) || 1, chars: Number(chars) || 0, offset: Number(offset) || 0, scanned: Boolean(scanned), recognised: Boolean(recognised) }, kind);
  return view(id);
});

// ------------------------------------------------ analysis

let prices = null; // OpenRouter's public price list, fetched once when an estimate needs it
async function openRouterPrice(model) {
  try {
    if (!prices) {
      const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(6000) });
      prices = (await res.json()).data || [];
    }
    const p = prices.find((m) => m.id === model)?.pricing;
    return p ? [Number(p.prompt) * 1e6, Number(p.completion) * 1e6] : null;
  } catch {
    return null;
  }
}

/** The text of every PDF of an exam is on disk again (it is re-read from the library copy if it was lost). */
async function ensureTexts(id, signal, say) {
  for (const m of store.exam(id).materials) {
    await files.ensureText(m, (done, total, phase, state) => say({ stage: "read", phase, state, title: m.title, done, total }), signal);
  }
}

/** What a strategy was made from: the material, the exam's own numbers and the model. The same again gives the same strategy. */
function basisOf(exam) {
  const { provider, model } = ai.config();
  return files.sha(JSON.stringify([exam.materials.map((m) => [m.hash, m.kind]), exam.name, exam.date, exam.time, exam.scale, exam.target, exam.pace, provider, model]));
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
  return store.view(store.undoStrategy(id));
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
  return store.view(store.change(id, (e) => (e.done[taskId] = { date: today(), minutes: task.minutes, at: Date.now() })));
});
handle("task:undo", (id, taskId) => {
  const task = taskOf(store.exam(id), taskId);
  if (!task || task.kind === "quiz") throw coded("unknown");
  return store.view(store.change(id, (e) => delete e.done[taskId]));
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
  return { exam: store.view(exam), set: shown(exam, exam.sets[key]) };
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
  return { exam: store.view(after), set: shown(after, after.sets[key]) };
});

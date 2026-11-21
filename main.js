const { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu, dialog, session } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const brand = require("./src/brand");
const store = require("./src/store");
const files = require("./src/files");
const secrets = require("./src/secrets");
const planner = require("./src/planner");
const engine = require("./src/engine");
const ai = require("./src/ai");
const models = require("./src/ai/models");
const { origin } = require("./src/address");

// Settings for the Anthropic SDK that may sit in the environment (another server, extra
// headers) have no say in this app.
require("./src/ai/anthropic").ignoreEnvironment();

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
const bookWindows = new Map(); // material hash -> window showing that PDF
const jobs = new Set(); // AbortControllers of everything under way that "Cancel" must reach
const sessions = new Map(); // quiz sessions under way

const isMac = process.platform === "darwin";
const colors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#15171c", symbols: "#f3f4f7" }
    : { background: "#f4f5f7", symbols: "#14161b" };

function applyAppearance(value) {
  nativeTheme.themeSource = value === "light" || value === "dark" ? value : "system";
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
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

/** The book in its own window, at the page. Chromium's own PDF view, with nothing of the app in it. */
function openBook(material, page) {
  const file = files.pdfPath(material.hash);
  if (material.type !== "pdf" || !fs.existsSync(file)) throw Object.assign(new Error("noBookFile"), { code: "noBookFile" });
  const url = `${pathToFileURL(file).href}#page=${Math.max(1, Math.min(material.pages, Math.round(page) || 1))}`;
  let book = bookWindows.get(material.hash);
  if (!book || book.isDestroyed()) {
    book = new BrowserWindow({
      width: 900,
      height: 1000,
      minWidth: 480,
      minHeight: 400,
      title: material.title,
      backgroundColor: colors().background,
      webPreferences: { plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    book.setMenuBarVisibility(false);
    book.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    book.webContents.on("will-navigate", (e, to) => {
      if (!to.startsWith(pathToFileURL(file).href)) e.preventDefault();
    });
    book.on("page-title-updated", (e) => e.preventDefault());
    bookWindows.set(material.hash, book);
  }
  // The PDF view only reads the page number when the document loads.
  book.loadURL("about:blank").then(() => book.loadURL(url));
  book.show();
}

app.setName(brand.name);

app.whenReady().then(() => {
  if (!single) return;
  if (!isMac) Menu.setApplicationMenu(null);
  // Nothing in this app needs the camera, the location or any other permission a page can ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Run from the source folder, the Dock would show Electron's icon.
  const devIcon = path.join(__dirname, "build", "icon.png");
  if (isMac && !app.isPackaged && fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  const userData = app.getPath("userData");
  files.init(SAMPLE ? fs.mkdtempSync(path.join(os.tmpdir(), "spurt-sample-")) : userData);
  // Test runs from the source folder can keep keys in memory only (SPURT_KEYS=memory), so they
  // leave nothing in the keychain. The app people install always stores them.
  secrets.init(userData, { persist: !SAMPLE && !(process.env.SPURT_KEYS === "memory" && !app.isPackaged) });
  store.init({ dir: userData, sample: SAMPLE });
  ai.init(() => store.settings());
  if (!SAMPLE) files.prune(store.references()); // whatever an earlier run left without an owner
  applyAppearance(store.settings().appearance);
  createWindow();
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

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
const send = (payload) => win && !win.isDestroyed() && win.webContents.send("progress", payload);
// Tokens are counted per exam, and where the price is known (Anthropic's own models) the cost.
const usageOf = (id) => (u) => {
  const { provider, model } = ai.config();
  const price = models.price(provider, model);
  store.addUsage(id, { ...u, cost: u.cost === undefined && price ? models.cost(price, u) : u.cost });
};
// Every kept answer is noted with its exam, so deleting the exam deletes it too.
const tracked = (id, signal) => ({ onUsage: usageOf(id), onKey: (key) => store.addAnswer(id, key), signal });

/** Runs something that "Cancel" can stop. */
async function job(fn) {
  const controller = new AbortController();
  jobs.add(controller);
  try {
    return await fn(controller.signal);
  } finally {
    jobs.delete(controller);
  }
}
const today = () => planner.todayIso();

handle("state", async () => ({ settings: store.settings(), exams: store.exams(), ai: await ai.status() }));

handle("settings:set", async (patch) => {
  const before = origin(store.settings().ai.baseURL);
  const next = store.setSettings(patch);
  // The key for "another server" belongs to that server: at a new address it is forgotten.
  if (origin(next.ai.baseURL) !== before) await secrets.set("openai", "");
  applyAppearance(next.appearance);
  return { settings: next, ai: await ai.status() };
});
handle("ai:key", async (provider, key) => {
  if (!["anthropic", "openrouter", "openai"].includes(provider)) throw coded("unknown");
  await secrets.set(provider, key);
  return ai.status();
});
handle("ai:test", () => ai.test());

handle("exam:create", (draft) => store.view(store.createExam(draft)));
handle("exam:edit", (id, draft) => store.view(store.editExam(id, draft)));
handle("exam:delete", (id) => {
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

async function addFiles(id, paths) {
  const problems = [];
  await job(async (signal) => {
    for (const file of paths.slice(0, 20)) {
      const title = path.basename(file);
      try {
        send({ examId: id, stage: "read", title, done: 0, total: 0 });
        const item = await files.add(file, (done, total, phase) => send({ examId: id, stage: "read", phase, title, done, total }), signal);
        const guess = item.pages > 40 ? "book" : (GUESS.find(([, re]) => re.test(title)) || ["book"])[0];
        store.addMaterial(id, item, guess);
      } catch (err) {
        if (err.code === "cancelled") break;
        problems.push({ title, code: ["unsupported", "empty"].includes(err.message) ? err.message : "unreadable" });
      }
    }
  });
  send({ examId: id, stage: "idle" });
  return { exam: store.view(store.exam(id)), problems };
}

handle("material:choose", async (id) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF, text", extensions: ["pdf", "txt", "md"] }],
  });
  return r.canceled ? { exam: store.view(store.exam(id)), problems: [] } : addFiles(id, r.filePaths);
});
handle("material:add", (id, paths) => addFiles(id, paths.filter((p) => typeof p === "string" && p)));
handle("material:text", (id, kind, title, text) => {
  let item;
  try {
    item = files.addText(text, String(title).slice(0, 80));
  } catch {
    throw coded("empty");
  }
  return store.view(store.addMaterial(id, item, kind));
});
handle("material:kind", (id, materialId, kind) => store.view(store.setMaterialKind(id, materialId, kind)));
handle("material:remove", (id, materialId) => {
  const exam = store.removeMaterial(id, materialId);
  if (!SAMPLE) files.prune(store.references());
  return store.view(exam);
});

handle("book:open", (id, materialId, page) => {
  const material = store.exam(id).materials.find((m) => m.id === materialId);
  if (!material) throw coded("noBookFile");
  openBook(material, page);
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
async function ensureTexts(id, signal) {
  let read = false;
  for (const m of store.exam(id).materials) {
    if (await files.ensureText(m, (done, total, phase) => send({ examId: id, stage: "read", phase, title: m.title, done, total }), signal)) read = true;
  }
  if (read) send({ examId: id, stage: "idle" });
}

handle("analysis:estimate", async (id) => {
  await job((signal) => ensureTexts(id, signal));
  const est = engine.estimate(store.exam(id));
  const status = await ai.status();
  const price = status.provider === "openrouter" ? await openRouterPrice(status.model) : status.price;
  return {
    ...est,
    provider: status.provider,
    model: status.model,
    ready: status.ready,
    cost: price ? (est.input * price[0] + est.output * price[1]) / 1e6 : null,
    costMax: price ? (est.inputMax * price[0] + est.output * 2 * price[1]) / 1e6 : null,
  };
});

handle("analysis:run", (id) =>
  job(async (signal) => {
    await ensureTexts(id, signal);
    const exam = store.exam(id);
    const daysLeft = Math.max(0, planner.diffDays(today(), exam.date));
    const days = Math.max(1, daysLeft);
    const minutesPerDay = exam.time.mode === "perDay" ? exam.time.minutes : Math.round(exam.time.minutes / days);
    const minutesTotal = exam.time.mode === "perDay" ? minutesPerDay * days : exam.time.minutes;
    try {
      const strategy = await engine.analyze(
        exam,
        { today: today(), daysLeft, minutesTotal, minutesPerDay },
        { onProgress: (p) => send({ examId: id, ...p }), ...tracked(id, signal) },
      );
      store.setStrategy(id, strategy);
      return store.view(store.exam(id));
    } finally {
      send({ examId: id, stage: "idle" });
    }
  }),
);

handle("cancel", () => {
  for (const controller of jobs) controller.abort();
});

// ------------------------------------------------ plan

handle("task:done", (id, taskId) => {
  const exam = store.exam(id);
  const task = planner.buildPlan(exam, today())?.days.flatMap((d) => d.tasks).find((t) => t.id === taskId);
  if (!task || ["quiz", "review", "mock"].includes(task.kind)) throw coded("unknown");
  return store.view(store.change(id, (e) => (e.done[taskId] = { date: today(), minutes: task.minutes, at: Date.now() })));
});

/** Done for today and still going: pulls the next task into today. */
handle("task:more", (id) => {
  const exam = store.exam(id);
  const plan = planner.buildPlan(exam, today());
  const next = plan?.days.slice(1).flatMap((d) => d.tasks).find((t) => !t.done);
  if (!next) return store.view(exam);
  const had = exam.bonus && exam.bonus.date === today() ? exam.bonus.minutes : 0;
  const leftToday = plan.days[0].tasks.filter((t) => !t.done).reduce((sum, t) => sum + t.minutes, 0);
  return store.view(store.change(id, (e) => (e.bonus = { date: today(), minutes: had + next.minutes + leftToday })));
});

// ------------------------------------------------ quizzes

function questionOf(exam, questionId) {
  for (const quiz of Object.values(exam.quizzes)) {
    const q = quiz.questions.find((x) => x.id === questionId);
    if (q) return q;
  }
  throw coded("unknown");
}

handle("quiz:open", async (id, { kind, taskId = null, topicId = null }) => {
  const exam = store.exam(id);
  let questions;
  let title = "";
  if (kind === "review") {
    questions = planner.dueQuestions(exam, today());
  } else {
    const strategy = exam.strategy;
    if (!strategy) throw coded("unknown");
    let request;
    if (kind === "mock") {
      const plan = planner.buildPlan(exam, today());
      const dropped = new Set(plan.dropped.map((d) => d.topicId));
      const mock = plan.days.flatMap((d) => d.tasks).find((t) => t.kind === "mock");
      request = {
        key: "mock",
        topicIds: strategy.topics.filter((t) => !dropped.has(t.id)).map((t) => t.id),
        count: Math.max(6, Math.min(12, Math.round((mock ? mock.minutes : 30) / 3))),
        mock: true,
      };
    } else {
      const topic = strategy.topics.find((t) => t.id === topicId);
      if (!topic) throw coded("unknown");
      title = topic.title;
      // A repeated quiz ("t1/q#0" after a weak result, "t1/q~3" as spaced repetition) gets its own new questions.
      const suffix = taskId ? taskId.slice(`${topicId}/q`.length) : "";
      const variant = suffix ? Object.keys(exam.quizzes).filter((k) => k === topicId || k.startsWith(topicId + "#") || k.startsWith(topicId + "~")).length : 0;
      request = {
        key: suffix ? topicId + suffix : topicId,
        topicIds: [topicId],
        count: topic.steps.find((s) => s.kind === "quiz")?.questions || 4,
        variant,
      };
    }
    let quiz = exam.quizzes[request.key];
    if (!quiz) {
      quiz = await job(async (signal) => {
        await ensureTexts(id, signal);
        return engine.writeQuiz(exam, request, tracked(id, signal));
      });
      store.change(id, (e) => (e.quizzes[request.key] = quiz));
    }
    questions = quiz.questions;
  }
  if (!questions.length) throw coded("noQuestions");
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { examId: id, kind, taskId, topicId, answers: {} });
  return { sessionId, kind, title, questions };
});

handle("quiz:answer", async (sessionId, questionId, answer) => {
  const session = sessions.get(sessionId);
  if (!session) throw coded("unknown");
  const exam = store.exam(session.examId);
  const q = questionOf(exam, questionId);
  // The sample exams carry one prepared correction, so the screenshots need no AI.
  const result = SAMPLE && q.sampleFeedback ? q.sampleFeedback : await engine.grade(q, answer, tracked(exam.id));
  const ratio = result.points / q.points;
  const card = planner.nextCard(exam.cards[q.id], ratio, today());
  store.change(exam.id, (e) => (e.cards[q.id] = card));
  session.answers[q.id] = { points: result.points, max: q.points, topicId: q.topicId };
  return {
    points: result.points,
    max: q.points,
    verdict: ratio >= 0.999 ? "right" : ratio > 0 ? "partly" : "wrong",
    feedback: result.feedback,
    correct: result.correct,
    backInDays: ratio >= 0.999 ? null : planner.diffDays(today(), card.due),
  };
});

handle("quiz:finish", (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) throw coded("unknown");
  sessions.delete(sessionId);
  const answers = Object.values(session.answers);
  const points = answers.reduce((sum, a) => sum + a.points, 0);
  const max = answers.reduce((sum, a) => sum + a.max, 0);
  const exam = store.change(session.examId, (e) => {
    // How well each topic went, blended with what was known before.
    const byTopic = new Map();
    for (const a of answers) {
      const t = byTopic.get(a.topicId) || { points: 0, max: 0 };
      byTopic.set(a.topicId, { points: t.points + a.points, max: t.max + a.max });
    }
    for (const [topicId, t] of byTopic) {
      const ratio = t.max ? t.points / t.max : 0;
      const old = e.mastery[topicId];
      e.mastery[topicId] = Math.round((typeof old === "number" ? 0.6 * ratio + 0.4 * old : ratio) * 100) / 100;
    }
    const stamp = { date: today(), minutes: Math.max(5, answers.length * 2), at: Date.now() };
    if (session.kind === "topic" && answers.length) {
      e.attempts[session.topicId] = (e.attempts[session.topicId] || 0) + 1;
      const own = `${session.topicId}/q`;
      const id = session.taskId || (e.done[own] ? null : own);
      if (id) e.done[id] = stamp;
    }
    if (session.kind === "review" && answers.length) e.done["review:" + today()] = stamp;
    if (session.kind === "mock" && answers.length) e.done.mock = stamp;
    if (answers.length) e.history.push({ date: today(), kind: session.kind, topicId: session.topicId, points, max });
  });
  return { exam: store.view(exam), points, max };
});

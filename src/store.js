// Everything the app knows about the person's exams lives in one JSON file in the app's own
// folder on this Mac. Nothing here talks to a network.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const planner = require("./planner");
const { allowedAddress, completeAddress, isAddress } = require("./address");

const DEFAULT_SETTINGS = { lang: "en", appearance: "system", ai: { provider: null, models: {}, baseURL: "" } };

let file = null; // null while running on sample data: nothing is written to disk
let data = { settings: structuredClone(DEFAULT_SETTINGS), exams: [] };
// A file that is there but cannot be read is never written over: the person decides first
// (use the backup, or start empty). Until then nothing is saved.
let damaged = null; // { backup: ISO date of the backup or null }

const backupFile = () => file.replace(/\.json$/, ".backup.json");

function parse(text) {
  const saved = JSON.parse(text);
  if (!saved || typeof saved !== "object" || !Array.isArray(saved.exams) || saved.exams.some((e) => !e || typeof e !== "object" || !e.id)) throw new Error("shape");
  return saved;
}

function take(saved, systemLang) {
  const settings = { ...DEFAULT_SETTINGS, ...saved.settings, ai: { ...DEFAULT_SETTINGS.ai, ...(saved.settings && saved.settings.ai) } };
  // The language follows the Mac until the person picks one. A file from 0.1 does not say
  // whether English was picked or just never changed; German could only have been picked.
  if (!settings.langFrom) settings.langFrom = settings.lang === "de" ? "choice" : "system";
  if (settings.langFrom === "system") settings.lang = systemLang;
  data = { settings, exams: saved.exams.map(upgrade) };
}

/** An exam written by an earlier version, with what this version expects. Nothing is thrown away. */
function upgrade(exam) {
  exam.done = exam.done || {};
  exam.materials = exam.materials || [];
  exam.sets = exam.sets || {};
  exam.again = exam.again || [];
  exam.results = exam.results || [];
  exam.usage = exam.usage || { input: 0, cached: 0, output: 0, cost: 0 };
  return exam;
}

function init({ dir, sample, systemLang = "en" }) {
  damaged = null;
  if (sample) {
    data = { settings: { ...structuredClone(DEFAULT_SETTINGS), langFrom: "system", lang: systemLang }, exams: require("./sample").exams().map(upgrade) };
    return;
  }
  file = path.join(dir, "spurt.json");
  data = { settings: { ...structuredClone(DEFAULT_SETTINGS), langFrom: "system", lang: systemLang }, exams: [] };
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") damaged = { backup: null };
  }
  if (text !== null) {
    try {
      take(parse(text), systemLang);
      // What could be read at this start is the backup for the next time something goes wrong.
      fs.copyFileSync(file, backupFile());
    } catch {
      damaged = { backup: null };
    }
  }
  if (damaged) {
    try {
      parse(fs.readFileSync(backupFile(), "utf8"));
      damaged.backup = fs.statSync(backupFile()).mtime.toISOString();
    } catch {
      // no backup that can be read
    }
  }
}

/** Is the data file unreadable? { backup: date or null } while the person has not decided, else null. */
const problem = () => damaged;

/** The damaged file is put aside under another name (never deleted), then the backup or an empty start takes its place. */
function recover(how, systemLang = "en") {
  if (!damaged) return;
  const aside = file.replace(/\.json$/, `.damaged-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
  try {
    fs.copyFileSync(file, aside);
  } catch {
    // nothing there to put aside
  }
  if (how === "backup" && damaged.backup) take(parse(fs.readFileSync(backupFile(), "utf8")), systemLang);
  damaged = null;
  save();
}

function save() {
  if (!file || damaged) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the file and flushed, then moved over it: a crash leaves the old file or the new one, never half of one.
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const settings = () => data.settings;

function setSettings(patch) {
  const next = { ...data.settings, ai: { ...data.settings.ai, models: { ...data.settings.ai.models } } };
  if (patch.lang === "en" || patch.lang === "de") {
    next.lang = patch.lang;
    next.langFrom = "choice";
  }
  if (["system", "light", "dark"].includes(patch.appearance)) next.appearance = patch.appearance;
  if (patch.ai) {
    const { provider, model, baseURL } = patch.ai;
    if (provider === null || ["claudeCode", "anthropic", "openrouter", "openai"].includes(provider)) next.ai.provider = provider;
    if (typeof model === "string" && next.ai.provider) next.ai.models[next.ai.provider] = model.trim().slice(0, 200);
    if (typeof baseURL === "string") {
      // "localhost:1234/v1" is completed to an address; https anywhere, plain http only for a
      // server on this computer (see address.js).
      const address = completeAddress(baseURL.trim().slice(0, 500));
      if (address && !allowedAddress(address)) throw Object.assign(new Error("insecureAddress"), { code: /^[a-z]+:\/\//i.test(address) && isAddress(address) ? "insecureAddress" : "badAddressText" });
      next.ai.baseURL = address;
    }
  }
  data.settings = next;
  save();
  return next;
}

// ------------------------------------------------------------ exams

const SCALES = ["ch", "de", "pct"];
const PACES = ["sprint", "thorough", "efficient"];
const KINDS = ["book", "objectives", "slides", "notes", "oldExam"];

function basics(draft, old = {}) {
  const name = String(draft.name ?? old.name ?? "").trim().slice(0, 120);
  if (!name) throw new Error("name");
  const date = draft.date ?? old.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + "T12:00:00").getTime())) throw new Error("date");
  const time = draft.time ?? old.time ?? {};
  const mode = time.mode === "total" ? "total" : "perDay";
  // Nobody studies more than sixteen hours a day: more than that in total is cut to what the days hold.
  const days = Math.max(1, planner.diffDays(planner.todayIso(), date));
  const most = mode === "total" ? Math.min(60 * 400, days * 16 * 60) : 16 * 60;
  return {
    name,
    date,
    time: { mode, minutes: Math.max(5, Math.min(most, Math.round(Number(time.minutes) || 30))) },
    scale: SCALES.includes(draft.scale) ? draft.scale : old.scale || "ch",
    target: Number(draft.target ?? old.target ?? 5),
    pace: PACES.includes(draft.pace) ? draft.pace : old.pace || "sprint",
  };
}

const find = (id) => {
  const exam = data.exams.find((e) => e.id === id);
  if (!exam) throw new Error("unknown exam");
  return exam;
};

/** Changes one exam and saves. `fn` may change the exam in place. */
function change(id, fn) {
  const exam = find(id);
  fn(exam);
  save();
  return exam;
}

function createExam(draft) {
  const exam = upgrade({
    id: crypto.randomUUID(),
    ...basics(draft),
    createdAt: new Date().toISOString(),
    materials: [],
    strategy: null,
    done: {},
  });
  data.exams = [exam, ...data.exams];
  save();
  return exam;
}

const editExam = (id, draft) => change(id, (exam) => Object.assign(exam, basics(draft, exam)));

function deleteExam(id) {
  find(id);
  data.exams = data.exams.filter((e) => e.id !== id);
  save();
}

/** Adds a file or a text to an exam. Returns the title it already has there, if it does ("" when it was added). */
function addMaterial(id, item, kind) {
  let already = "";
  change(id, (exam) => {
    const same = exam.materials.find((m) => m.hash === item.hash);
    if (same) return void (already = same.title);
    exam.materials.push({ id: item.id || crypto.randomUUID().slice(0, 8), kind: KINDS.includes(kind) ? kind : "book", ...item });
    if (exam.strategy) exam.strategy.stale = true;
  });
  return already;
}

function setMaterialKind(id, materialId, kind) {
  return change(id, (exam) => {
    const m = exam.materials.find((x) => x.id === materialId);
    if (!m || !KINDS.includes(kind)) return;
    m.kind = kind;
    if (exam.strategy) exam.strategy.stale = true;
  });
}

function removeMaterial(id, materialId) {
  return change(id, (exam) => {
    exam.materials = exam.materials.filter((m) => m.id !== materialId);
    if (exam.strategy) exam.strategy.stale = true;
  });
}

/** What a step asks for, whatever its id: a step that says the same in a new strategy keeps its tick. */
const sameStep = (step) => (step.kind === "read" ? `r:${step.material}:${step.from}-${step.to}` : step.kind === "solve" ? `s:${step.material}:${step.page}:${[...step.labels].sort().join(",")}` : null);

/** How many ticked steps a new strategy would keep and lose. */
function progressAfter(exam, strategy) {
  const old = exam.strategy ? exam.strategy.topics.flatMap((t) => t.steps) : [];
  const done = old.filter((step) => exam.done[step.id]);
  const next = new Set(strategy ? strategy.topics.flatMap((t) => t.steps).map(sameStep) : []);
  const kept = done.filter((step) => sameStep(step) && next.has(sameStep(step))).length;
  return { done: done.length, kept, lost: done.length - kept };
}

/**
 * A new strategy replaces the old one. Steps that ask for the same thing as before stay
 * ticked; exam results stay in the record. What belonged to the old topics (questions, steps
 * put back on the list) goes.
 */
function setStrategy(id, strategy) {
  return change(id, (exam) => {
    const before = new Map();
    for (const step of exam.strategy ? exam.strategy.topics.flatMap((t) => t.steps) : []) {
      if (exam.done[step.id] && sameStep(step)) before.set(sameStep(step), exam.done[step.id]);
    }
    exam.strategy = strategy;
    exam.done = {};
    for (const step of strategy.topics.flatMap((t) => t.steps)) if (before.has(sameStep(step))) exam.done[step.id] = before.get(sameStep(step));
    exam.sets = {};
    exam.again = [];
    delete exam.formulas;
  });
}

function addUsage(id, usage) {
  const exam = data.exams.find((e) => e.id === id);
  if (!exam) return;
  exam.usage = exam.usage || { input: 0, cached: 0, output: 0, cost: 0 };
  exam.usage.input += usage.input || 0;
  exam.usage.cached += usage.cached || 0;
  exam.usage.written = (exam.usage.written || 0) + (usage.written || 0);
  exam.usage.output += usage.output || 0;
  exam.usage.cost += usage.cost || 0;
  save();
}

// ------------------------------------------------------------ what the window gets

/** The newest set of questions of a kind ("final", or "topic:<id>"), or undefined. */
function latestSet(exam, kind) {
  return Object.values(exam.sets || {})
    .filter((x) => x.key.split("#")[0] === kind)
    .sort((a, b) => b.variant - a.variant)[0];
}

/**
 * An exam as the window gets it, with everything worked out for today: the plan, how much of
 * it is done, and where the final exam stands. Questions and their answers stay here; the
 * window asks for them when an exam is taken.
 */
function view(exam, today = planner.todayIso()) {
  const plan = planner.buildPlan(exam, today);
  const { sets, ...rest } = exam;
  const final = latestSet(exam, "final");
  const ids = new Set(exam.materials.map((m) => m.id));
  const steps = exam.strategy ? exam.strategy.topics.flatMap((t) => t.steps) : [];
  return {
    ...rest,
    plan,
    percent: plan ? plan.percent : 0,
    // A step that points into a book that was removed since.
    missing: steps.some((step) => step.material && !ids.has(step.material)),
    final: {
      // "written": questions are there and unanswered. "done": the newest one has a result.
      state: !final ? "none" : final.result ? "done" : "written",
      started: Boolean(final && !final.result && Object.keys(final.draft || {}).length),
      taken: Object.values(sets || {}).filter((x) => x.final && x.result).length,
      result: final && final.result ? { date: final.result.date, points: final.result.points, max: final.result.max, grade: final.result.grade, weak: final.result.weak } : null,
    },
    topicSets: Object.fromEntries(
      Object.values(sets || {})
        .filter((x) => !x.final)
        .map((x) => [x.key, x.result ? { points: x.result.points, max: x.result.max } : null]),
    ),
  };
}

/** What the exams still use on disk: the files of their material and the answers kept for them. */
function references() {
  return {
    hashes: new Set(data.exams.flatMap((e) => e.materials.map((m) => m.hash))),
    answers: new Set(data.exams.flatMap((e) => e.answers || [])),
  };
}

/** Notes that a kept answer belongs to an exam, so it can be deleted with it. */
function addAnswer(id, key) {
  const exam = data.exams.find((e) => e.id === id);
  if (!exam) return;
  exam.answers = exam.answers || [];
  if (!exam.answers.includes(key)) {
    exam.answers.push(key);
    save();
  }
}

const exams = () => data.exams.map((e) => view(e));
const exam = (id) => find(id);

module.exports = {
  init,
  problem,
  recover,
  latestSet,
  progressAfter,
  settings,
  setSettings,
  exams,
  exam,
  view,
  change,
  createExam,
  editExam,
  deleteExam,
  addMaterial,
  setMaterialKind,
  removeMaterial,
  setStrategy,
  addUsage,
  addAnswer,
  references,
};

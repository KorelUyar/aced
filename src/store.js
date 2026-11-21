// Everything the app knows about the person's exams lives in one JSON file in the app's own
// folder on this Mac. Nothing here talks to a network.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const planner = require("./planner");
const { allowedAddress } = require("./address");

const DEFAULT_SETTINGS = { lang: "en", appearance: "system", ai: { provider: null, models: {}, baseURL: "" } };

let file = null; // null while running on sample data: nothing is written to disk
let data = { settings: structuredClone(DEFAULT_SETTINGS), exams: [] };

function init({ dir, sample }) {
  if (sample) {
    data = { settings: structuredClone(DEFAULT_SETTINGS), exams: require("./sample").exams() };
    return;
  }
  file = path.join(dir, "spurt.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    data = {
      settings: { ...DEFAULT_SETTINGS, ...saved.settings, ai: { ...DEFAULT_SETTINGS.ai, ...(saved.settings && saved.settings.ai) } },
      exams: saved.exams || [],
    };
  } catch {
    // first start, or an unreadable file: begin empty
  }
}

function save() {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const settings = () => data.settings;

function setSettings(patch) {
  const next = { ...data.settings, ai: { ...data.settings.ai, models: { ...data.settings.ai.models } } };
  if (patch.lang === "en" || patch.lang === "de") next.lang = patch.lang;
  if (["system", "light", "dark"].includes(patch.appearance)) next.appearance = patch.appearance;
  if (patch.ai) {
    const { provider, model, baseURL } = patch.ai;
    if (provider === null || ["claudeCode", "anthropic", "openrouter", "openai"].includes(provider)) next.ai.provider = provider;
    if (typeof model === "string" && next.ai.provider) next.ai.models[next.ai.provider] = model.trim().slice(0, 200);
    if (typeof baseURL === "string") {
      const address = baseURL.trim().slice(0, 500);
      // https anywhere; plain http only for a server on this computer (see address.js).
      if (address && !allowedAddress(address)) throw Object.assign(new Error("insecureAddress"), { code: "insecureAddress" });
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date");
  const time = draft.time ?? old.time ?? {};
  return {
    name,
    date,
    time: {
      mode: time.mode === "total" ? "total" : "perDay",
      minutes: Math.max(5, Math.min(60 * 200, Math.round(Number(time.minutes) || 30))),
    },
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
  const exam = {
    id: crypto.randomUUID(),
    ...basics(draft),
    createdAt: new Date().toISOString(),
    materials: [],
    strategy: null,
    done: {},
    mastery: {},
    attempts: {},
    cards: {},
    quizzes: {},
    history: [],
    usage: { input: 0, cached: 0, output: 0, cost: 0 },
  };
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

function addMaterial(id, item, kind) {
  return change(id, (exam) => {
    if (exam.materials.some((m) => m.hash === item.hash)) return;
    exam.materials.push({ id: crypto.randomUUID().slice(0, 8), kind: KINDS.includes(kind) ? kind : "book", ...item });
    if (exam.strategy) exam.strategy.stale = true;
  });
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

/** A new strategy replaces the old one; what was learned so far only stays where topics still exist. */
function setStrategy(id, strategy) {
  return change(id, (exam) => {
    exam.strategy = strategy;
    exam.done = {};
    exam.mastery = {};
    exam.attempts = {};
    exam.cards = {};
    exam.quizzes = {};
    delete exam.bonus;
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

/** An exam with everything worked out for today: the plan, where the person stands, what is due. */
function view(exam, today = planner.todayIso()) {
  const plan = planner.buildPlan(exam, today);
  const stand = planner.standing(exam, plan);
  return {
    ...exam,
    plan,
    readiness: stand.readiness,
    projected: stand.projected,
    quizzed: stand.quizzed,
    topicMastery: exam.strategy ? Object.fromEntries(exam.strategy.topics.map((t) => [t.id, planner.topicMastery(exam, t)])) : {},
    due: planner.dueQuestions(exam, today).length,
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

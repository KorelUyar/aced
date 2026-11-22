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

// Backups: the newest and three before it. One is taken at every start that could read the
// file, and again while the app stays open (after ten minutes with changes, or 25 changes), so
// leaving the app open for days does not mean losing days.
const GENERATIONS = 4;
const backupFile = (n = 0) => file.replace(/\.json$/, n ? `.backup.${n}.json` : ".backup.json");
let lastBackup = 0;
let changes = 0;

function backup(text) {
  try {
    for (let n = GENERATIONS - 1; n > 0; n--) if (fs.existsSync(backupFile(n - 1))) fs.renameSync(backupFile(n - 1), backupFile(n));
    fs.writeFileSync(backupFile(), text);
  } catch {
    // a backup that cannot be written must not stop the app
  }
  lastBackup = Date.now();
  changes = 0;
}

/** The newest backup that can be read: { n, saved } or null. */
function newestBackup() {
  for (let n = 0; n < GENERATIONS; n++) {
    try {
      return { n, saved: parse(fs.readFileSync(backupFile(n), "utf8")), date: fs.statSync(backupFile(n)).mtime.toISOString() };
    } catch {
      // try the one before
    }
  }
  return null;
}

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
  file = path.join(dir, "aced.json");
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
      backup(text);
    } catch {
      damaged = { backup: null };
    }
  }
  if (damaged) {
    const found = newestBackup();
    if (found) damaged.backup = found.date;
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
  const found = how === "backup" ? newestBackup() : null;
  if (found) take(found.saved, systemLang);
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
  changes++;
  if (changes >= 25 || (changes > 0 && Date.now() - lastBackup > 10 * 60 * 1000)) backup(JSON.stringify(data));
}

const settings = () => data.settings;

/**
 * The data came over from Spurt at this start: the window says so once. `keys`: Spurt had a
 * saved key, which could not come along, and the provider in use needs one.
 */
function noteMove({ keys, failed }) {
  const provider = data.settings.ai.provider;
  const needsKey = Boolean(keys) && ["anthropic", "openrouter", "openai"].includes(provider);
  data.settings = { ...data.settings, moved: failed ? { failed } : { keys: needsKey } };
  if (!failed) save();
}

function setSettings(patch) {
  const next = { ...data.settings, ai: { ...data.settings.ai, models: { ...data.settings.ai.models } } };
  if (patch.lang === "en" || patch.lang === "de") {
    next.lang = patch.lang;
    next.langFrom = "choice";
  }
  if (["system", "light", "dark"].includes(patch.appearance)) next.appearance = patch.appearance;
  if (patch.moved === null) delete next.moved; // the note about the move from Spurt has been read
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

/**
 * Changes every material made from the same file, in every exam (they share their text): what
 * read it, and what was read. A key set to undefined is removed. A plan made from the old text
 * is marked as out of date.
 */
function patchMaterials(hash, patch) {
  let changed = false;
  for (const exam of data.exams) {
    for (const m of exam.materials) {
      if (m.hash !== hash) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete m[key];
        else m[key] = value;
      }
      if (exam.strategy && patch.chars !== undefined) exam.strategy.stale = true;
      changed = true;
    }
  }
  if (changed) save();
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

const stepsOf = (strategy) => (strategy ? strategy.topics.flatMap((t) => t.steps) : []);
const pagesOf = (step) => (step.kind === "read" ? Array.from({ length: step.to - step.from + 1 }, (_, i) => `${step.material}:${step.from + i}`) : []);
const exercisesOf = (step) => (step.kind === "solve" ? step.labels.map((label) => [step.material, step.page, String(label).trim()]) : []);

/**
 * What has been done, read off the ticks of a strategy, whatever its steps were called: the
 * pages that were read and the exercises that were solved.
 */
function doneWork(strategy, done) {
  const pages = new Map(); // "material:page" -> the tick it came from
  const exercises = new Map(); // "material:label" -> [{ page, tick }]
  for (const step of stepsOf(strategy)) {
    const tick = done[step.id];
    if (!tick) continue;
    for (const key of pagesOf(step)) pages.set(key, tick);
    for (const [material, page, label] of exercisesOf(step)) {
      const key = `${material}:${label}`;
      exercises.set(key, [...(exercises.get(key) || []), { page, tick }]);
    }
  }
  // An exercise counts as the same one on the same page or the page next to it (a model does not always cite the same page).
  const solved = (material, page, label) => (exercises.get(`${material}:${label}`) || []).find((x) => Math.abs(x.page - page) <= 1);
  return { pages, exercises, solved };
}

/** The tick a step of a new strategy inherits from work done under the old one, or null. */
function inherited(step, work) {
  if (step.kind === "read") {
    const keys = pagesOf(step);
    const read = keys.filter((k) => work.pages.has(k));
    // Mostly read already (three pages of five, or more) is read.
    return read.length && read.length / keys.length >= 0.6 ? work.pages.get(read[0]) : null;
  }
  if (step.kind === "solve") {
    const hits = exercisesOf(step).map(([material, page, label]) => work.solved(material, page, label));
    return hits.length && hits.every(Boolean) ? hits[0].tick : null;
  }
  return null;
}

/** Which topic of a new strategy an old topic has become: the one that shares the most pages, or the same title. */
function topicMap(old, next) {
  const pages = (t) => new Set(t.steps.flatMap((st) => (st.kind === "read" ? pagesOf(st) : st.kind === "solve" ? [`${st.material}:${st.page}`] : [])));
  const map = new Map();
  for (const a of old.topics) {
    const mine = pages(a);
    let best = null;
    let most = 0;
    for (const b of next.topics) {
      const shared = [...pages(b)].filter((p) => mine.has(p)).length + (a.title === b.title ? 1000 : 0);
      if (shared > most) [best, most] = [b, shared];
    }
    if (best) map.set(a.id, best.id);
  }
  return map;
}

/**
 * A new strategy replaces the old one, and what was done stays done:
 * - a reading step whose pages were mostly read already is ticked; an exercise step is ticked
 *   when every one of its exercises was solved before;
 * - exam results stay, with the topics they belong to now; what an exam put back on the list
 *   stays there as long as its topic still exists;
 * - the old plan, with its ticks, is kept as it was, so one click brings it back (`undoStrategy`).
 */
function setStrategy(id, strategy) {
  return change(id, (exam) => {
    const old = exam.strategy;
    if (!old) {
      exam.strategy = strategy;
      return;
    }
    const before = { at: Date.now(), strategy: old, done: exam.done, sets: structuredClone(exam.sets), again: structuredClone(exam.again), formulas: exam.formulas };
    const work = doneWork(old, exam.done);
    const map = topicMap(old, strategy);
    const done = {};
    for (const step of stepsOf(strategy)) {
      const tick = inherited(step, work);
      if (tick) done[step.id] = { ...tick, minutes: step.minutes };
      else if (step.kind === "solve") {
        // Some of its exercises were solved before: only the others are handed out, and the step says which are done.
        const was = step.labels.filter((label) => work.solved(step.material, step.page, String(label).trim()));
        if (was.length) {
          step.minutes = Math.max(2, Math.round((step.minutes * (step.labels.length - was.length)) / step.labels.length));
          step.labels = step.labels.filter((label) => !was.includes(label));
          step.solved = was;
        }
      }
    }
    // What the old ticks stood for and the new plan does not count as done.
    const now = doneWork(strategy, done);
    const lost = stepsOf(old).filter((step) => {
      if (!exam.done[step.id]) return false;
      if (step.kind === "read") return !pagesOf(step).some((k) => now.pages.has(k));
      if (step.kind === "solve") return !exercisesOf(step).every(([m, p, l]) => now.solved(m, p, l) || stepsOf(strategy).some((x) => x.kind === "solve" && x.material === m && Math.abs(x.page - p) <= 1 && (x.solved || []).includes(l)));
      return false;
    }).length;
    const titles = Object.fromEntries(old.topics.map((t) => [t.id, t.title]));
    const move = (topicId) => map.get(topicId) || topicId;
    const sets = {};
    for (const set of Object.values(exam.sets)) {
      // The titles the questions were written under, for topics that no longer exist.
      set.titles = { ...Object.fromEntries(set.topicIds.map((t) => [move(t), titles[t]])), ...(set.titles || {}) };
      set.topicIds = [...new Set(set.topicIds.map(move))];
      for (const q of set.questions) q.topicId = move(q.topicId);
      set.spare = Object.fromEntries(Object.entries(set.spare || {}).map(([t, v]) => [move(t), v]));
      if (set.result) {
        set.result.weak = [...new Set(set.result.weak.map(move))];
        const merged = {};
        for (const [t, v] of Object.entries(set.result.topics || {})) merged[move(t)] = { points: (merged[move(t)]?.points || 0) + v.points, max: (merged[move(t)]?.max || 0) + v.max };
        set.result.topics = merged;
      }
      // Questions on one topic belong to that topic's question step in the new plan, if it has one.
      const step = !set.final && map.has(set.topicIds[0]) ? strategy.topics.find((t) => t.id === set.topicIds[0]).steps.find((st) => st.kind === "quiz") : null;
      if (!set.final && step && set.stepId && !set.stepId.includes("/a")) {
        if (exam.done[set.stepId]) done[step.id] = exam.done[set.stepId];
        set.stepId = step.id;
        set.key = `topic:${step.id}#0`;
      }
      sets[set.key] = set;
    }
    const again = [];
    for (const a of exam.again) {
      if (!map.has(a.topicId)) continue; // its topic is gone: the result stays in the record, the extra steps go
      again.push({ ...a, topicId: map.get(a.topicId) });
      for (const step of a.steps) if (exam.done[step.id]) done[step.id] = exam.done[step.id];
    }
    exam.strategy = strategy;
    exam.done = done;
    exam.sets = sets;
    exam.again = again;
    delete exam.formulas;
    exam.previous = { ...before, kept: Object.keys(done).length, lost };
  });
}

/** Brings back the plan that the last new strategy replaced, with its ticks, results and formula sheet. */
function undoStrategy(id) {
  return change(id, (exam) => {
    const p = exam.previous;
    if (!p) return;
    exam.strategy = p.strategy;
    exam.done = p.done;
    exam.sets = p.sets;
    exam.again = p.again;
    if (p.formulas) exam.formulas = p.formulas;
    else delete exam.formulas;
    delete exam.previous;
  });
}

/** The exercises ticked off so far, per material: [{ material, page, labels }]. A new strategy is told to pick others where it can. */
function solved(exam) {
  return stepsOf(exam.strategy).filter((step) => step.kind === "solve" && exam.done[step.id]).map((step) => ({ material: step.material, page: step.page, labels: step.labels }));
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
  const { sets, previous, ...rest } = exam;
  const final = latestSet(exam, "final");
  const ids = new Set(exam.materials.map((m) => m.id));
  const steps = exam.strategy ? exam.strategy.topics.flatMap((t) => t.steps) : [];
  return {
    ...rest,
    plan,
    percent: plan ? plan.percent : 0,
    // The last new strategy can be taken back: how many ticks it kept and how many it lost.
    undo: previous ? { at: previous.at, kept: previous.kept, lost: previous.lost } : null,
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
  noteMove,
  undoStrategy,
  solved,
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
  patchMaterials,
  setMaterialKind,
  removeMaterial,
  setStrategy,
  addUsage,
  addAnswer,
  references,
};

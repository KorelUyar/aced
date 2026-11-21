// Everything the app knows lives in one JSON file in the app's own folder on this Mac.
// Nothing here talks to a network.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SETTINGS = { lang: "en", appearance: "system" };

let file = null; // null while running on sample data: nothing is written to disk
let data = { settings: { ...DEFAULT_SETTINGS }, exams: [] };

function init({ dir, sample }) {
  if (sample) {
    data = { settings: { ...DEFAULT_SETTINGS }, exams: require("./sample").exams() };
    return;
  }
  file = path.join(dir, "spurt.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    data = { settings: { ...DEFAULT_SETTINGS, ...saved.settings }, exams: saved.exams || [] };
  } catch {
    // first start, or an unreadable file: begin empty
  }
}

function save() {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const settings = () => data.settings;
const exams = () => data.exams;

function setSettings(patch) {
  const next = { ...data.settings };
  if (patch.lang === "en" || patch.lang === "de") next.lang = patch.lang;
  if (["system", "light", "dark"].includes(patch.appearance)) next.appearance = patch.appearance;
  data.settings = next;
  save();
  return next;
}

const SCALES = ["ch", "de", "pct"];
const PACES = ["sprint", "thorough", "efficient"];

function createExam(draft) {
  const name = String(draft.name || "").trim().slice(0, 120);
  if (!name) throw new Error("name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) throw new Error("date");
  const exam = {
    id: crypto.randomUUID(),
    name,
    date: draft.date,
    time: {
      mode: draft.time?.mode === "total" ? "total" : "perDay",
      minutes: Math.max(5, Math.min(60 * 200, Math.round(Number(draft.time?.minutes) || 30))),
    },
    scale: SCALES.includes(draft.scale) ? draft.scale : "ch",
    target: Number(draft.target),
    pace: PACES.includes(draft.pace) ? draft.pace : "sprint",
    createdAt: new Date().toISOString(),
    materials: [],
    strategy: null,
    today: null,
    quiz: null,
    readiness: 0,
    projected: null,
  };
  data.exams = [exam, ...data.exams];
  save();
  return exam;
}

function updateExam(id, patch) {
  const i = data.exams.findIndex((e) => e.id === id);
  if (i < 0) throw new Error("unknown exam");
  // Only the fields the interface may change; the rest belongs to the engine.
  const allowed = {};
  if (patch.today) allowed.today = patch.today;
  data.exams[i] = { ...data.exams[i], ...allowed };
  save();
  return data.exams[i];
}

module.exports = { init, settings, exams, setSettings, createExam, updateExam };

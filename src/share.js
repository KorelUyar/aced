// Sharing an exam: the Aced file (.aced), which a friend opens in their own Aced.
//
// It is a zip with one JSON file, "aced.json", and the material the person chose to send, as
// "m/1.pdf", "m/2.pdf" … (the PDF made from each file). What goes in is chosen field by field:
// the exam's name, date, time and target; the strategy with its pages and exercises; the formula
// sheet; the questions with their expected answers. Never: ticks, results, typed answers, the
// AI's settings or keys, file names or paths, who made it.
//
// A file that comes in is untrusted: it is read with the app's own zip reader under hard limits,
// every field is checked and cut to size, nothing inside it names a file on this Mac, and the
// material goes through the same pipeline as any file the person adds (src/files.js).
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const zip = require("./formats/zip");

const FORMAT = "aced-exam";
const VERSION = 1; // what this app writes and reads; a file from a newer Aced says so
const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

// ------------------------------------------------------------ writing

/** A zip of `entries` ([name, Buffer]): what is already compressed (PDF) is stored, the rest deflated. */
function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const store = /\.pdf$/.test(name);
    const packed = store ? data : zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const head = (sig, size) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    const local = head(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const c = head(0x02014b50, 46);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBytes.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(c, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * The Aced file of an exam, as a Buffer. `chosen`: the ids of the material to send with it.
 * `pdfOf(material)` / `textOf(material)` give a material's PDF (Buffer) or its pages of text.
 */
function pack(exam, { chosen = [], appVersion = "", pdfOf, textOf }) {
  const wanted = new Set(chosen);
  const entries = [];
  const materials = exam.materials.map((m, i) => {
    const out = pick(m, ["id", "kind", "type", "title", "pages", "hash", "from", "format", "files", "offset"]);
    if (!wanted.has(m.id) || m.missing) return { ...out, included: false };
    if (m.type === "text") {
      const data = textOf(m);
      return data ? { ...out, included: true, text: data.pages.join("\n\n") } : { ...out, included: false };
    }
    const pdf = pdfOf(m);
    if (!pdf) return { ...out, included: false };
    const name = `m/${i + 1}.pdf`;
    entries.push([name, pdf]);
    return { ...out, included: true, file: name };
  });
  const s = exam.strategy;
  const strategy = s && {
    ...pick(s, ["createdOn", "approach", "objectives", "objectivesGuessed", "pagesRead"]),
    topics: s.topics.map((t) => ({
      ...pick(t, ["id", "title", "share", "why", "skipCost", "objectives", "order"]),
      steps: t.steps.map((st) => pick(st, ["id", "kind", "material", "from", "to", "chapter", "page", "labels", "minutes", "questions"])),
    })),
  };
  // Questions with what is expected, never with what the person typed or how it was marked.
  const sets = Object.values(exam.sets || {}).map((set) => ({
    ...pick(set, ["key", "final", "variant", "topicIds", "titles", "stepId", "spare"]),
    questions: set.questions.map((q) => pick(q, ["id", "topicId", "type", "prompt", "unit", "choices", "points", "answer", "value", "values", "tolerance", "correct", "solution", "material", "page"])),
  }));
  const doc = {
    format: FORMAT,
    version: VERSION,
    app: appVersion,
    exam: pick(exam, ["name", "date", "time", "scale", "target", "pace"]),
    materials,
    strategy,
    formulas: exam.formulas || null,
    sets,
  };
  entries.unshift(["aced.json", Buffer.from(JSON.stringify(doc), "utf8")]);
  return zipOf(entries);
}

// ------------------------------------------------------------ reading

const LIMITS = { file: 700 * 1024 * 1024, json: 16 * 1024 * 1024, pdf: 400 * 1024 * 1024, total: 1024 * 1024 * 1024, entries: 400 };

const str = (v, max) => (typeof v === "string" ? v.replace(/\u0000/g, "").slice(0, max) : "");
const int = (v, lo, hi, d = lo) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const num = (v, lo, hi, d = lo) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
const id = (v) => (typeof v === "string" && /^[A-Za-z0-9_#/:.-]{1,48}$/.test(v) ? v : null);
// A material's id is plainer still: letters, digits, "-" and "_".
const mid = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(v) ? v : null);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v + "T12:00:00").getTime()) ? v : null);
const KINDS = ["book", "objectives", "slides", "notes", "oldExam"];

function cleanStrategy(s, ids) {
  if (!s || typeof s !== "object") return null;
  const topics = list(s.topics, 60)
    .map((t) => {
      if (!t || typeof t !== "object" || !id(t.id)) return null;
      const steps = list(t.steps, 40)
        .map((st) => {
          if (!st || typeof st !== "object" || !id(st.id) || !["read", "solve", "quiz"].includes(st.kind)) return null;
          const base = { id: st.id, kind: st.kind, minutes: int(st.minutes, 1, 600, 15) };
          if (st.kind === "quiz") return { ...base, questions: int(st.questions, 1, 30, 4) };
          if (!ids.has(st.material)) return null;
          if (st.kind === "read") {
            const from = int(st.from, 1, 100000, 0);
            if (!from) return null;
            return { ...base, material: st.material, from, to: Math.max(from, int(st.to, 1, 100000, from)), chapter: str(st.chapter, 200) };
          }
          const page = int(st.page, 1, 100000, 0);
          const labels = list(st.labels, 30).map((l) => str(String(l), 24)).filter(Boolean);
          return page && labels.length ? { ...base, material: st.material, page, labels, unconfirmed: [] } : null;
        })
        .filter(Boolean);
      return steps.length
        ? {
            id: t.id,
            title: str(t.title, 300) || "—",
            share: num(t.share, 0, 1, 0),
            why: str(t.why, 2000),
            skipCost: str(t.skipCost, 1000),
            objectives: list(t.objectives, 50).filter((n) => Number.isInteger(n) && n >= 0 && n < 200),
            order: int(t.order, 0, 100000, 0),
            steps,
          }
        : null;
    })
    .filter(Boolean);
  if (!topics.length) return null;
  return {
    createdOn: day(s.createdOn) || undefined,
    approach: str(s.approach, 4000),
    objectives: list(s.objectives, 100).map((o) => str(o, 600)).filter(Boolean),
    objectivesGuessed: s.objectivesGuessed === true,
    pagesRead: int(s.pagesRead, 0, 100000, 0),
    model: "shared",
    checks: { exercises: 0, confirmed: 0, moved: 0, unconfirmed: 0, rangesDropped: 0 },
    skipped: [],
    topics,
  };
}

function cleanFormulas(f, topicIds, ids) {
  return list(f, 100)
    .map((g) => {
      if (!g || typeof g !== "object" || !topicIds.has(g.topicId)) return null;
      const formulas = list(g.formulas, 40)
        .map((x) => (x && typeof x === "object" ? { name: str(x.name, 200), latex: str(x.latex, 2000), note: str(x.note, 2000), material: ids.has(x.material) ? x.material : undefined, page: int(x.page, 1, 100000, 0) || undefined } : null))
        .filter((x) => x && x.latex);
      return formulas.length ? { topicId: g.topicId, formulas } : null;
    })
    .filter(Boolean);
}

function cleanSets(sets, topicIds, ids) {
  const out = {};
  for (const set of list(sets, 60)) {
    if (!set || typeof set !== "object" || !id(set.key) || out[set.key]) continue;
    const questions = list(set.questions, 60)
      .map((q) => {
        if (!q || typeof q !== "object" || !id(q.id) || !topicIds.has(q.topicId) || !["number", "numbers", "choice", "text"].includes(q.type)) return null;
        const clean = { id: q.id, topicId: q.topicId, type: q.type, prompt: str(q.prompt, 4000), answer: str(q.answer, 2000), solution: str(q.solution, 6000), points: int(q.points, 1, 20, 1), unit: str(q.unit, 40) };
        if (q.type === "number") Object.assign(clean, { value: num(q.value, -1e15, 1e15, 0), tolerance: num(q.tolerance, 0, 1e12, 0) });
        if (q.type === "numbers") Object.assign(clean, { values: list(q.values, 20).filter((v) => typeof v === "number" && Number.isFinite(v)), tolerance: num(q.tolerance, 0, 1e12, 0) });
        if (q.type === "choice") Object.assign(clean, { choices: list(q.choices, 8).map((c) => str(c, 500)), correct: int(q.correct, 0, 7, 0) });
        if (ids.has(q.material)) Object.assign(clean, { material: q.material, page: int(q.page, 1, 100000, 0) || undefined });
        return clean.prompt ? clean : null;
      })
      .filter(Boolean);
    if (!questions.length) continue;
    out[set.key] = {
      key: set.key,
      final: set.final === true,
      variant: int(set.variant, 0, 1000, 0),
      topicIds: list(set.topicIds, 60).filter((t) => topicIds.has(t)),
      titles: Object.fromEntries(Object.entries(set.titles && typeof set.titles === "object" ? set.titles : {}).filter(([k]) => id(k)).slice(0, 60).map(([k, v]) => [k, str(v, 300)])),
      stepId: id(set.stepId),
      spare: {},
      questions,
      draft: {},
      result: null,
    };
  }
  return out;
}

/**
 * Reads an Aced file. Resolves to { exam, materials: [{ ..., pdf: path of a copy made here }],
 * strategy, formulas, sets }. Throws "damaged" (not an Aced file, or one that cannot be read),
 * "newer" (from a newer Aced, `detail` its version) or "tooLarge".
 */
function unpack(file, tmpDir) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw coded("damaged");
  if (st.size > LIMITS.file) throw coded("tooLarge");
  let archive;
  try {
    archive = zip.open(file, { entries: LIMITS.entries, entry: LIMITS.pdf, total: LIMITS.total });
  } catch (err) {
    throw coded(err.code === "tooLarge" ? "tooLarge" : "damaged");
  }
  try {
    if (!archive.has("aced.json")) throw coded("damaged");
    let doc;
    try {
      doc = JSON.parse(archive.read("aced.json", LIMITS.json).toString("utf8"));
    } catch (err) {
      throw coded(err.code === "tooLarge" ? "tooLarge" : "damaged");
    }
    if (!doc || typeof doc !== "object" || doc.format !== FORMAT || !Number.isInteger(doc.version) || doc.version < 1) throw coded("damaged");
    if (doc.version > VERSION) throw coded("newer", str(doc.app, 20));
    const e = doc.exam && typeof doc.exam === "object" ? doc.exam : {};
    const exam = {
      name: str(e.name, 120).trim() || "—",
      date: day(e.date) || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
      time: { mode: e.time && e.time.mode === "total" ? "total" : "perDay", minutes: int(e.time && e.time.minutes, 5, 24000, 30) },
      scale: ["ch", "de", "pct"].includes(e.scale) ? e.scale : "ch",
      target: num(e.target, 0, 100, 5),
      pace: ["sprint", "thorough", "efficient"].includes(e.pace) ? e.pace : "thorough",
    };
    const seen = new Set();
    const materials = [];
    list(doc.materials, 60).forEach((m) => {
      if (!m || typeof m !== "object" || !mid(m.id) || seen.has(m.id)) return;
      seen.add(m.id);
      const base = {
        id: m.id,
        kind: KINDS.includes(m.kind) ? m.kind : "book",
        title: str(m.title, 200).trim() || "—",
        pages: int(m.pages, 1, 100000, 1),
        hash: typeof m.hash === "string" && /^[a-f0-9]{64}$/.test(m.hash) ? m.hash : null,
        from: typeof m.from === "string" && /^[a-z]{2,10}$/.test(m.from) ? m.from : undefined,
        format: typeof m.format === "string" && /^[a-z0-9]{1,10}$/.test(m.format) ? m.format : undefined,
      };
      if (m.type === "text") {
        const text = str(m.text, 3000000);
        if (m.included === true && text.trim()) materials.push({ ...base, type: "text", text });
        return;
      }
      // A PDF that came along: copied out under a name made here, never one taken from the file.
      if (m.included === true && typeof m.file === "string" && /^m\/\d{1,3}\.pdf$/.test(m.file) && archive.has(m.file)) {
        const target = path.join(tmpDir, `material-${materials.length + 1}.pdf`);
        try {
          fs.writeFileSync(target, archive.read(m.file, LIMITS.pdf));
          materials.push({ ...base, type: "pdf", pdf: target });
          return;
        } catch (err) {
          if (err.code === "tooLarge") throw coded("tooLarge");
        }
      }
      materials.push({ ...base, type: "pdf", missing: true });
    });
    const ids = new Set(materials.map((m) => m.id));
    const strategy = cleanStrategy(doc.strategy, ids);
    const topicIds = new Set(strategy ? strategy.topics.map((t) => t.id) : []);
    return { exam, materials, strategy, formulas: strategy ? cleanFormulas(doc.formulas, topicIds, ids) : [], sets: strategy ? cleanSets(doc.sets, topicIds, ids) : {} };
  } finally {
    archive.close();
  }
}

/** A book the shared exam names but did not bring: it waits for the person's own copy. */
const waitingBook = (m) => ({ id: m.id, kind: m.kind, type: "pdf", title: m.title, pages: m.pages, chars: 0, offset: 0, scanned: false, hash: m.hash || "missing-" + m.id, missing: true, expect: { hash: m.hash, pages: m.pages, title: m.title } });

/**
 * Makes a new exam from an Aced file: at 0%, with the material that came along added the way
 * any file is (`files.add`), and each book that did not come along waiting for the person's own
 * copy, unless this Mac has the same file already (same SHA-256): then it is there at once.
 * Resolves to the new exam's id. `store` and `files` are the app's (passed in for the tests).
 */
async function importExam(file, { store, files, lang = "en", today, signal }) {
  const dir = tempDir();
  try {
    const got = unpack(file, dir);
    const id = store.createExam(got.exam).id;
    const items = [];
    for (const m of got.materials) {
      try {
        if (m.type === "text") items.push({ ...files.addText(m.text, m.title), id: m.id, kind: m.kind });
        else if (m.pdf) items.push({ ...(await files.add(m.pdf, null, signal, { lang })), id: m.id, kind: m.kind, title: m.title, from: m.from, format: m.format });
        else if (m.hash && files.readText(m.hash) && fs.existsSync(files.pdfPath(m.hash))) items.push({ ...(await files.add(files.pdfPath(m.hash), null, signal)), id: m.id, kind: m.kind, title: m.title, edition: "same" });
        else items.push(waitingBook(m));
      } catch (err) {
        if (err.code === "cancelled") throw err;
        items.push(waitingBook(m));
      }
    }
    store.change(id, (e) => {
      e.materials = items.map(({ pdf, text, ...rest }) => rest);
      e.strategy = got.strategy;
      if (got.formulas.length) e.formulas = got.formulas;
      e.sets = got.sets;
      e.shared = { on: today };
    });
    return id;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The person's own copy of a book a shared exam names takes the book's place. Resolves to how
 * well it fits: "same" (the same file), "likely" (as many pages, a similar title) or "other"
 * (it looks like another edition: the pages may not fit), and the item.
 */
async function supplyBook(examId, materialId, file, { store, files, lang = "en", signal, onProgress }) {
  const wanted = store.exam(examId).materials.find((m) => m.id === materialId && m.missing);
  if (!wanted) throw coded("unknown");
  const item = await files.add(file, onProgress, signal, { lang });
  const expect = wanted.expect || {};
  const words = (t) => new Set(String(t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const a = words(expect.title);
  const b = words(item.title);
  const overlap = [...a].filter((w) => b.has(w)).length / Math.max(1, Math.min(a.size, b.size));
  const edition = expect.hash && item.hash === expect.hash ? "same" : item.pages === expect.pages && overlap >= 0.5 ? "likely" : "other";
  store.change(examId, (e) => {
    const at = e.materials.findIndex((m) => m.id === materialId);
    e.materials[at] = { ...item, id: materialId, kind: wanted.kind, edition, expect };
  });
  return { edition, item, expect };
}

/** A name for the file from the exam's name: letters, digits, spaces and a few marks; nothing that could be a path. */
const fileName = (name, ext) => `${String(name || "Exam").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Exam"}.${ext}`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aced-share-"));

module.exports = { pack, unpack, importExam, supplyBook, fileName, tempDir, zipOf, FORMAT, VERSION, LIMITS };

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
const crypto = require("crypto");
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
/** Is this material a book (the one kind whose name goes along even when it stays home)? */
const isBook = (m) => m.kind === "book" && m.from !== "pictures";

function pack(exam, { chosen = [], appVersion = "", pdfOf, textOf, probeOf, shareId }) {
  const wanted = new Set(chosen);
  const entries = [];
  const materials = [];
  exam.materials.forEach((m, i) => {
    const ticked = wanted.has(m.id) && !m.missing;
    // Material that stays home sends nothing at all, not even its name. A book is the one
    // exception: its title, page count and fingerprint, so the friend can add their own copy
    // (and Aced can tell whether it is the same edition).
    if (!ticked && !isBook(m)) return;
    const out = isBook(m)
      ? { ...pick(m, ["id", "kind", "title", "pages"]), hash: m.missing ? m.expect && m.expect.hash : m.hash, probe: m.missing ? m.expect && m.expect.probe : probeOf && probeOf(m) }
      : pick(m, ["id", "kind", "type", "title", "pages", "from", "format", "offset"]);
    if (!ticked) return materials.push({ ...out, included: false });
    if (m.type === "text") {
      const data = textOf(m);
      if (data) materials.push({ ...out, included: true, text: data.pages.join("\n\n") });
      else if (isBook(m)) materials.push({ ...out, included: false });
      return;
    }
    const pdf = pdfOf(m);
    if (!pdf) return isBook(m) ? materials.push({ ...out, included: false }) : undefined;
    const name = `m/${i + 1}.pdf`;
    entries.push([name, pdf]);
    // The text read from it goes along too, so the friend's Aced does not read it again (and
    // their AI is not asked for what the sender's already read).
    const text = textOf(m);
    const reading = text && Array.isArray(text.pages) ? { pages: text.pages, outline: text.outline, by: text.reader === "ai" ? "ai" : text.recognised ? "mac" : "text", model: text.reader === "ai" ? text.model : undefined } : undefined;
    materials.push({ ...out, included: true, file: name, reading });
  });
  // What points at material that stayed home is left out or loses its page (a step to read
  // pages nobody else has would not read well); a book keeps its steps.
  const kept = new Set(materials.map((m) => m.id));
  const s = exam.strategy;
  const strategy = s && {
    ...pick(s, ["createdOn", "approach", "objectives", "objectivesGuessed", "pagesRead"]),
    topics: s.topics.map((t) => ({
      ...pick(t, ["id", "title", "share", "why", "skipCost", "objectives", "order"]),
      steps: t.steps.filter((st) => !st.material || kept.has(st.material)).map((st) => pick(st, ["id", "kind", "material", "from", "to", "chapter", "page", "labels", "minutes", "questions"])),
    })),
  };
  const formulas = exam.formulas ? exam.formulas.map((g) => ({ ...g, formulas: g.formulas.map((f) => (kept.has(f.material) ? f : { ...f, material: undefined, page: undefined })) })) : null;
  // Questions with what is expected, never with what the person typed or how it was marked.
  const sets = Object.values(exam.sets || {}).map((set) => ({
    ...pick(set, ["key", "final", "variant", "topicIds", "titles", "stepId", "spare"]),
    questions: set.questions.map((q) => {
      const out = pick(q, ["id", "topicId", "type", "prompt", "unit", "choices", "points", "answer", "value", "values", "tolerance", "correct", "solution", "material", "page"]);
      return kept.has(q.material) ? out : { ...out, material: undefined, page: undefined };
    }),
  }));
  const doc = {
    format: FORMAT,
    version: VERSION,
    app: appVersion,
    // Which share this is: the same file opened twice is known.
    id: shareId,
    exam: pick(exam, ["name", "date", "time", "scale", "target", "pace"]),
    materials,
    strategy,
    formulas,
    sets,
  };
  entries.unshift(["aced.json", Buffer.from(JSON.stringify(doc), "utf8")]);
  return zipOf(entries);
}

// ------------------------------------------------------------ reading

/**
 * The Aced file for an exam, as bytes (see `pack`). Every PDF that goes along is a clean copy:
 * drawn anew without the file's information (author, title, the app that made it) and its XMP
 * metadata (native/ocr.swift, --clean), and with what its photos say about themselves blanked
 * (`blankPictureNotes`). One that cannot be made stays home: its title comes back in `left`.
 * Each book carries its fingerprint. `files` and `ocr` are the app's; `dir` a folder for the
 * copies while they are made.
 */
async function packExam(exam, { chosen = [], appVersion = "", files, ocr, dir, shareId = crypto.randomUUID() }) {
  const ticked = new Set(chosen);
  const clean = new Map();
  const left = [];
  for (const m of exam.materials) {
    if (!ticked.has(m.id) || m.missing || m.type === "text") continue;
    const source = files.pdfPath(m.hash);
    const copy = path.join(dir, `clean-${clean.size + left.length + 1}.pdf`);
    try {
      if (!fs.existsSync(source) || !ocr.available()) throw new Error("no copy");
      await ocr.clean(source, copy);
      const bytes = fs.readFileSync(copy);
      blankPictureNotes(bytes);
      blankInfo(bytes);
      clean.set(m.id, bytes);
    } catch {
      left.push(m.title);
    } finally {
      fs.rmSync(copy, { force: true });
    }
  }
  const probes = new Map();
  for (const m of exam.materials) {
    const text = isBook(m) && !m.missing && files.readText(m.hash);
    if (text && fs.existsSync(files.pdfPath(m.hash))) probes.set(m.id, await probeOf(text, (pages) => files.pdfFacts(files.pdfPath(m.hash), pages).then((f) => f.sizes)));
  }
  const kindOf = (id) => (exam.materials.find((m) => m.id === id) || {}).type;
  const bytes = pack(exam, {
    chosen: [...ticked].filter((id) => clean.has(id) || kindOf(id) === "text"),
    appVersion,
    shareId,
    pdfOf: (m) => clean.get(m.id) || null,
    textOf: (m) => files.readText(m.hash),
    probeOf: (m) => probes.get(m.id),
  });
  return { bytes, left };
}

const LIMITS = { file: 700 * 1024 * 1024, json: 16 * 1024 * 1024, pdf: 400 * 1024 * 1024, total: 1024 * 1024 * 1024, entries: 400 };

const str = (v, max) => (typeof v === "string" ? v.replace(/\u0000/g, "").slice(0, max) : "");
const int = (v, lo, hi, d = lo) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const num = (v, lo, hi, d = lo) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
// (Never a name every object has, such as "constructor" or "__proto__": such an id would read as
// ticked off, or worse, wherever a map is looked up by it.)
const plain = (v) => v !== "__proto__" && !Object.prototype.hasOwnProperty.call(Object.prototype, v);
const id = (v) => (typeof v === "string" && /^[A-Za-z0-9_#/:.-]{1,48}$/.test(v) && plain(v) ? v : null);
// A material's id is plainer still: letters, digits, "-" and "_".
const mid = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(v) && plain(v) ? v : null);
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
      const probe = m.probe && typeof m.probe === "object" ? m.probe : {};
      const base = {
        id: m.id,
        kind: KINDS.includes(m.kind) ? m.kind : "book",
        title: str(m.title, 200).trim() || "—",
        pages: int(m.pages, 1, 100000, 1),
        hash: typeof m.hash === "string" && /^[a-f0-9]{64}$/.test(m.hash) ? m.hash : null,
        probe: {
          pages: list(probe.pages, 8).filter((n) => Number.isInteger(n) && n > 0 && n <= 100000),
          text: list(probe.text, 8).map((x) => (typeof x === "string" && /^[a-f0-9]{0,64}$/.test(x) ? x : "")),
          sizes: list(probe.sizes, 8).map((s) => (Array.isArray(s) && s.length === 2 && s.every((x) => Number.isInteger(x) && x > 0 && x < 20000) ? s : null)),
        },
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
          materials.push({ ...base, type: "pdf", pdf: target, reading: readingOf(m.reading) });
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
    const shareId = typeof doc.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(doc.id) ? doc.id : null;
    return { exam, shareId, materials, strategy, formulas: strategy ? cleanFormulas(doc.formulas, topicIds, ids) : [], sets: strategy ? cleanSets(doc.sets, topicIds, ids) : {} };
  } finally {
    archive.close();
  }
}

/**
 * The text the sender's Aced read from a material, so that the friend's does not read it again:
 * whole or not at all (every page a string, the whole at most 3 million characters).
 */
function readingOf(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.pages) || !r.pages.length || r.pages.length > 5000) return null;
  if (!r.pages.every((p) => typeof p === "string")) return null;
  const pages = r.pages.map((p) => p.replace(/\u0000/g, ""));
  if (pages.reduce((sum, p) => sum + p.length, 0) > 3000000) return null;
  const outline = list(r.outline, 500)
    .filter((o) => o && typeof o.title === "string" && Number.isInteger(o.page) && o.page >= 1 && o.page <= pages.length)
    .map((o) => ({ title: str(o.title, 160), page: o.page, depth: int(o.depth, 0, 3, 0) }));
  const by = ["ai", "mac", "text"].includes(r.by) ? r.by : "text";
  return { pages, outline, by, model: by === "ai" && typeof r.model === "string" && /^[\w.:/@-]{1,80}$/.test(r.model) ? r.model : undefined };
}

/**
 * What tells one edition of a book from another when the files differ: the text of three pages
 * (as a short fingerprint, never the text itself) and their sizes. `text` is the book's text
 * ({ pages }), `sizesOf(pageNumbers)` resolves to the pages' sizes in points.
 */
const probePages = (n) => [...new Set([0.3, 0.5, 0.7].map((f) => Math.min(n, Math.max(1, Math.round(n * f)))))];
function pageMark(text) {
  const s = String(text || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return s.length >= 30 ? crypto.createHash("sha256").update(s).digest("hex").slice(0, 16) : "";
}
async function probeOf(text, sizesOf) {
  const pages = probePages(text.pages.length);
  let sizes = [];
  try {
    sizes = (await sizesOf(pages)).map((s) => (Array.isArray(s) ? s.map((x) => Math.round(x)) : null));
  } catch {
    // without the sizes, the text decides
  }
  return { pages, text: pages.map((n) => pageMark(text.pages[n - 1])), sizes };
}

/**
 * Whether the person's copy of a book is the one the shared plan was made with: "same" (the
 * same file, or the same text on the same pages), "likely" (as many pages of the same sizes,
 * and no text on either to compare) or "other" (another edition: the page numbers may not fit).
 */
function editionOf(expect, item, probe) {
  if (expect.hash && item.hash === expect.hash) return "same";
  const a = expect.probe;
  if (!a || !probe || item.pages !== expect.pages || JSON.stringify(a.pages) !== JSON.stringify(probe.pages)) return "other";
  const both = a.text.map((x, i) => [x, probe.text[i]]);
  if (both.some(([x, y]) => x || y)) return both.every(([x, y]) => x === y) ? "same" : "other";
  const near = (s, t) => s && t && Math.abs(s[0] - t[0]) <= 2 && Math.abs(s[1] - t[1]) <= 2;
  return a.sizes.length && a.sizes.length === probe.sizes.length && a.sizes.every((s, i) => near(s, probe.sizes[i])) ? "likely" : "other";
}

/**
 * What a photo says about itself (camera, owner, place and time: EXIF, XMP, comments) blanked in
 * every JPEG picture of a PDF, in place and byte for byte, so nothing else in the file moves.
 * What a picture needs to be shown (JFIF, Adobe, the colour profile) stays. Resolves to how many
 * segments were blanked.
 */
function blankPictureNotes(buf) {
  let blanked = 0;
  let at = 0;
  while ((at = buf.indexOf("/DCTDecode", at, "latin1")) !== -1) {
    at += 10;
    const s = buf.indexOf("stream", at, "latin1");
    const end = buf.indexOf("endobj", at, "latin1");
    if (s === -1 || s - at > 600 || (end !== -1 && end < s)) continue;
    let p = s + 6;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;
    if (buf[p] !== 0xff || buf[p + 1] !== 0xd8) continue;
    p += 2;
    while (p + 4 <= buf.length && buf[p] === 0xff) {
      const type = buf[p + 1];
      if (type === 0xff) {
        p++;
        continue;
      }
      if (type === 0xda || type === 0xd9) break; // the picture itself begins
      const len = buf.readUInt16BE(p + 2);
      if (len < 2 || p + 2 + len > buf.length) break;
      if ((type >= 0xe1 && type <= 0xed) || type === 0xef || type === 0xfe) {
        buf[p + 1] = 0xfe; // an empty comment now
        buf.fill(0, p + 4, p + 2 + len);
        blanked++;
      }
      p += 2 + len;
    }
  }
  return blanked;
}

/**
 * The few words macOS writes into every PDF it makes (its version and build, when the copy was
 * made) blanked in place, byte for byte: a clean copy says nothing about the Mac it came from.
 */
function blankInfo(buf) {
  const text = buf.toString("latin1");
  const key = /\/(Producer|Creator|CreationDate|ModDate|Author|Title|Subject|Keywords)\s*\(/g;
  let blanked = 0;
  for (let m; (m = key.exec(text)); ) {
    let p = m.index + m[0].length;
    for (let depth = 1; p < buf.length && depth > 0; p++) {
      const c = buf[p];
      if (c === 0x5c) {
        buf[p] = 0x20;
        if (buf[p + 1] !== undefined) buf[++p] = 0x20;
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      buf[p] = 0x20;
    }
    blanked++;
  }
  return blanked;
}

/** A book the shared exam names but did not bring: it waits for the person's own copy. */
const waitingBook = (m) => ({ id: m.id, kind: m.kind, type: "pdf", title: m.title, pages: m.pages, chars: 0, offset: 0, scanned: false, hash: m.hash || "missing-" + m.id, missing: true, expect: { hash: m.hash, pages: m.pages, title: m.title, probe: m.probe } });

/**
 * Makes a new exam from an Aced file: at 0%, with the material that came along added the way
 * any file is (`files.add`), and each book that did not come along waiting for the person's own
 * copy, unless this Mac has the same file already (same SHA-256): then it is there at once.
 * Resolves to the new exam's id. `store` and `files` are the app's (passed in for the tests).
 */
async function importExam(file, { store, files, lang = "en", today, signal, already }) {
  const dir = tempDir();
  try {
    const got = unpack(file, dir);
    // The same shared file a second time: the person says whether to open the exam they have
    // or to add another copy.
    const had = got.shareId && store.exams().find((e) => e.shared && e.shared.id === got.shareId);
    if (had && already) {
      const answer = await already(had);
      if (answer === "open") return had.id;
      if (answer !== "copy") throw coded("cancelled");
    }
    const id = store.createExam(got.exam).id;
    const items = [];
    for (const m of got.materials) {
      try {
        if (m.type === "text") items.push({ ...files.addText(m.text, m.title), id: m.id, kind: m.kind });
        else if (m.pdf) {
          const item = await addShared(m, files, lang, signal);
          items.push({ ...item, id: m.id, kind: m.kind, title: m.title, from: m.from || item.from, format: m.format || item.format });
        }
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
      e.shared = { on: today, id: got.shareId || undefined };
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
  const text = files.readText(item.hash);
  const probe = item.hash !== expect.hash && text ? await probeOf(text, (pages) => files.pdfFacts(files.pdfPath(item.hash), pages, signal).then((f) => f.sizes)) : null;
  const edition = editionOf(expect, item, probe);
  store.change(examId, (e) => {
    const at = e.materials.findIndex((m) => m.id === materialId);
    e.materials[at] = { ...item, id: materialId, kind: wanted.kind, edition, expect };
  });
  return { edition, item, expect };
}

/**
 * A PDF that came along in a shared file, added to the library. Its text came along too: when
 * it is whole and fits the PDF page for page, it is kept as this Mac's reading, so nothing is
 * read again (and no AI is asked). A material only an AI can read well keeps "Read with AI" as
 * the person's own choice.
 */
async function addShared(m, files, lang, signal) {
  const hash = await files.hashFile(m.pdf);
  if (m.reading && !files.readText(hash)) {
    const facts = await files.pdfFacts(m.pdf, [], signal).catch((err) => {
      if (err.code === "cancelled") throw err;
      return null;
    });
    if (facts && facts.count === m.reading.pages.length) {
      const { pages, outline, by, model } = m.reading;
      files.writeText(hash, { pages, outline, recognised: by !== "text", ...(by === "ai" ? { reader: "ai", model } : {}) });
    }
  }
  const item = await files.add(m.pdf, null, signal, { lang });
  const text = files.readText(item.hash) || {};
  if (text.reader === "ai") return { ...item, read: "ai", model: text.model };
  return require("./see").eligible({ ...item, from: m.from }) ? { ...item, read: "local" } : item;
}

/** A name for the file from the exam's name: letters, digits, spaces and a few marks; nothing that could be a path. */
const fileName = (name, ext) => `${String(name || "Exam").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Exam"}.${ext}`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aced-share-"));

module.exports = { pack, packExam, unpack, importExam, supplyBook, probeOf, editionOf, blankPictureNotes, blankInfo, fileName, tempDir, zipOf, FORMAT, VERSION, LIMITS };

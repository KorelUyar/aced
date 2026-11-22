// What the person writes in a book (ui/ink.js): pen and highlighter strokes and text notes,
// per page. Kept on this Mac only, in "ink/<hash>.json" beside the library (the book's SHA-256,
// so the same book shows the same notes in every exam). Never written into the PDF, never part
// of a shared file (src/share.js picks what it sends field by field), and deleted with the book.
//
// A page's ink is in the page's own measure: 10000 units are the width of the page.
const fs = require("fs");
const path = require("path");

const HASH = /^[a-f0-9]{64}$/;
const MOST = { pages: 100000, strokes: 1500, points: 4000, notes: 150, text: 2000, colours: 3, coord: 200000, width: 1000 };
const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

let folder = null;
let memory = null; // the sample exams keep ink in memory only

function init(userData, { sample = false } = {}) {
  folder = path.join(userData, "ink");
  memory = sample ? new Map() : null;
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** A page's ink as it may be kept: every field checked and cut to size. Null when nothing is left on the page. */
function clean(page) {
  if (!page || typeof page !== "object") return null;
  const strokes = (Array.isArray(page.s) ? page.s : [])
    .slice(0, MOST.strokes)
    .filter((s) => s && typeof s === "object" && (s.t === "pen" || s.t === "hl") && int(s.c, 0, MOST.colours - 1) && int(s.w, 1, MOST.width) && Array.isArray(s.p) && s.p.length >= 2 && s.p.length % 2 === 0 && s.p.length <= MOST.points * 2 && s.p.every((v) => int(v, -MOST.coord, MOST.coord)))
    .map((s) => ({ t: s.t, c: s.c, w: s.w, p: s.p }));
  const notes = (Array.isArray(page.n) ? page.n : [])
    .slice(0, MOST.notes)
    .filter((n) => n && typeof n === "object" && int(n.x, 0, MOST.coord) && int(n.y, 0, MOST.coord) && typeof n.text === "string" && n.text.trim())
    .map((n) => ({ x: n.x, y: n.y, text: n.text.replace(/\u0000/g, "").slice(0, MOST.text) }));
  return strokes.length || notes.length ? { s: strokes, n: notes } : null;
}

const fileOf = (hash) => path.join(folder, `${hash}.json`);

/** All the ink of a book: { [page]: { s, n } }. */
function load(hash) {
  if (!HASH.test(String(hash))) throw coded("unknown");
  if (memory) return structuredClone(memory.get(hash) || {});
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(hash), "utf8"));
    const out = {};
    for (const [n, page] of Object.entries(data && typeof data === "object" ? data : {})) {
      const kept = int(Number(n), 1, MOST.pages) && clean(page);
      if (kept) out[Number(n)] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps one page's ink (an empty page takes its entry away). Written whole and then renamed, so a crash never leaves half a file. */
function save(hash, page, data) {
  if (!HASH.test(String(hash)) || !int(page, 1, MOST.pages)) throw coded("unknown");
  const all = load(hash);
  const kept = clean(data);
  if (kept) all[page] = kept;
  else delete all[page];
  if (memory) {
    memory.set(hash, all);
    return;
  }
  if (!Object.keys(all).length) {
    fs.rmSync(fileOf(hash), { force: true });
    return;
  }
  fs.mkdirSync(folder, { recursive: true });
  const temp = `${fileOf(hash)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(all));
  fs.renameSync(temp, fileOf(hash));
}

/** Deletes the ink of books no exam has any more (`hashes`: the ones still in use). */
function prune(hashes) {
  if (memory || !folder || !fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder)) {
    if (!hashes.has(name.split(".")[0])) fs.rmSync(path.join(folder, name), { force: true });
  }
}

module.exports = { init, load, save, prune, clean, MOST };

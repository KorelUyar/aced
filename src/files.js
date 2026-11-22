// The person's material on disk: for everything they add, a PDF in the library (the file
// itself when it is a PDF, else one made from it, see convert.js), the original next to it,
// and the text read from the PDF. Everything is named by a SHA-256 of what was added, so the
// same file is only read once. The text always comes from the PDF, so page 7 of the text is
// page 7 in the book panel, whatever the file was.
const { utilityProcess } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ocr = require("./ocr");
const formats = require("./formats");
const { unmark } = require("./formats/math");
const { decode } = require("./formats/text");

let root = null;
const dir = (name) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function init(userData) {
  root = userData;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

/** The hash of a file, or of a folder that is one document (an iWork package): its files' names and contents. */
async function hashSource(source) {
  if (!fs.lstatSync(source).isDirectory()) return hashFile(source);
  const hash = crypto.createHash("sha256");
  // Links inside it are not part of it (see `withoutLinks`).
  const walk = async (d, prefix) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(p, prefix + name + "/");
      else if (st.isFile()) hash.update(prefix + name + "\0" + (await hashFile(p)) + "\0");
    }
  };
  await walk(source, "");
  return hash.digest("hex");
}

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const pdfPath = (hash) => path.join(dir("library"), hash + ".pdf");
// (Not "cache": Chromium keeps its own "Cache" folder in the same place, and on a Mac the two
// names are the same folder. What is in here must not vanish when the browser cache is cleared.)
const textPath = (hash) => path.join(dir("texts"), hash + ".json");
// What was added, as it was added: a Word file next to the PDF made from it.
const originalsPath = (hash) => path.join(dir("originals"), hash);

function readText(hash) {
  try {
    return JSON.parse(fs.readFileSync(textPath(hash), "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value));
  fs.renameSync(file + ".tmp", file);
}

/** Replaces the text of a material (when an AI has read its pages, see see.js). */
const writeText = (hash, data) => writeJson(textPath(hash), data);

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

/**
 * Reads a PDF in a separate process. Resolves to { pages: [text], outline: [{title, page, depth}] }.
 * The process is stopped when `signal` fires, or when it has not reported anything for two
 * minutes (a damaged file can keep a reader busy for ever).
 */
function readPdf(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(coded("cancelled"));
    const child = utilityProcess.fork(path.join(__dirname, "pdf-worker.js"), [], { stdio: "ignore" });
    let settled = false;
    let watchdog;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      child.kill();
      fn(value);
    };
    const onAbort = () => finish(reject, coded("cancelled"));
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish(reject, new Error("pdf: no progress")), 120000);
    };
    signal?.addEventListener("abort", onAbort);
    alive();
    child.on("message", (m) => {
      alive();
      if (m.type === "progress") onProgress?.(m.done, m.total);
      else if (m.type === "done") finish(resolve, { pages: m.pages, outline: m.outline });
      else finish(reject, new Error("pdf: " + m.message));
    });
    child.on("exit", () => finish(reject, new Error("pdf: the reader stopped")));
    child.postMessage({ file });
  });
}

/**
 * Many books print a page number that differs from the page's position in the file (a cover,
 * a table of contents). Finds that difference when most pages agree on one, else returns 0:
 * printed page = position in the file - offset. It is negative when the file is a part of a
 * book and its first page is, say, page 120.
 */
function printedOffset(pages) {
  const votes = new Map();
  let withNumber = 0;
  pages.forEach((text, i) => {
    const lines = text.split("\n").filter((l) => l.trim());
    const seen = new Set();
    for (const line of new Set([lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1]])) {
      if (!line) continue;
      // A page number stands on its own at either end of the line: "20  1 • Prerequisites",
      // "1.1 • Real Numbers 21", "Seite 7", "– 12 –". Not the "1" of "1.1", not the "5" of "pH 4.5".
      const bare = line.replace(/^[\s|•·–—-]+|[\s|•·–—-]+$/g, "");
      for (const m of [bare.match(/^(\d{1,4})(?=\s|$)/), bare.match(/(?:^|\s)(\d{1,4})$/)]) {
        if (m && Number(m[1]) > 0) seen.add(i + 1 - Number(m[1]));
      }
    }
    if (seen.size) withNumber++;
    for (const k of seen) votes.set(k, (votes.get(k) || 0) + 1);
  });
  // The right offset wins by a wide margin: other numbers on a page vote all over the place.
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return 0;
  const [best, count] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  return count >= 8 && count >= withNumber * 0.3 && count >= second * 4 ? best : 0;
}

/** Pictures of pages: next to no text to read. */
function isScan(pages) {
  if (!pages.length) return true;
  const chars = pages.reduce((sum, p) => sum + p.length, 0);
  const empty = pages.filter((p) => p.length < 40).length;
  return empty / pages.length > 0.7 || chars / pages.length < 80;
}

/** No text that could be used, even after recognition. (A page or two with one line of real text is short, not a scan.) */
const textless = (pages) => {
  const chars = pages.reduce((sum, p) => sum + p.length, 0);
  return isScan(pages) && !(pages.length <= 3 && chars >= 10);
};

/**
 * Reads the text of a PDF (`file`) and keeps it under `hash`. Pages without text are read with
 * text recognition. `converted`: the PDF was made by this app, so its formulas carry their
 * LaTeX (see formats/math.js).
 */
async function readInto(file, hash, onProgress, signal, { converted = false, extra = {} } = {}) {
  let data = await readPdf(file, (done, total) => onProgress?.(done, total, "read"), signal);
  if (converted) data.pages = data.pages.map(unmark);
  // No text in it: a scan, a picture, or letters drawn as shapes. Read the pages with text
  // recognition. A PDF this app made from a document has the document's own text: that is only
  // recognised again when there is none at all (a drawing without words, say).
  if ((converted ? textless(data.pages) : isScan(data.pages)) && ocr.available()) {
    // Said at once, before the helper has even started: until now the last thing on screen
    // was "page N of N" of the step before, for as long as the first page took.
    onProgress?.(0, data.pages.length, "recognise");
    try {
      // `state`: "preparing" while macOS gets its recogniser ready (about a minute, the
      // first time), then which one reads the whole file: "accurate" or "fast".
      let recogniser;
      const pages = await ocr.read(
        file,
        (done, total, state) => {
          if (state && state !== "preparing") recogniser = state;
          onProgress?.(done, total, "recognise", state);
        },
        signal,
      );
      // The recognised text counts when it is real text, or when the file had none of its own
      // (a screenshot with one line on it). A short file with text of its own keeps that text.
      const letters = (list) => list.join("").replace(/\s/g, "").length;
      if (!isScan(pages) || (textless(data.pages) && letters(pages) > letters(data.pages))) data = { pages, outline: data.outline, recognised: true, recogniser };
    } catch (err) {
      if (err.code === "cancelled") throw err;
      // recognition failed: the file stays what it is, a PDF without text
    }
  }
  data = { ...data, ...extra };
  writeJson(textPath(hash), data);
  return data;
}

/** What the store keeps about a material made from a PDF and its text. */
function materialOf(hash, title, data, more = {}) {
  const chars = data.pages.reduce((sum, p) => sum + p.length, 0);
  return {
    hash,
    type: "pdf",
    title,
    pages: data.pages.length,
    chars,
    offset: printedOffset(data.pages),
    // Still no text after everything: it is left out, and the person is told.
    scanned: textless(data.pages),
    recognised: Boolean(data.recognised),
    ...(data.cut ? { cut: true } : {}),
    ...(data.partial ? { partial: true } : {}),
    ...(data.missingPictures ? { missingPictures: data.missingPictures } : {}),
    ...(data.hiddenSheets && data.hiddenSheets.length ? { hiddenSheets: data.hiddenSheets } : {}),
    ...(data.leftOut ? { leftOut: data.leftOut } : {}),
    ...more,
  };
}

const titleOf = (file) => path.basename(file, path.extname(file)).replace(/[_]+/g, " ").trim() || path.basename(file);

/**
 * Copies a file, or a folder that is one document, without any symbolic link in it: a link is
 * not part of the document, and following one would copy whatever it points at.
 */
function withoutLinks(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (from) => !fs.lstatSync(from).isSymbolicLink() });
}

/** Copies what was added next to its PDF (once). A folder that is one document is copied whole, without links. */
function keepOriginals(hash, sources) {
  const target = originalsPath(hash);
  if (fs.existsSync(target)) return;
  const tmp = target + ".tmp";
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  sources.forEach((source, i) => {
    const name = path.basename(source);
    withoutLinks(source, path.join(tmp, sources.length > 1 ? `${String(i + 1).padStart(3, "0")} ${name}` : name));
  });
  fs.renameSync(tmp, target);
}

const tmpPdf = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aced-pdf-")), "made.pdf");
const dropTmp = (file) => fs.rmSync(path.dirname(file), { recursive: true, force: true });

/**
 * Adds a file to the library and reads its text. Returns what the store keeps about it.
 * `lang` is the language of the notes the app writes on pages it makes ("only rows 1 to 1000").
 */
async function add(file, onProgress, signal, { lang = "en" } = {}) {
  const id = formats.identify(file);
  if (!id.kind || id.kind === "folder") throw coded(["empty", "zip", "link"].includes(id.why) ? id.why : "unsupported");
  if (id.kind === "picture") return addPictures([file], onProgress, signal, { lang });
  const title = titleOf(file);
  if (id.kind === "pdf") {
    const hash = await hashFile(file);
    let data = readText(hash);
    if (!data) data = await readInto(file, hash, onProgress, signal);
    if (!fs.existsSync(pdfPath(hash))) fs.copyFileSync(file, pdfPath(hash));
    return materialOf(hash, title, data, { from: "pdf" });
  }
  const hash = await hashSource(file);
  let data = readText(hash);
  if (!data || !fs.existsSync(pdfPath(hash))) {
    onProgress?.(0, 0, "convert");
    const made = tmpPdf();
    try {
      const result = await require("./convert").toPdf({ files: [file], kind: id.kind, ext: id.ext, out: made, lang }, { signal });
      data = await readInto(made, hash, onProgress, signal, { converted: true, extra: { cut: result.cut, partial: result.partial, missingPictures: result.missingPictures, hiddenSheets: result.hiddenSheets, leftOut: result.leftOut } });
      fs.copyFileSync(made, pdfPath(hash));
    } finally {
      dropTmp(made);
    }
    keepOriginals(hash, [file]);
  }
  return materialOf(hash, title, data, { from: id.kind, format: id.ext });
}

/**
 * Pictures added together become one document, one page per picture, in the order given.
 * Named after the first, with the number of pages. Pictures that cannot be read are left out
 * and come back in `failed` ([{ file, why }]).
 */
async function addPictures(pictures, onProgress, signal, { lang = "en" } = {}) {
  const hashes = [];
  for (const file of pictures) hashes.push(await hashFile(file));
  const hash = pictures.length === 1 ? hashes[0] : sha("pictures:" + hashes.join(","));
  let data = readText(hash);
  let failed = [];
  if (!data || !fs.existsSync(pdfPath(hash))) {
    onProgress?.(0, pictures.length, "convert");
    const made = tmpPdf();
    try {
      const result = await require("./convert").toPdf({ files: pictures, kind: "picture", out: made, lang }, { signal });
      failed = result.failed.map((f) => ({ file: pictures[f.index], why: f.why, size: f.width ? `${f.width} × ${f.height}` : "" }));
      data = await readInto(made, hash, onProgress, signal, { converted: false, extra: { pictures: pictures.length - failed.length } });
      fs.copyFileSync(made, pdfPath(hash));
    } finally {
      dropTmp(made);
    }
    keepOriginals(hash, pictures.filter((_, i) => !failed.some((f) => f.file === pictures[i])));
  }
  const n = data.pages.length;
  const first = titleOf(pictures.find((p) => !failed.some((f) => f.file === p)) || pictures[0]);
  const title = n > 1 ? `${first} (${lang === "de" ? `${n} Seiten` : `${n} pages`})` : first;
  return { ...materialOf(hash, title, data, { from: "pictures", files: data.pictures || pictures.length }), failed };
}

/**
 * Makes sure the text of material that was added earlier is still there, and reads it again
 * from the PDF in the library if it is not.
 */
async function ensureText(material, onProgress, signal) {
  if (material.type !== "pdf" || readText(material.hash) || !fs.existsSync(pdfPath(material.hash))) return false;
  await readInto(pdfPath(material.hash), material.hash, onProgress, signal, { converted: Boolean(material.from && !["pdf", "pictures"].includes(material.from)) });
  return true;
}

const TEXT_LIMIT = 3000000; // characters of one text; what is beyond is left out, and the person is told
const TEXT_PAGE = 3500;

/** A long text in pieces of about a page each, cut where a paragraph or a line ends. */
function inPages(text) {
  if (text.length <= TEXT_PAGE * 2) return [text];
  const pages = [];
  let rest = text;
  while (rest.length > TEXT_PAGE * 1.5) {
    let cut = rest.lastIndexOf("\n\n", TEXT_PAGE);
    if (cut < TEXT_PAGE * 0.4) cut = rest.lastIndexOf("\n", TEXT_PAGE);
    if (cut < TEXT_PAGE * 0.4) cut = rest.lastIndexOf(" ", TEXT_PAGE);
    if (cut < TEXT_PAGE * 0.4) cut = TEXT_PAGE;
    pages.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pages.push(rest);
  return pages;
}

/** Pasted text (learning objectives, notes) is kept as pages of text. */
function addText(text, title) {
  const whole = String(text).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  const clean = whole.slice(0, TEXT_LIMIT);
  if (!clean) throw new Error("empty");
  const hash = sha(clean);
  const pages = inPages(clean);
  writeJson(textPath(hash), { pages, outline: [] });
  return { hash, type: "text", title, pages: pages.length, chars: clean.length, offset: 0, scanned: false, ...(whole.length > clean.length ? { cut: true } : {}) };
}

// AI answers are kept by the hash of everything that went into the question.
const aiPath = (key) => path.join(dir("answers"), key + ".json");
function cached(key) {
  try {
    return JSON.parse(fs.readFileSync(aiPath(key), "utf8"));
  } catch {
    return null;
  }
}
const remember = (key, value) => writeJson(aiPath(key), value);

/**
 * Deletes what no exam uses any more: PDFs, originals, the text read from them, and kept
 * answers. `hashes` and `answers` are the ones still in use.
 */
function prune({ hashes, answers }) {
  const sweep = (folder, keep) => {
    for (const name of fs.readdirSync(dir(folder))) {
      if (!keep.has(name.split(".")[0])) fs.rmSync(path.join(dir(folder), name), { recursive: true, force: true });
    }
  };
  sweep("library", hashes);
  sweep("texts", hashes);
  sweep("originals", hashes);
  sweep("answers", answers);
}

module.exports = { init, add, addPictures, addText, decode, ensureText, withoutLinks, readText, writeText, pdfPath, originalsPath, printedOffset, isScan, textless, sha, cached, remember, prune, hashFile };

// The person's material on disk: a copy of every file they add, and the text read from it.
// Everything is named by the SHA-256 of the file, so the same book is only read once.
const { utilityProcess } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ocr = require("./ocr");

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

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const pdfPath = (hash) => path.join(dir("library"), hash + ".pdf");
// (Not "cache": Chromium keeps its own "Cache" folder in the same place, and on a Mac the two
// names are the same folder. What is in here must not vanish when the browser cache is cleared.)
const textPath = (hash) => path.join(dir("texts"), hash + ".json");

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

const coded = (code) => Object.assign(new Error(code), { code });

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
 * printed page = position in the file - offset.
 */
function printedOffset(pages) {
  const votes = new Map();
  let withNumber = 0;
  pages.forEach((text, i) => {
    const lines = text.split("\n").filter((l) => l.trim());
    const seen = new Set();
    for (const line of [lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1]]) {
      const m = line && line.trim().match(/^(\d{1,4})\b|\b(\d{1,4})$/);
      if (!m) continue;
      const printed = Number(m[1] || m[2]);
      if (printed > 0 && printed <= i + 1) seen.add(i + 1 - printed);
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

/** Adds a file to the library and reads its text. Returns what the store keeps about it. */
async function add(file, onProgress, signal) {
  const ext = path.extname(file).toLowerCase();
  const title = path.basename(file, path.extname(file)).replace(/[_]+/g, " ").trim();
  if (ext === ".pdf") {
    const hash = await hashFile(file);
    let data = readText(hash);
    if (!data) {
      data = await readPdf(file, (done, total) => onProgress?.(done, total, "read"), signal);
      // No text in it: a scan, or letters drawn as shapes. Read the pages with text recognition.
      if (isScan(data.pages) && ocr.available()) {
        try {
          const pages = await ocr.read(file, (done, total) => onProgress?.(done, total, "recognise"), signal);
          if (!isScan(pages)) data = { pages, outline: data.outline, recognised: true };
        } catch (err) {
          if (err.code === "cancelled") throw err;
          // recognition failed: the file stays what it is, a PDF without text
        }
      }
      writeJson(textPath(hash), data);
    }
    if (!fs.existsSync(pdfPath(hash))) fs.copyFileSync(file, pdfPath(hash));
    const chars = data.pages.reduce((sum, p) => sum + p.length, 0);
    return {
      hash,
      type: "pdf",
      title,
      pages: data.pages.length,
      chars,
      offset: printedOffset(data.pages),
      // Still no text after everything: it is left out, and the person is told.
      scanned: isScan(data.pages),
      recognised: Boolean(data.recognised),
    };
  }
  if ([".txt", ".md", ".markdown", ".text"].includes(ext)) return addText(fs.readFileSync(file, "utf8"), title);
  throw new Error("unsupported");
}

/**
 * Makes sure the text of a PDF that was added earlier is still there, and reads it again from
 * the copy in the library if it is not.
 */
async function ensureText(material, onProgress, signal) {
  if (material.type !== "pdf" || readText(material.hash) || !fs.existsSync(pdfPath(material.hash))) return false;
  await add(pdfPath(material.hash), onProgress, signal);
  return true;
}

/** Pasted text (learning objectives, notes) is kept the same way, as one "page". */
function addText(text, title) {
  const clean = String(text).replace(/\r\n?/g, "\n").trim().slice(0, 400000);
  if (!clean) throw new Error("empty");
  const hash = sha(clean);
  writeJson(textPath(hash), { pages: [clean], outline: [] });
  return { hash, type: "text", title, pages: 1, chars: clean.length, offset: 0, scanned: false };
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
 * Deletes what no exam uses any more: copies of PDFs, the text read from them, and kept
 * answers. `hashes` and `answers` are the ones still in use.
 */
function prune({ hashes, answers }) {
  const sweep = (folder, keep) => {
    for (const name of fs.readdirSync(dir(folder))) {
      if (!keep.has(name.replace(/\.(pdf|json)$/, ""))) fs.rmSync(path.join(dir(folder), name), { force: true });
    }
  };
  sweep("library", hashes);
  sweep("texts", hashes);
  sweep("answers", answers);
}

module.exports = { init, add, addText, ensureText, readText, pdfPath, printedOffset, sha, cached, remember, prune };

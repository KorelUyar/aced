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
          if (!isScan(pages)) data = { pages, outline: data.outline, recognised: true, recogniser };
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
      // Still no text after everything: it is left out, and the person is told. (A page or two
      // with one line of real text is short, not a scan.)
      scanned: isScan(data.pages) && !(data.pages.length <= 3 && chars >= 10),
      recognised: Boolean(data.recognised),
    };
  }
  if ([".txt", ".md", ".markdown", ".text"].includes(ext)) return addText(decode(fs.readFileSync(file)), title);
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

/**
 * A text file as text, whatever it was saved as: UTF-8 (with or without a mark at the start),
 * UTF-16 (which Windows and TextEdit both write), or the Western European encoding of older
 * files, in which every byte is a letter.
 */
function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // UTF-16 without a mark: every other byte of ordinary text is zero.
  const sample = bytes.subarray(0, 2000);
  let zeroEven = 0;
  let zeroOdd = 0;
  sample.forEach((b, i) => b === 0 && (i % 2 ? zeroOdd++ : zeroEven++));
  if (sample.length >= 8 && zeroOdd > sample.length * 0.3 && zeroEven < sample.length * 0.05) return new TextDecoder("utf-16le").decode(bytes);
  if (sample.length >= 8 && zeroEven > sample.length * 0.3 && zeroOdd < sample.length * 0.05) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
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

/** Pasted text and text files (learning objectives, notes) are kept the same way as a book: as pages of text. */
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

module.exports = { init, add, addText, decode, ensureText, readText, pdfPath, printedOffset, sha, cached, remember, prune };

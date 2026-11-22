// Turns any material into a PDF: the one form the rest of the app knows (the book panel shows
// it, its pages are read, steps point into it). Each kind of file has one way there:
// - pictures: the macOS helper puts them on pages (native/ocr.swift, --images);
// - old Word files, RTF and Safari web archives: macOS's textutil makes a web page of them;
// - old PowerPoint files: macOS's Quick Look makes a web page of them;
// - everything else: read in a separate process (src/convert-worker.js) into a web page;
// - web pages are printed to PDF by a locked-down hidden page (src/print.js).
// Everything happens in a folder of its own that is deleted afterwards.
const { utilityProcess } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ocr = require("./ocr");
const { print } = require("./print");

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

/** Runs a program with a time limit; resolves to { code, out } (stdout as text). */
function runTool(exe, args, { signal, limit = 120000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(coded("cancelled"));
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let rest = "";
    let stopped = null;
    const timer = setTimeout(() => {
      stopped = "slow";
      child.kill();
    }, limit);
    const onAbort = () => {
      stopped = "cancelled";
      child.kill();
    };
    signal?.addEventListener("abort", onAbort);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!onLine) return;
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        try {
          onLine(JSON.parse(line));
        } catch {
          // not a line of ours
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (stopped === "cancelled") return reject(coded("cancelled"));
      if (stopped) return reject(coded("tooLarge"));
      resolve({ code, out });
    });
  });
}

/** Reads a file in the conversion process. Resolves to what the worker made: { page, pdf, cut, partial, missingPictures }. */
function inWorker(job, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(coded("cancelled"));
    const child = utilityProcess.fork(path.join(__dirname, "convert-worker.js"), [], { stdio: "ignore", serviceName: "Aced converter" });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill();
      fn(value);
    };
    // A file that keeps the reader busy for three minutes is given up.
    const timer = setTimeout(() => finish(reject, coded("tooLarge")), 180000);
    const onAbort = () => finish(reject, coded("cancelled"));
    signal?.addEventListener("abort", onAbort);
    child.on("message", (m) => (m.type === "done" ? finish(resolve, m) : finish(reject, coded(m.code || "damaged", m.message))));
    child.on("exit", () => finish(reject, coded("damaged", "the reader stopped")));
    child.postMessage(job);
  });
}

/** Where a picture was taken and how large it is: [{ width, height, pages, taken, failed }], in the order given. */
async function pictureInfo(files, signal) {
  if (!ocr.available()) return files.map(() => ({}));
  const info = files.map(() => ({}));
  await runTool(ocr.helperPath(), ["--info", ...files], { signal, onLine: (l) => typeof l.file === "number" && (info[l.file] = l) });
  return info;
}

/**
 * Makes a PDF at `out` from `files` (several only for pictures). `kind` and `ext` come from
 * formats/index.js. Resolves to { cut, partial, missingPictures, failed: [{ index, why }] }.
 */
async function toPdf({ files, kind, ext, out, lang }, { signal } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aced-convert-"));
  try {
    if (kind === "picture") {
      if (!ocr.available()) throw coded("unsupported");
      const failed = [];
      let pages = 0;
      await runTool(ocr.helperPath(), ["--images", out, ...files], {
        signal,
        limit: 60000 + files.length * 20000,
        onLine: (l) => {
          if (l.failed) failed.push({ index: l.file, why: l.failed, width: l.width, height: l.height });
          if (l.done) pages = l.pages;
        },
      });
      if (!pages) throw coded(failed.some((f) => f.why === "large") ? "tooManyPixels" : "unreadable", failed[0] && failed[0].width ? `${failed[0].width} × ${failed[0].height}` : "");
      return { failed, pages };
    }
    let job = { kind, file: files[0], ext, lang, out: work };
    if (kind === "textutil") {
      const page = path.join(work, "page.html");
      // An RTF with pictures is a folder (.rtfd): textutil reads a copy of it without links,
      // so a picture in it can only be one that is really in it.
      let source = files[0];
      if (fs.lstatSync(source).isDirectory()) {
        source = path.join(work, "source" + path.extname(files[0]));
        require("./files").withoutLinks(files[0], source);
      }
      const { code } = await runTool("/usr/bin/textutil", ["-convert", "html", "-noload", "-output", page, "--", source], { signal, limit: 120000 });
      if (code !== 0 || !fs.existsSync(page)) throw coded("unreadable");
      job = { ...job, kind: "html", file: page };
    } else if (kind === "ppt") {
      const { code } = await runTool("/usr/bin/qlmanage", ["-p", "-o", work, files[0]], { signal, limit: 120000 });
      const preview = fs.readdirSync(work).filter((n) => n.endsWith(".qlpreview")).map((n) => path.join(work, n, "Preview.html")).find((p) => fs.existsSync(p));
      if (code !== 0 || !preview) throw coded("unreadable");
      job = { ...job, kind: "slides-html", file: preview };
    }
    const made = await inWorker(job, signal);
    if (made.pdf) fs.copyFileSync(made.pdf, out);
    else await print(made.page, out, { signal });
    return { cut: made.cut, partial: made.partial, missingPictures: made.missingPictures, hiddenSheets: made.hiddenSheets, leftOut: made.leftOut, failed: [] };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Pictures of the pages of a PDF, as an AI that can see is shown them: JPEG files of at most
 * `longSide` pixels. Resolves to [{ page, file, width, height }].
 */
async function pagePictures(pdf, folder, { longSide = 2000, first = 1, last = 1e6, signal } = {}) {
  if (!ocr.available()) throw coded("unsupported");
  const pages = [];
  await runTool(ocr.helperPath(), ["--render", pdf, String(longSide), folder, String(first), String(last)], {
    signal,
    onLine: (l) => l.file && pages.push({ page: l.page, file: l.file, width: l.width, height: l.height }),
  });
  return pages;
}

/** The small picture with one line of print that tells whether an AI can see. */
async function samplePicture(file) {
  if (!ocr.available()) throw coded("unsupported");
  await runTool(ocr.helperPath(), ["--sample", file], {});
  return file;
}

module.exports = { toPdf, pictureInfo, pagePictures, samplePicture, runTool };

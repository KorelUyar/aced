// Text recognition for PDFs without text in them: scans, and books saved from a web reader
// that draws its letters as shapes (Stapel's PDFs are like that). The work is done by a small
// helper built from native/ocr.swift, which uses the recognition built into macOS. It runs on
// this Mac; no page leaves it.
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function helper() {
  if (process.platform !== "darwin") return null;
  const file = app.isPackaged ? path.join(process.resourcesPath, "aced-ocr") : path.join(__dirname, "..", "build", "bin", "aced-ocr");
  return fs.existsSync(file) ? file : null;
}

const available = () => Boolean(helper());
/** The helper's place on disk (for its other tasks: pictures to PDF, pages to pictures). */
const helperPath = () => helper();

const cancelled = () => Object.assign(new Error("cancelled"), { code: "cancelled" });

/**
 * Runs the helper and hands every line it prints to `onStep`, as an object. The helper says
 * where it stands at least every two seconds, also while macOS is busy; it is stopped when
 * `signal` fires, or when it has printed nothing for three minutes.
 */
function run(args, onStep, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const child = spawn(helper(), args, { stdio: ["ignore", "pipe", "ignore"] });
    let rest = "";
    let stopped = null;
    let watchdog;
    const stop = (why) => {
      stopped = why;
      child.kill();
    };
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop("stuck"), 180000);
    };
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort);
    alive();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      alive();
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        try {
          onStep(JSON.parse(line));
        } catch {
          // not a line of ours
        }
      }
    });
    const done = () => {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      if (stopped === "cancelled") return reject(cancelled());
      if (stopped || code !== 0) return reject(new Error("ocr"));
      resolve();
    });
  });
}

/**
 * Resolves to the text of every page, in order.
 *
 * `onProgress(done, total, state)` is called at once with done = 0, before anything is read,
 * and then after every page. `state` says which recogniser reads the file. It is decided once,
 * before the first page, and holds for the whole file: "accurate", or "fast" (the weaker one)
 * on a Mac where the accurate one cannot be used. Until then it is undefined, or "preparing"
 * while macOS gets the accurate one ready: that takes about a minute the first time the helper
 * runs, and again after an update of the app or of macOS (see `prepare`).
 */
async function read(file, onProgress, signal) {
  const pages = [];
  let state;
  await run(
    [file],
    (step) => {
      if (step.preparing) state = "preparing";
      if (step.recogniser) state = step.recogniser;
      if (typeof step.text === "string") pages[step.page - 1] = step.text;
      onProgress?.(step.page, step.total, state);
    },
    signal,
  );
  if (!pages.length) throw new Error("ocr");
  return Array.from(pages, (p) => p || "");
}

/**
 * Gets the recogniser ready without reading a file, so that the minute macOS needs the first
 * time is not spent while somebody waits for a book. Can run in the background after the app
 * has started; when everything is ready it takes a fraction of a second. Resolves to the
 * recogniser files will be read with: "accurate" or "fast" (null without the helper).
 */
async function prepare(signal) {
  if (!available()) return null;
  let recogniser = null;
  await run(["--prepare"], (step) => (recogniser = step.recogniser || recogniser), signal);
  return recogniser;
}

module.exports = { available, read, prepare, helperPath };

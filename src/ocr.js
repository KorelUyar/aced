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
  const file = app.isPackaged ? path.join(process.resourcesPath, "spurt-ocr") : path.join(__dirname, "..", "build", "bin", "spurt-ocr");
  return fs.existsSync(file) ? file : null;
}

const available = () => Boolean(helper());

/**
 * Resolves to the text of every page, in order. The helper is stopped when `signal` fires, or
 * when it has printed nothing for three minutes.
 */
function read(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    const child = spawn(helper(), [file], { stdio: ["ignore", "pipe", "ignore"] });
    const pages = [];
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
          const { page, total, text } = JSON.parse(line);
          pages[page - 1] = text;
          onProgress?.(page, total);
        } catch {
          // not a line of ours
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      if (stopped === "cancelled") return reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
      if (stopped || code !== 0 || !pages.length) return reject(new Error("ocr"));
      resolve(Array.from(pages, (p) => p || ""));
    });
  });
}

module.exports = { available, read };

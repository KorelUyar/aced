// Sending a file the Mac's own ways, straight from Aced's share window: AirDrop, Messages and
// Mail (NSSharingService), and the file on the clipboard, all through the helper built from
// native/ocr.swift. Nothing here goes over the network by itself; macOS does the sending.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ocr = require("./ocr");

const WAYS = ["airdrop", "messages", "mail"];
const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

/**
 * Runs the helper with `args` and resolves to the first line it prints that `wanted(line)`
 * accepts (or to null when it ends first). It may go on running after that: AirDrop's or
 * Messages's window belongs to it until the person is done there.
 */
function ask(args, wanted, { timeout = 20000 } = {}) {
  const helper = ocr.helperPath();
  if (!helper) return Promise.reject(coded("shareFailed", "no helper"));
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "ignore"], detached: false });
    let rest = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, coded("shareFailed", "no answer")), timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value && wanted(value)) finish(resolve, value);
      }
    });
    child.on("error", (err) => finish(reject, coded("shareFailed", err.message)));
    child.on("close", (code) => finish(code === 0 ? resolve : reject, code === 0 ? null : coded("shareFailed", `exit ${code}`)));
  });
}

let known = null; // { at, value }: what this Mac has set up, asked again after a minute
/** Which of AirDrop, Messages and Mail this Mac has: { airdrop, messages, mail } (all false without the helper). */
async function services() {
  if (known && Date.now() - known.at < 60000) return known.value;
  if (process.platform !== "darwin" || !ocr.available()) return { airdrop: false, messages: false, mail: false };
  const line = await ask(["--can-share"], (v) => typeof v.airdrop === "boolean").catch(() => null);
  const value = Object.fromEntries(WAYS.map((w) => [w, Boolean(line && line[w])]));
  known = { at: Date.now(), value };
  return value;
}

/**
 * Hands `file` to AirDrop, Messages or Mail: their window opens with it. Resolves to
 * { opened: true } or { missing: true } (not set up on this Mac). For Mail, `subject` and
 * `text` start the message.
 */
async function send(way, file, { subject = "", text = "" } = {}) {
  if (!WAYS.includes(way)) throw coded("unknown");
  if (process.platform !== "darwin" || !ocr.available()) return { missing: true };
  const args = ["--share", way, file];
  if (way === "mail") args.push(String(subject).slice(0, 200), String(text).slice(0, 2000));
  const line = await ask(args, (v) => v.opened === true || v.missing === true);
  if (line && line.missing) {
    known = null;
    return { missing: true };
  }
  if (!line) throw coded("shareFailed");
  return { opened: true };
}

/** Puts `file` on the clipboard, the way the Finder copies a file: it pastes into WhatsApp, Messages, Mail or a folder. */
async function copyFile(file) {
  if (process.platform !== "darwin" || !ocr.available()) throw coded("shareFailed", "no helper");
  const line = await ask(["--copy-file", file], (v) => v.copied === true);
  if (!line) throw coded("shareFailed");
}

// A file handed to another app (the clipboard, AirDrop, Messages, Mail) has to outlive Aced:
// it may be pasted or sent after Aced has quit. It is kept in a folder of its own in the
// temporary folder, and such folders are deleted at the next start once they are two days old.
const KEPT = "aced-sent-";
const keptDir = () => fs.mkdtempSync(path.join(os.tmpdir(), KEPT));
function pruneKept(now = Date.now(), maxAge = 2 * 864e5) {
  let gone = 0;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(KEPT)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < maxAge) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      gone++;
    } catch {
      // gone already
    }
  }
  return gone;
}

module.exports = { WAYS, services, send, copyFile, keptDir, pruneKept };

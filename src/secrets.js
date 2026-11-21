// API keys, encrypted with the Mac's keychain (Electron safeStorage) before they touch the disk.
// They are read only in the main process and never sent to the window.
const { safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

let file = null;
let memory = {}; // also the fallback while running on sample data or in tests

function init(userData, { persist = true } = {}) {
  file = persist ? path.join(userData, "keys.bin") : null;
  if (!file) return;
  try {
    memory = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  } catch {
    memory = {};
  }
}

const get = (name) => memory[name] || "";
const has = (name) => Boolean(memory[name]);

function set(name, value) {
  const key = String(value || "").trim();
  if (key) memory[name] = key;
  else delete memory[name];
  if (!file) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("keychain");
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(memory)), { mode: 0o600 });
}

module.exports = { init, get, has, set };

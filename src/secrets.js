// API keys, encrypted with the Mac's keychain (Electron safeStorage) before they touch the disk.
// They are read only in the main process and never sent to the window.
const { safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

let file = null;
let memory = {}; // also all there is while running on sample data or in tests
let loaded = Promise.resolve();

// Electron is moving safeStorage to calls that do not block; older versions only have the others.
const canEncrypt = () => (safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(safeStorage.isEncryptionAvailable()));
const encrypt = (text) => (safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(text) : Promise.resolve(safeStorage.encryptString(text)));
const decrypt = (data) => (safeStorage.decryptStringAsync ? safeStorage.decryptStringAsync(data) : Promise.resolve(safeStorage.decryptString(data)));

/** Starts reading the saved keys. `ready()` resolves when they are there. */
function init(userData, { persist = true } = {}) {
  file = persist ? path.join(userData, "keys.bin") : null;
  if (!file || !fs.existsSync(file)) return;
  loaded = decrypt(fs.readFileSync(file))
    .then((text) => {
      // Depending on the Electron version the answer is the text or an object holding it.
      memory = JSON.parse(typeof text === "string" ? text : text.result);
    })
    .catch(() => {
      memory = {};
    });
}

const ready = () => loaded;
const get = (name) => memory[name] || "";
const has = (name) => Boolean(memory[name]);

async function set(name, value) {
  await loaded;
  const key = String(value || "").trim();
  if (key) memory[name] = key;
  else delete memory[name];
  if (!file) return;
  if (!(await canEncrypt())) throw Object.assign(new Error("keychain"), { code: "keychain" });
  fs.writeFileSync(file, await encrypt(JSON.stringify(memory)), { mode: 0o600 });
}

module.exports = { init, ready, get, has, set };

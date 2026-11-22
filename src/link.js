// A link to a shared exam. The Aced file is locked on this Mac with a key made for it
// (AES-256-GCM) and only the locked bytes go to the share service, which keeps them 30 days.
// The link carries the key after "#": browsers never send that part to a server, and Aced
// never does either. So the service holds bytes it cannot read.
//
//   https://<service>/s/<id>#<key>   what the friend gets (the service's page: "Open in Aced")
//   aced://s/<id>#<key>              what that page hands to Aced
//
// Aced only ever asks its own service (HOST below): a link naming any other address is refused,
// whatever it looks like. What comes back is opened exactly like an Aced file from the Finder.
const crypto = require("crypto");

// The share service: one address, set when the service is running. Empty: no links (the share
// window says so). The service itself is in service/ (one setting there: where it keeps files).
const HOST = "";

const MAGIC = Buffer.from("ACD1", "latin1"); // locked Aced file, version 1
const IV = 12;
const TAG = 16;
const MAX = 25 * 1024 * 1024; // bytes of an Aced file one link takes
const DAYS = 30;
const ID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

const b64url = (buf) => Buffer.from(buf).toString("base64url");
/** The key from its 43 letters, or null: exactly 32 bytes, written exactly one way. */
function keyOf(text) {
  if (typeof text !== "string" || !KEY.test(text)) return null;
  const key = Buffer.from(text, "base64url");
  return key.length === 32 && b64url(key) === text ? key : null;
}

/** Locks `bytes` with a new key. Resolves to { key (43 letters), blob }. */
function seal(bytes) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(IV);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { key: b64url(key), blob: Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]) };
}

/** Unlocks a blob with the key from its link. Throws "linkDamaged" for anything that is not exactly what was locked. */
function unseal(blob, keyText) {
  const key = keyOf(keyText);
  if (!key || !Buffer.isBuffer(blob) || blob.length < MAGIC.length + IV + TAG + 1 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw coded("linkDamaged");
  try {
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(blob.subarray(blob.length - TAG));
    return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + IV, blob.length - TAG)), decipher.final()]);
  } catch {
    throw coded("linkDamaged");
  }
}

/**
 * A share service's address as Aced accepts one: https (or http to this Mac itself, for tests),
 * a host name and maybe a port, nothing else. Resolves to its origin, or "" when there is none.
 */
function originOf(host) {
  if (typeof host !== "string" || !host || host.length > 200) return "";
  let url;
  try {
    url = new URL(host);
  } catch {
    return "";
  }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return "";
  return url.origin;
}

/**
 * The share in a link: { id, key }, or null. Taken: "aced://s/<id>#<key>" and the service's own
 * "https://<service>/s/<id>#<key>", exactly so: another address, more path, a query, spaces or a
 * key of the wrong length are no link of Aced's.
 */
function parse(text, host = HOST) {
  if (typeof text !== "string" || text.length > 300) return null;
  const s = text.trim();
  const m = /^aced:\/\/s\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(s);
  if (m) return keyOf(m[2]) ? { id: m[1], key: m[2] } : null;
  const origin = originOf(host);
  if (!origin || !s.toLowerCase().startsWith(origin.toLowerCase() + "/s/")) return null;
  const rest = /^\/s\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(s.slice(origin.length));
  return rest && keyOf(rest[2]) ? { id: rest[1], key: rest[2] } : null;
}

/** The link the friend gets. */
const linkOf = (host, id, key) => `${originOf(host)}/s/${id}#${key}`;

const dayIn = (days, now = Date.now()) => new Date(now + days * 864e5).toISOString().slice(0, 10);

/**
 * Locks an Aced file and puts it on the service. Resolves to { url, expires (YYYY-MM-DD) }.
 * Throws "linkOff" (no service), "linkTooBig" (detail: megabytes), "linkBusy" (too many at
 * once) or "linkServer" (the service did not take it).
 */
async function make(bytes, { host = HOST, fetch = globalThis.fetch, timeout = 180000 } = {}) {
  const origin = originOf(host);
  if (!origin) throw coded("linkOff");
  if (bytes.length > MAX) throw coded("linkTooBig", String(Math.ceil(bytes.length / 1048576)));
  const { key, blob } = seal(bytes);
  let answer;
  try {
    answer = await fetch(`${origin}/api/s`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob, signal: AbortSignal.timeout(timeout), redirect: "error" });
  } catch {
    throw coded("linkServer");
  }
  if (answer.status === 413) throw coded("linkTooBig", String(Math.ceil(bytes.length / 1048576)));
  if (answer.status === 429) throw coded("linkBusy");
  if (answer.status !== 201) throw coded("linkServer", String(answer.status));
  let body;
  try {
    body = await answer.json();
  } catch {
    throw coded("linkServer");
  }
  if (!body || typeof body.id !== "string" || !ID.test(body.id)) throw coded("linkServer");
  const expires = typeof body.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.expires) ? body.expires : dayIn(DAYS);
  return { url: linkOf(origin, body.id, key), expires };
}

/**
 * Fetches a shared exam from its link ({ id, key }, see `parse`) and unlocks it. Resolves to the
 * Aced file's bytes. Throws "linkGone" (run out, or never there), "linkDamaged" (changed, or a
 * wrong key), "linkOffline" (the service cannot be reached) or "linkOff" (no service).
 */
async function fetchShared({ id, key }, { host = HOST, fetch = globalThis.fetch, timeout = 120000 } = {}) {
  const origin = originOf(host);
  if (!origin) throw coded("linkOff");
  if (typeof id !== "string" || !ID.test(id) || !keyOf(key)) throw coded("linkDamaged");
  let answer;
  try {
    answer = await fetch(`${origin}/api/s/${id}`, { signal: AbortSignal.timeout(timeout), redirect: "error" });
  } catch {
    throw coded("linkOffline");
  }
  if (answer.status === 404 || answer.status === 410) throw coded("linkGone");
  if (answer.status !== 200 || !answer.body) throw coded("linkOffline", String(answer.status));
  const most = MAX + MAGIC.length + IV + TAG + 1024;
  if (Number(answer.headers.get("content-length")) > most) throw coded("linkDamaged");
  // Read up to the most a link can hold, never more.
  const parts = [];
  let size = 0;
  const reader = answer.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > most) throw coded("linkDamaged");
      parts.push(Buffer.from(value));
    }
  } catch (err) {
    if (err.code === "linkDamaged") throw err;
    throw coded("linkOffline");
  } finally {
    reader.releaseLock?.();
  }
  return unseal(Buffer.concat(parts), key);
}

module.exports = { HOST, MAX, DAYS, MAGIC, seal, unseal, parse, originOf, linkOf, make, fetchShared, keyOf };

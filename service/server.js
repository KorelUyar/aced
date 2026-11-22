#!/usr/bin/env node
// The share service behind Aced's "Copy link": it keeps locked Aced files for 30 days so that
// friends can open them from a link. It never sees what is inside. Aced locks every file on the
// sender's Mac with a key of its own (AES-256-GCM), and only the link carries that key, after
// "#": browsers never send that part to a server. The page a link opens unlocks the plan in the
// browser; "Open in Aced" hands the link to the app, which fetches and unlocks the file itself.
//
// Node 20 or newer, nothing else: no packages.
//
//   POST /api/s        the locked file (application/octet-stream)   201 { id, expires }
//   GET  /api/s/<id>   the locked file                              200, or 404 when it has run out
//   GET  /s/<id>       the page a link opens (page.html)
//   GET  /healthz      "ok"
//
// Settings, from the environment (all optional):
//   PORT=8790  BIND=127.0.0.1  DATA_DIR=./data  KEEP_DAYS=30  MAX_MB=25  MAX_TOTAL_MB=4096
//   UPLOADS_PER_HOUR=30  FETCHES_PER_MINUTE=60      per visitor
//   CLIENT_IP_HEADER   behind a proxy or tunnel: the header in which it names the visitor's
//                      address, one address it sets itself (cf-connecting-ip, for example).
//   TRUSTED_PROXIES    the addresses that proxy connects from (127.0.0.1,::1 for a tunnel on
//                      the same machine). The header counts only on connections from there, and
//                      only its last value (the one the proxy added); anything else, and a
//                      header that is not one plain address, counts as the connection's address.
// The limits count per visitor, so the service must be reachable through the proxy only: it
// listens on 127.0.0.1 unless BIND says otherwise.
// Nothing about the visitors is written down: no log of addresses, ids or files.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

const MAGIC = Buffer.from("ACD1", "latin1"); // what every locked Aced file starts with
const SMALLEST = MAGIC.length + 12 + 16 + 1; // magic, nonce, tag and one byte
const ID = /^[A-Za-z0-9_-]{22}$/;
const DAY = 864e5;

function settings(env = process.env) {
  const number = (name, fallback) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    port: number("PORT", 8790),
    bind: env.BIND || "127.0.0.1",
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, "data")),
    keepDays: number("KEEP_DAYS", 30),
    maxBytes: Math.round(number("MAX_MB", 25) * 1048576),
    maxTotal: Math.round(number("MAX_TOTAL_MB", 4096) * 1048576),
    uploadsPerHour: number("UPLOADS_PER_HOUR", 30),
    fetchesPerMinute: number("FETCHES_PER_MINUTE", 60),
    ipHeader: (env.CLIENT_IP_HEADER || "").toLowerCase(),
    trustedProxies: String(env.TRUSTED_PROXIES || "").split(",").map((a) => a.trim()).filter(Boolean),
  };
}

const STATIC = {
  "/page.js": ["page.js", "text/javascript; charset=utf-8"],
  "/page.css": ["page.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
};

const SAFE = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};
// The page: its own script and style only, it talks to this service only, and nothing can frame it.
const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Counts per visitor in a window of time (`per` ms): `take(who)` is false once `most` are used. */
function limiter(most, per, now) {
  const seen = new Map();
  return {
    take(who) {
      const t = now();
      let entry = seen.get(who);
      if (!entry || t - entry.start >= per) {
        entry = { start: t, count: 0 };
        seen.set(who, entry);
      }
      if (entry.count >= most) return false;
      entry.count++;
      return true;
    },
    tidy() {
      const t = now();
      for (const [who, entry] of seen) if (t - entry.start >= per) seen.delete(who);
    },
  };
}

/**
 * Starts the service. `config` as `settings()` gives it; `now` stands in for the clock in tests.
 * Resolves to { server, port, sweep, close }.
 */
async function start(config = settings(), { now = () => Date.now(), quiet = false } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const keep = config.keepDays * DAY;
  const fileOf = (id) => path.join(config.dataDir, id);
  const uploads = limiter(config.uploadsPerHour, 3600e3, now);
  const fetches = limiter(config.fetchesPerMinute, 60e3, now);
  const pages = Object.fromEntries(
    Object.entries(STATIC).map(([route, [name, type]]) => [route, { body: fs.readFileSync(path.join(__dirname, name)), type }]),
  );
  const page = fs.readFileSync(path.join(__dirname, "page.html"));

  // What is kept: id -> { size, at }. Read from the folder at the start (a leftover half-written file goes).
  const kept = new Map();
  let total = 0;
  for (const name of fs.readdirSync(config.dataDir)) {
    const file = path.join(config.dataDir, name);
    if (!ID.test(name)) {
      if (name.startsWith(".part-")) fs.rmSync(file, { force: true });
      continue;
    }
    const st = fs.statSync(file);
    kept.set(name, { size: st.size, at: st.mtimeMs });
    total += st.size;
  }
  const forget = (id) => {
    const entry = kept.get(id);
    if (!entry) return;
    kept.delete(id);
    total -= entry.size;
    fs.rmSync(fileOf(id), { force: true });
  };
  /** Deletes what has run out. Resolves to how many went. */
  const sweep = () => {
    let gone = 0;
    for (const [id, entry] of kept) {
      if (now() - entry.at >= keep) {
        forget(id);
        gone++;
      }
    }
    uploads.tidy();
    fetches.tidy();
    return gone;
  };
  sweep();
  const timer = setInterval(sweep, 10 * 60e3);
  timer.unref();

  let busy = 0; // uploads under way
  const sending = new Map(); // visitor -> their uploads under way
  const plain = (address) => String(address || "?").replace(/^::ffff:(?=\d+\.)/, "");
  const trusted = new Set((config.trustedProxies || []).map(plain));
  /** Who is asking: the connection's address, or the one a trusted proxy names (see TRUSTED_PROXIES). */
  const visitor = (req) => {
    const peer = plain(req.socket.remoteAddress);
    if (!config.ipHeader || !trusted.has(peer)) return peer;
    const said = req.headers[config.ipHeader];
    const last = typeof said === "string" ? said.split(",").pop().trim() : "";
    return net.isIP(last) ? plain(last) : peer;
  };
  const send = (res, status, body, headers = {}) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { ...SAFE, "Content-Length": data.length, "Cache-Control": "no-store", ...(typeof body === "object" && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...headers });
    res.end(data);
  };
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

  async function upload(req, res) {
    const who = visitor(req);
    // Two uploads at a time per visitor: one sender cannot hold every place.
    if ((sending.get(who) || 0) >= 2) return send(res, 429, { error: "busy" }, { "Retry-After": "30" });
    if (!uploads.take(who)) return send(res, 429, { error: "busy" }, { "Retry-After": "600" });
    if (String(req.headers["content-type"] || "").split(";")[0].trim() !== "application/octet-stream") return send(res, 415, { error: "type" });
    const length = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
    if (length !== null && (!Number.isInteger(length) || length > config.maxBytes)) return send(res, 413, { error: "large" }, { Connection: "close" });
    if (length !== null && length < SMALLEST) return send(res, 400, { error: "small" });
    if (total + (length || 0) > config.maxTotal) return send(res, 507, { error: "full" });
    if (busy >= 8) return send(res, 503, { error: "busy" }, { "Retry-After": "30" });
    busy++;
    sending.set(who, (sending.get(who) || 0) + 1);
    // An upload that stops sending is dropped after a few seconds, and its place is free again.
    req.setTimeout(config.idleMs || 10e3, () => req.destroy(new Error("idle")));
    const part = path.join(config.dataDir, `.part-${crypto.randomBytes(9).toString("hex")}`);
    const out = fs.createWriteStream(part, { mode: 0o600 });
    let size = 0;
    let head = Buffer.alloc(0);
    let failed = null;
    try {
      await new Promise((resolve, reject) => {
        req.on("data", (chunk) => {
          if (failed) return;
          size += chunk.length;
          if (head.length < MAGIC.length) head = Buffer.concat([head, chunk.subarray(0, MAGIC.length - head.length)]);
          if (size > config.maxBytes) {
            failed = 413;
            req.pause();
            return resolve();
          }
          if (head.length >= MAGIC.length && !head.equals(MAGIC)) {
            failed = 400;
            req.pause();
            return resolve();
          }
          if (!out.write(chunk)) {
            req.pause();
            out.once("drain", () => req.resume());
          }
        });
        req.on("end", resolve);
        req.on("error", reject);
        req.on("aborted", () => reject(new Error("aborted")));
      });
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (!failed && (size < SMALLEST || !head.equals(MAGIC))) failed = 400;
      if (!failed && total + size > config.maxTotal) failed = 507;
      if (failed) {
        fs.rmSync(part, { force: true });
        return send(res, failed, { error: failed === 413 ? "large" : failed === 507 ? "full" : "bad" }, { Connection: "close" });
      }
      let id;
      do id = crypto.randomBytes(16).toString("base64url");
      while (kept.has(id) || !ID.test(id));
      fs.renameSync(part, fileOf(id));
      const at = now();
      const when = new Date(at);
      fs.utimesSync(fileOf(id), when, when);
      kept.set(id, { size, at });
      total += size;
      return send(res, 201, { id, expires: dayOf(at + keep) });
    } catch {
      out.destroy();
      fs.rmSync(part, { force: true });
      if (!res.headersSent) send(res, 400, { error: "bad" });
    } finally {
      busy--;
      if ((sending.get(who) || 0) <= 1) sending.delete(who);
      else sending.set(who, sending.get(who) - 1);
      if (req.socket) req.socket.setTimeout(0);
    }
  }

  function fetchOne(req, res, id) {
    if (!fetches.take(visitor(req))) return send(res, 429, { error: "busy" }, { "Retry-After": "60" });
    const entry = kept.get(id);
    if (!entry || now() - entry.at >= keep) {
      if (entry) forget(id);
      return send(res, 404, { error: "gone" });
    }
    res.writeHead(200, { ...SAFE, "Content-Type": "application/octet-stream", "Content-Length": entry.size, "Cache-Control": "no-store" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(fileOf(id)).on("error", () => res.destroy()).pipe(res);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://service");
    } catch {
      return send(res, 400, { error: "bad" });
    }
    const route = url.pathname;
    const read = req.method === "GET" || req.method === "HEAD";
    try {
      if (route === "/api/s" && req.method === "POST") return void upload(req, res);
      if (route.startsWith("/api/s/") && read) {
        const id = route.slice(7);
        return ID.test(id) ? fetchOne(req, res, id) : send(res, 404, { error: "gone" });
      }
      if (read && (route === "/" || (route.startsWith("/s/") && ID.test(route.slice(3))))) {
        return send(res, 200, page, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_POLICY, "Cache-Control": "no-cache" });
      }
      // (the page's script and style are asked for anew like the page, so the three always fit)
      if (read && pages[route]) return send(res, 200, pages[route].body, { "Content-Type": pages[route].type, "Cache-Control": route === "/icon.svg" ? "public, max-age=3600" : "no-cache" });
      if (read && route === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
      return send(res, read || req.method === "POST" ? 404 : 405, { error: "none" });
    } catch (err) {
      if (!quiet) console.error("error:", err && err.message);
      if (!res.headersSent) send(res, 500, { error: "server" });
    }
  });
  // Slow senders do not hold the service: a request has 2 minutes, its head 10 seconds, and an
  // upload that stops sending goes after 10 seconds (above).
  server.requestTimeout = 120e3;
  server.headersTimeout = 10e3;
  server.keepAliveTimeout = 5e3;
  await new Promise((resolve) => server.listen(config.port, config.bind, resolve));
  const port = server.address().port;
  if (!quiet) console.log(`aced share service on ${config.bind}:${port}, files in ${config.dataDir}, kept ${config.keepDays} days, at most ${Math.round(config.maxBytes / 1048576)} MB each`);
  return {
    server,
    port,
    sweep,
    stored: () => ({ count: kept.size, total }),
    close: () => {
      clearInterval(timer);
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { start, settings, MAGIC };

if (require.main === module) {
  start().catch((err) => {
    console.error(err && err.message);
    process.exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}

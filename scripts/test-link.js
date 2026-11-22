// Links to shared exams (src/link.js) and the share service (service/server.js), without the app:
//
//   node_modules/.bin/electron scripts/test-link.js      (or plain node)
//
// The service runs here on a free port with a scratch folder. Checked: locking and unlocking,
// links as Aced reads them (and the many that it must refuse), the service's limits, and a whole
// round from the app's side: made, fetched, run out, changed, too big, a service that lies.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const link = require("../src/link");
const service = require("../service/server");
const ink = require("../src/ink");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------ locking

test("a locked file opens with its key, and with nothing else", () => {
  const bytes = crypto.randomBytes(5000);
  const { key, blob } = link.seal(bytes);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(blob.subarray(0, 4).equals(link.MAGIC));
  assert.ok(link.unseal(blob, key).equals(bytes));
  assert.ok(!blob.includes(bytes.subarray(0, 64)), "the bytes are not in the blob as they are");
  const other = link.seal(bytes).key;
  assert.throws(() => link.unseal(blob, other), { code: "linkDamaged" });
  const changed = Buffer.from(blob);
  changed[40] ^= 1;
  assert.throws(() => link.unseal(changed, key), { code: "linkDamaged" }, "one bit changed");
  assert.throws(() => link.unseal(blob.subarray(0, blob.length - 1), key), { code: "linkDamaged" }, "cut short");
  assert.throws(() => link.unseal(Buffer.concat([Buffer.from("ACD2"), blob.subarray(4)]), key), { code: "linkDamaged" }, "another kind of file");
  assert.throws(() => link.unseal(Buffer.alloc(10), key), { code: "linkDamaged" });
  assert.throws(() => link.unseal("text", key), { code: "linkDamaged" });
});

test("a key is exactly 32 bytes, written one way only", () => {
  const { key } = link.seal(Buffer.from("x"));
  assert.ok(link.keyOf(key));
  assert.equal(link.keyOf(key.slice(0, 42)), null);
  assert.equal(link.keyOf(key + "A"), null);
  // The last letter carries 4 spare bits: a different spelling of the same bytes is no key.
  const last = key[42];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const twin = key.slice(0, 42) + alphabet[(alphabet.indexOf(last) & ~15) | ((alphabet.indexOf(last) + 1) & 15)];
  if (twin !== key) assert.equal(link.keyOf(twin), null, "a second spelling");
  assert.equal(link.keyOf(key.replace(/./, "+")), null, "not base64url");
  assert.equal(link.keyOf(null), null);
  assert.equal(link.keyOf({ toString: () => key }), null);
});

// ------------------------------------------------------------ links Aced takes, and links it refuses

const HOST = "https://share.example.com";
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const KEY = link.seal(Buffer.from("x")).key;

test("the two links Aced takes", () => {
  assert.deepEqual(link.parse(`aced://s/${ID}#${KEY}`, HOST), { id: ID, key: KEY });
  assert.deepEqual(link.parse(`${HOST}/s/${ID}#${KEY}`, HOST), { id: ID, key: KEY });
  assert.deepEqual(link.parse(`  ${HOST}/s/${ID}#${KEY}\n`, HOST), { id: ID, key: KEY }, "spaces around a pasted link");
  assert.deepEqual(link.parse(`HTTPS://SHARE.EXAMPLE.COM/s/${ID}#${KEY}`, HOST), { id: ID, key: KEY }, "the address in capitals");
  assert.equal(link.linkOf(HOST, ID, KEY), `${HOST}/s/${ID}#${KEY}`);
});

test("hostile and broken links are refused", () => {
  const bad = [
    `https://evil.example.com/s/${ID}#${KEY}`, // another host
    `https://share.example.com.evil.com/s/${ID}#${KEY}`, // a host that starts the same
    `https://share.example.com@evil.com/s/${ID}#${KEY}`, // user info
    `https://evil.com/?https://share.example.com/s/${ID}#${KEY}`,
    `http://share.example.com/s/${ID}#${KEY}`, // not https
    `https://share.example.com:444/s/${ID}#${KEY}`, // another port
    `${HOST}/s/${ID}/#${KEY}`, // more path
    `${HOST}/s/${ID}/../../etc/passwd#${KEY}`,
    `${HOST}/s/../${ID}#${KEY}`,
    `${HOST}/s/${ID}?x=1#${KEY}`, // a query
    `${HOST}/x/${ID}#${KEY}`,
    `${HOST}/s/${ID}#${KEY}#more`,
    `${HOST}/s/${ID}#${KEY}A`, // key too long
    `${HOST}/s/${ID}#${KEY.slice(1)}`, // too short
    `${HOST}/s/${ID}A#${KEY}`, // id too long
    `${HOST}/s/${ID.slice(1)}#${KEY}`,
    `${HOST}/s/${ID.replace("A", "%41")}#${KEY}`, // escapes
    `${HOST}/s/${ID}`, // no key
    `${HOST}/s/${ID}#`,
    `aced://s/${ID}`,
    `aced://evil.com/s/${ID}#${KEY}`, // the app's form with a host
    `aced://s/../../${ID}#${KEY}`,
    `aced://s/${ID}/x#${KEY}`,
    `aced://s/${ID}?u=https://evil.com#${KEY}`,
    `aced:///etc/passwd#${KEY}`,
    `aced://s/${ID}#${KEY}; rm -rf ~`,
    `aced://s/${ID}#$(touch /tmp/x)`,
    `aced://s/${ID.slice(0, 21)}é#${KEY}`, // a letter outside the alphabet
    `aced://s/${ID}#${KEY.slice(0, 42)}\u0000`,
    `aced://s/${ID}\n#${KEY}`,
    `file:///s/${ID}#${KEY}`,
    `javascript:alert(1)//s/${ID}#${KEY}`,
    `aced://s/${ID}#${KEY}`.padEnd(400, "A"), // too long
    "",
    null,
    undefined,
    42,
    { toString: () => `aced://s/${ID}#${KEY}` },
  ];
  for (const text of bad) assert.equal(link.parse(text, HOST), null, `refused: ${String(text).slice(0, 80)}`);
  // Without a service, only Aced's own form is read (it is fetched from no service, see make/fetchShared).
  assert.equal(link.parse(`${HOST}/s/${ID}#${KEY}`, ""), null);
  assert.deepEqual(link.parse(`aced://s/${ID}#${KEY}`, ""), { id: ID, key: KEY });
});

test("a service's address must be plain https (or this Mac, for tests)", () => {
  assert.equal(link.originOf("https://share.example.com"), "https://share.example.com");
  assert.equal(link.originOf("https://share.example.com/"), "https://share.example.com");
  assert.equal(link.originOf("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  for (const bad of ["http://share.example.com", "https://share.example.com/path", "https://u:p@share.example.com", "https://share.example.com?x", "ftp://x", "share.example.com", "", null, "https://" + "a".repeat(300)]) {
    assert.equal(link.originOf(bad), "", `refused: ${bad}`);
  }
});

// ------------------------------------------------------------ the service

const dirs = [];
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-link-"));
  dirs.push(d);
  return d;
};
let clock = Date.now();
const now = () => clock;
async function serve(extra = {}) {
  const config = { ...service.settings({}), port: 0, dataDir: scratch(), ...extra };
  return service.start(config, { now, quiet: true });
}
const call = (port, route, { method = "GET", body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: { ...(body ? { "Content-Type": "application/octet-stream", "Content-Length": body.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

test("the service keeps a locked file and hands it back, byte for byte", async () => {
  const s = await serve();
  try {
    const { blob } = link.seal(crypto.randomBytes(20000));
    const up = await call(s.port, "/api/s", { method: "POST", body: blob });
    assert.equal(up.status, 201);
    const { id, expires } = JSON.parse(up.body);
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(expires, new Date(clock + 30 * 864e5).toISOString().slice(0, 10));
    const down = await call(s.port, `/api/s/${id}`);
    assert.equal(down.status, 200);
    assert.ok(down.body.equals(blob));
    assert.equal(down.headers["cache-control"], "no-store");
    assert.equal(down.headers["referrer-policy"], "no-referrer");
    const page = await call(s.port, `/s/${id}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.headers["content-security-policy"], /default-src 'none'; script-src 'self'/);
    assert.match(page.body.toString(), /<script src="\/page.js"/);
    assert.equal((await call(s.port, "/page.js")).status, 200);
    assert.equal((await call(s.port, "/healthz")).body.toString(), "ok");
    // Only the locked bytes are on the disk, under the id and nothing else.
    const names = fs.readdirSync(dirs[dirs.length - 1]);
    assert.deepEqual(names, [id]);
  } finally {
    await s.close();
  }
});

test("the service refuses what is no locked file, too big, or asked for wrongly", async () => {
  const s = await serve({ maxBytes: 4096 });
  try {
    const ok = link.seal(Buffer.alloc(100)).blob;
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: Buffer.from("just some text, long enough to pass the size check") })).status, 400, "no magic");
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: Buffer.from("ACD1") })).status, 400, "too small");
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: link.seal(Buffer.alloc(5000)).blob })).status, 413, "too big");
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: ok, headers: { "Content-Type": "text/plain" } })).status, 415, "another type");
    assert.equal((await call(s.port, "/api/s", { method: "PUT", body: ok })).status, 405);
    // Without a length, sent in chunks: the limit holds while it comes in.
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.port, path: "/api/s", method: "POST", headers: { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve("closed"));
      req.write(Buffer.concat([Buffer.from("ACD1"), Buffer.alloc(3000)]));
      setTimeout(() => {
        req.write(Buffer.alloc(3000));
        req.end();
      }, 30);
    });
    assert.ok(chunked === 413 || chunked === "closed", `chunked over the limit: ${chunked}`);
    for (const route of ["/api/s/short", "/api/s/../../etc/passwd", "/api/s/..%2F..%2Fetc%2Fpasswd", `/api/s/${ID}`, `/api/s/${ID}/x`, "/api/s/%00", "/s/../server.js", "/server.js", "/page.html", "/data", "/.part-x", "/s/" + ID + "x"]) {
      const r = await call(s.port, route);
      assert.equal(r.status, 404, `nothing at ${route}`);
      assert.ok(!r.body.toString().includes("require("), `no source at ${route}`);
    }
    assert.equal(fs.readdirSync(dirs[dirs.length - 1]).length, 0, "nothing was kept");
  } finally {
    await s.close();
  }
});

test("the service counts per visitor, and keeps files 30 days", async () => {
  const s = await serve({ uploadsPerHour: 2, fetchesPerMinute: 3, ipHeader: "x-visitor" });
  try {
    const blob = link.seal(Buffer.alloc(50)).blob;
    const as = (who) => ({ method: "POST", body: blob, headers: { "x-visitor": who } });
    assert.equal((await call(s.port, "/api/s", as("a"))).status, 201);
    const second = await call(s.port, "/api/s", as("a"));
    assert.equal(second.status, 201);
    const third = await call(s.port, "/api/s", as("a"));
    assert.equal(third.status, 429, "a third upload in the hour");
    assert.ok(third.headers["retry-after"]);
    assert.equal((await call(s.port, "/api/s", as("b"))).status, 201, "another visitor");
    const { id } = JSON.parse(second.body);
    for (let i = 0; i < 3; i++) assert.equal((await call(s.port, `/api/s/${id}`, { headers: { "x-visitor": "c" } })).status, 200);
    assert.equal((await call(s.port, `/api/s/${id}`, { headers: { "x-visitor": "c" } })).status, 429, "fetched too often");
    clock += 61e3;
    assert.equal((await call(s.port, `/api/s/${id}`, { headers: { "x-visitor": "c" } })).status, 200, "a minute later");
    // 30 days on, it is gone, from the disk too.
    clock += 30 * 864e5;
    assert.equal((await call(s.port, `/api/s/${id}`, { headers: { "x-visitor": "d" } })).status, 404);
    assert.equal(s.sweep() >= 1, true);
    assert.equal(s.stored().count, 0);
    assert.equal(fs.readdirSync(dirs[dirs.length - 1]).length, 0);
    clock += 3600e3;
    assert.equal((await call(s.port, "/api/s", as("a"))).status, 201, "an hour later, a again");
  } finally {
    await s.close();
  }
});

test("the service stops taking files when its space is used up", async () => {
  const s = await serve({ maxTotal: 3000, uploadsPerHour: 100 });
  try {
    const blob = link.seal(Buffer.alloc(1200)).blob;
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: blob })).status, 201);
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: blob })).status, 201);
    assert.equal((await call(s.port, "/api/s", { method: "POST", body: blob })).status, 507);
  } finally {
    await s.close();
  }
});

test("a restart finds what was kept and drops what was half written", async () => {
  const dataDir = scratch();
  const first = await service.start({ ...service.settings({}), port: 0, dataDir }, { now, quiet: true });
  const blob = link.seal(Buffer.alloc(300)).blob;
  const { id } = JSON.parse((await call(first.port, "/api/s", { method: "POST", body: blob })).body);
  await first.close();
  fs.writeFileSync(path.join(dataDir, ".part-left"), "half");
  fs.writeFileSync(path.join(dataDir, "not-an-id.txt"), "x");
  const again = await service.start({ ...service.settings({}), port: 0, dataDir }, { now, quiet: true });
  try {
    assert.ok((await call(again.port, `/api/s/${id}`)).body.equals(blob));
    assert.ok(!fs.existsSync(path.join(dataDir, ".part-left")));
    assert.equal((await call(again.port, "/api/s/not-an-id.txt")).status, 404);
  } finally {
    await again.close();
  }
});

// ------------------------------------------------------------ the app's side, against the service

test("make a link, fetch it back: the same Aced file", async () => {
  const s = await serve();
  try {
    const host = `http://127.0.0.1:${s.port}`;
    const bytes = crypto.randomBytes(100000);
    const made = await link.make(bytes, { host });
    const found = link.parse(made.url, host);
    assert.ok(found, made.url);
    assert.ok((await link.fetchShared(found, { host })).equals(bytes));
    // The key never reached the service: only the locked bytes are there.
    const kept = fs.readFileSync(path.join(dirs[dirs.length - 1], found.id));
    assert.ok(!kept.includes(Buffer.from(found.key)) && !kept.includes(Buffer.from(found.key, "base64url")));
    // A changed key, a link that never was, one that has run out.
    const wrong = link.seal(Buffer.from("x")).key;
    await assert.rejects(link.fetchShared({ id: found.id, key: wrong }, { host }), { code: "linkDamaged" });
    await assert.rejects(link.fetchShared({ id: ID, key: found.key }, { host }), { code: "linkGone" });
    clock += 31 * 864e5;
    await assert.rejects(link.fetchShared(found, { host }), { code: "linkGone" });
    await assert.rejects(link.fetchShared({ id: "../../etc/passwd", key: found.key }, { host }), { code: "linkDamaged" });
  } finally {
    await s.close();
  }
});

test("what the app says when the service cannot help", async () => {
  await assert.rejects(link.make(Buffer.alloc(10), { host: "" }), { code: "linkOff" });
  await assert.rejects(link.make(Buffer.alloc(link.MAX + 1), { host: HOST }), { code: "linkTooBig" });
  // nobody listening
  const closed = await serve();
  const host = `http://127.0.0.1:${closed.port}`;
  await closed.close();
  await assert.rejects(link.make(Buffer.alloc(10), { host }), { code: "linkServer" });
  await assert.rejects(link.fetchShared({ id: ID, key: KEY }, { host }), { code: "linkOffline" });
  // a service that says no, or answers nonsense, or sends far too much
  const liar = http.createServer((req, res) => {
    if (req.url === "/api/s") {
      req.resume();
      const answers = { busy: [429, "{}"], large: [413, "{}"], nonsense: [201, "{\"id\":\"../../x\"}"], broken: [500, "oops"] };
      const [status, body] = answers[liar.mode];
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(body);
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    // more than any link holds, without saying so up front
    let sent = 0;
    const more = () => {
      while (sent < link.MAX + 2e6) {
        sent += 65536;
        if (!res.write(Buffer.alloc(65536, 1))) return res.once("drain", more);
      }
      res.end();
    };
    more();
  });
  await new Promise((r) => liar.listen(0, "127.0.0.1", r));
  const liarHost = `http://127.0.0.1:${liar.address().port}`;
  try {
    for (const [mode, code] of [["busy", "linkBusy"], ["large", "linkTooBig"], ["nonsense", "linkServer"], ["broken", "linkServer"]]) {
      liar.mode = mode;
      await assert.rejects(link.make(Buffer.alloc(10), { host: liarHost }), { code }, mode);
    }
    await assert.rejects(link.fetchShared({ id: ID, key: KEY }, { host: liarHost }), { code: "linkDamaged" }, "too much");
  } finally {
    liar.closeAllConnections?.();
    await new Promise((r) => liar.close(r));
  }
});

// ------------------------------------------------------------ what is written in a book (src/ink.js)

test("ink is kept per page, checked, and deleted with the book", () => {
  const dir = scratch();
  ink.init(dir);
  const hash = "a".repeat(64);
  const page = { s: [{ t: "pen", c: 1, w: 20, p: [10, 20, 30, 40] }, { t: "hl", c: 0, w: 150, p: [0, 0, 5000, 0] }], n: [{ x: 100, y: 200, text: "Prüfung!" }] };
  ink.save(hash, 3, page);
  assert.deepEqual(ink.load(hash), { 3: page });
  // What is not ink is not kept: other tools, colours, coordinates, scripts in a note stay text.
  ink.save(hash, 4, {
    s: [{ t: "pen", c: 9, w: 20, p: [1, 2] }, { t: "laser", c: 0, w: 20, p: [1, 2] }, { t: "pen", c: 0, w: 20, p: [1, 2, 3] }, { t: "pen", c: 0, w: 20, p: [1.5, 2] }, { t: "pen", c: 0, w: 20, p: ["1", 2] }, { t: "pen", c: 0, w: 1e9, p: [1, 2] }, { t: "pen", c: 0, w: 20, p: [1, 2], extra: "x" }],
    n: [{ x: -1, y: 0, text: "a" }, { x: 0, y: 0, text: "  " }, { x: 0, y: 0, text: "<img src=x onerror=alert(1)>" }, { x: 0, y: 0, text: "x".repeat(5000) }],
    more: "x",
  });
  const four = ink.load(hash)[4];
  assert.deepEqual(four.s, [{ t: "pen", c: 0, w: 20, p: [1, 2] }]);
  assert.deepEqual(four.n.map((n) => n.text.length), [28, 2000]);
  assert.equal(four.n[0].text, "<img src=x onerror=alert(1)>", "kept as text (it is shown as text)");
  // an empty page takes its entry away; an empty book its file
  ink.save(hash, 4, { s: [], n: [] });
  assert.deepEqual(Object.keys(ink.load(hash)), ["3"]);
  assert.throws(() => ink.save("../../x", 1, page), { code: "unknown" });
  assert.throws(() => ink.save(hash, 0, page), { code: "unknown" });
  assert.throws(() => ink.save(hash, "1", page), { code: "unknown" });
  assert.throws(() => ink.load("../aced"), { code: "unknown" });
  // a damaged file reads as no ink, and the next save writes it anew
  fs.writeFileSync(path.join(dir, "ink", `${hash}.json`), "{broken");
  assert.deepEqual(ink.load(hash), {});
  ink.save(hash, 1, page);
  assert.deepEqual(Object.keys(ink.load(hash)), ["1"]);
  const other = "b".repeat(64);
  ink.save(other, 1, page);
  ink.prune(new Set([other]));
  assert.deepEqual(ink.load(hash), {}, "pruned with its book");
  assert.deepEqual(Object.keys(ink.load(other)), ["1"]);
  ink.save(other, 1, null);
  assert.equal(fs.readdirSync(path.join(dir, "ink")).length, 0, "no file for a book without ink");
  // the sample exams keep ink in memory only
  ink.init(dir, { sample: true });
  ink.save(hash, 1, page);
  assert.deepEqual(Object.keys(ink.load(hash)), ["1"]);
  assert.equal(fs.readdirSync(path.join(dir, "ink")).length, 0);
});

// ------------------------------------------------------------ files handed to other apps (src/mac-share.js)

test("files handed to AirDrop, Messages, Mail or the clipboard are deleted after two days", async () => {
  // (src/mac-share.js asks src/ocr.js for the helper, which asks Electron: a stand-in here)
  const Module = require("module");
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? { app: { isPackaged: false } } : load.call(this, request, ...rest);
  };
  let macShare;
  try {
    macShare = require("../src/mac-share");
  } finally {
    Module._load = load;
  }
  const fresh = macShare.keptDir();
  const old = macShare.keptDir();
  dirs.push(fresh, old);
  assert.match(path.basename(fresh), /^aced-sent-/);
  fs.writeFileSync(path.join(old, "Exam.aced"), "x");
  const then = new Date(Date.now() - 3 * 864e5);
  fs.utimesSync(old, then, then);
  // a file (not a folder) and a link with the same start are left alone
  const plain = path.join(os.tmpdir(), `aced-sent-file-${process.pid}`);
  fs.writeFileSync(plain, "x");
  fs.utimesSync(plain, then, then);
  assert.ok(macShare.pruneKept() >= 1);
  assert.ok(fs.existsSync(fresh) && !fs.existsSync(old) && fs.existsSync(plain));
  fs.rmSync(plain, { force: true });
  await assert.rejects(macShare.send("printer", "/etc/hosts"), { code: "unknown" }, "only AirDrop, Messages and Mail");
});

// ------------------------------------------------------------ run

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log("ok", name);
    } catch (err) {
      failed++;
      console.log("FAIL", name, "\n ", err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n  ") : err);
    }
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

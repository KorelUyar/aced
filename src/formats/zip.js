// Reads zip archives: Word, Excel and PowerPoint files, OpenDocument files, e-books and iWork
// files are all zips. They come from anywhere, so nothing the archive says about itself is
// trusted: an entry is inflated with a hard limit on what comes out (a "zip bomb" of a few
// kilobytes that unpacks to gigabytes stops at the limit), the number of entries is capped, and
// so is everything unpacked from one archive together. Nothing is ever written to disk.
const fs = require("fs");
const zlib = require("zlib");

const LIMITS = {
  entries: 20000, // entries in one archive
  entry: 96 * 1024 * 1024, // bytes unpacked from one entry
  total: 512 * 1024 * 1024, // bytes unpacked from one archive, all entries together
};

const coded = (code) => Object.assign(new Error(code), { code });

/**
 * Opens a zip file. Returns { names, has(name), size(name), read(name) -> Buffer, text(name)
 * -> string, close() }. Throws "damaged" for anything that is not a readable zip, "protected"
 * for an encrypted one, "tooLarge" when it unpacks to more than the limits allow.
 */
function open(file, limits = LIMITS) {
  const fd = fs.openSync(file, "r");
  try {
    return openFd(fd, limits);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function openFd(fd, limits) {
  const size = fs.fstatSync(fd).size;
  const readAt = (position, length) => {
    if (position < 0 || length < 0 || position + length > size) throw coded("damaged");
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(fd, buf, done, length - done, position + done);
      if (n <= 0) throw coded("damaged");
      done += n;
    }
    return buf;
  };

  // The end of the central directory: the last 22 bytes, or up to 64 kB earlier when the archive has a comment.
  const tailLength = Math.min(size, 22 + 0xffff);
  if (tailLength < 22) throw coded("damaged");
  const tail = readAt(size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw coded("damaged");
  let count = tail.readUInt16LE(eocd + 10);
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirStart = tail.readUInt32LE(eocd + 16);
  // ZIP64: the real numbers are in another record, found through a locator just before.
  if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) {
    const at = size - tailLength + eocd - 20;
    if (at < 0) throw coded("damaged");
    const locator = readAt(at, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) throw coded("damaged");
    const record = readAt(Number(locator.readBigUInt64LE(8)), 56);
    if (record.readUInt32LE(0) !== 0x06064b50) throw coded("damaged");
    count = Number(record.readBigUInt64LE(32));
    dirSize = Number(record.readBigUInt64LE(40));
    dirStart = Number(record.readBigUInt64LE(48));
  }
  if (count > limits.entries) throw coded("tooLarge");
  if (dirStart + dirSize > size) throw coded("damaged");
  const dir = readAt(dirStart, dirSize);

  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw coded("damaged");
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    let packed = dir.readUInt32LE(p + 20);
    let unpacked = dir.readUInt32LE(p + 24);
    const nameLength = dir.readUInt16LE(p + 28);
    const extraLength = dir.readUInt16LE(p + 30);
    const commentLength = dir.readUInt16LE(p + 32);
    let offset = dir.readUInt32LE(p + 42);
    if (p + 46 + nameLength + extraLength + commentLength > dir.length) throw coded("damaged");
    const rawName = dir.subarray(p + 46, p + 46 + nameLength);
    // Bit 11: the name is UTF-8. Older tools wrote the DOS code page; for the ASCII names
    // inside office files both read the same.
    const name = (flags & 0x800 ? rawName.toString("utf8") : rawName.toString("latin1")).replace(/\\/g, "/").replace(/^\/+/, "");
    // ZIP64 sizes and offset, in the order the fields that overflowed appear.
    const extra = dir.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const big = () => {
          if (q + 8 > e + 4 + len) throw coded("damaged");
          const v = Number(extra.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (unpacked === 0xffffffff) unpacked = big();
        if (packed === 0xffffffff) packed = big();
        if (offset === 0xffffffff) offset = big();
      }
      e += 4 + len;
    }
    if (!entries.has(name) && !name.endsWith("/")) entries.set(name, { name, flags, method, packed, unpacked, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }

  let used = 0; // bytes unpacked so far, from all entries

  function read(name, most = limits.entry) {
    const entry = entries.get(name);
    if (!entry) throw coded("missing");
    if (entry.flags & 1) throw coded("protected");
    const local = readAt(entry.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw coded("damaged");
    const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (entry.packed > size) throw coded("damaged");
    const data = readAt(start, entry.packed);
    const allowed = Math.min(most, limits.total - used);
    let out;
    if (entry.method === 0) {
      if (data.length > allowed) throw coded("tooLarge");
      out = data;
    } else if (entry.method === 8) {
      try {
        // The limit holds whatever the entry claims its size to be.
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, allowed) });
      } catch (err) {
        throw coded(err && err.code === "ERR_BUFFER_TOO_LARGE" ? "tooLarge" : err instanceof RangeError ? "tooLarge" : "damaged");
      }
    } else {
      throw coded("unsupported");
    }
    used += out.length;
    if (used > limits.total) throw coded("tooLarge");
    return out;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    /** What the archive claims the entry unpacks to (only a hint: `read` never relies on it). */
    size: (name) => (entries.get(name) || {}).unpacked || 0,
    read,
    text: (name, most) => decodeXmlBytes(read(name, most)),
    find: (test) => [...entries.keys()].filter((n) => test(n)),
    close: () => fs.closeSync(fd),
  };
}

/** The text of an XML or HTML part: UTF-8 unless it starts with a UTF-16 byte order mark. */
function decodeXmlBytes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** Is this file a zip? (By its first bytes, not its name.) */
function isZip(file) {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50;
  } catch {
    return false;
  }
}

/** Joins a path inside the archive to a reference made from another part ("../media/a.png" from "word/document.xml"). */
function resolve(from, target) {
  if (/^[a-z]+:/i.test(target)) return null; // an address outside the archive: never followed
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const piece of target.replace(/^\/+/, "").split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

module.exports = { open, isZip, resolve, decodeXmlBytes, LIMITS };

// Pages, Numbers and Keynote files. They are zips (or folders) of Apple's own format: the
// content is in "IWA" files, compressed protobuf messages with no published schema. What can be
// read without Apple's apps:
// - a whole-document PDF, which files saved by older versions (and some newer ones) carry for
//   Quick Look: when it is there, it is the document exactly as it looks;
// - otherwise the text of the document, from its text storages, and the picture of its first
//   page that every file keeps as a preview. The app then says that only that much was read.
const fs = require("fs");
const path = require("path");
const zip = require("./zip");
const { esc, documentOf, picture } = require("./page");

const coded = (code) => Object.assign(new Error(code), { code });

/** The parts of an iWork file, whether it is a zip or a folder ("package"). */
function partsOf(file) {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const root = fs.realpathSync(file);
    const read = (name) => {
      const target = path.join(root, name);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return null;
      const st = fs.statSync(target);
      return st.isFile() && st.size <= 96 * 1024 * 1024 ? fs.readFileSync(target) : null;
    };
    // Older packages keep the IWA files zipped inside, in Index.zip.
    const inner = fs.existsSync(path.join(root, "Index.zip")) ? zip.open(path.join(root, "Index.zip")) : null;
    const names = [];
    const walk = (dir, prefix) => {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) walk(p, prefix + n + "/");
        else names.push(prefix + n);
      }
    };
    walk(root, "");
    return {
      names: [...names, ...(inner ? inner.names : [])],
      read: (n) => (inner && inner.has(n) ? inner.read(n) : read(n)),
      close: () => inner && inner.close(),
    };
  }
  const archive = zip.open(file);
  return { names: archive.names, read: (n) => (archive.has(n) ? archive.read(n) : null), close: () => archive.close() };
}

// ------------------------------------------------------------ IWA: Snappy-compressed protobuf

/** Snappy, as iWork frames it: chunks of [0][3-byte length][snappy block]. Output is capped. */
function unsnappy(buf, most = 64 * 1024 * 1024) {
  const out = [];
  let total = 0;
  for (let p = 0; p + 4 <= buf.length; ) {
    const type = buf[p];
    const length = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16);
    const chunk = buf.subarray(p + 4, p + 4 + length);
    p += 4 + length;
    if (type !== 0) continue;
    const block = snappyBlock(chunk, most - total);
    total += block.length;
    out.push(block);
  }
  return Buffer.concat(out);
}

function snappyBlock(src, most) {
  let p = 0;
  let size = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const b = src[p++];
    size |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  if (size < 0 || size > most) throw coded("tooLarge");
  const out = Buffer.alloc(size);
  let o = 0;
  while (p < src.length && o < size) {
    const tag = src[p++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const bytes = len - 59;
        len = 0;
        for (let i = 0; i < bytes; i++) len |= src[p++] << (8 * i);
      }
      len += 1;
      if (o + len > size || p + len > src.length) throw coded("damaged");
      src.copy(out, o, p, p + len);
      p += len;
      o += len;
      continue;
    }
    let len;
    let offset;
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[p++];
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      offset = src[p] | (src[p + 1] << 8);
      p += 2;
    } else {
      len = (tag >> 2) + 1;
      offset = src.readUInt32LE(p);
      p += 4;
    }
    if (!offset || offset > o || o + len > size) throw coded("damaged");
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset];
  }
  return out.subarray(0, o);
}

function varint(buf, at) {
  let value = 0;
  let mul = 1;
  let p = at;
  for (let i = 0; i < 10; i++) {
    if (p >= buf.length) throw coded("damaged");
    const b = buf[p++];
    value += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) return [value, p];
  }
  throw coded("damaged");
}

/** The fields of one protobuf message: [{ field, wire, value }] (value: number, or Buffer for wire type 2). */
function fields(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const [key, next] = varint(buf, p);
    p = next;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [v, n] = varint(buf, p);
      out.push({ field, wire, value: v });
      p = n;
    } else if (wire === 2) {
      const [len, n] = varint(buf, p);
      if (n + len > buf.length) throw coded("damaged");
      out.push({ field, wire, value: buf.subarray(n, n + len) });
      p = n + len;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else throw coded("damaged");
  }
  return out;
}

/** The messages of one IWA file: [{ type, data }]. */
function messages(iwa) {
  const data = unsnappy(iwa);
  const out = [];
  let p = 0;
  while (p < data.length) {
    const [len, next] = varint(data, p);
    const info = fields(data.subarray(next, next + len));
    p = next + len;
    for (const mi of info.filter((f) => f.field === 2 && f.wire === 2)) {
      const m = fields(mi.value);
      const type = (m.find((f) => f.field === 1) || {}).value;
      const length = (m.find((f) => f.field === 3) || {}).value || 0;
      out.push({ type, data: data.subarray(p, p + length) });
      p += length;
    }
  }
  return out;
}

// Message types of Apple's text and table storage.
const STORAGE = 2001; // TSWP.StorageArchive: field 1 its kind, field 3 its text
const DATALIST = 6005; // TST.TableDataList: the strings of a table (field 3: entries, each with its string in field 3)
const KIND = { 0: "body", 1: "header", 2: "footnote", 3: "textbox", 4: "note", 5: "cell", 6: "other", 7: "cell" };

/** The text of an iWork document: its storages in file order, body text first. */
function textOf(parts, app) {
  const iwas = parts.names.filter((n) => /\.iwa$/i.test(n) && !/Metadata|AnnotationAuthor|CalculationEngine|DocumentStylesheet|ViewState/i.test(n));
  // Keynote keeps one file per slide; Pages keeps its text in Document.iwa.
  const order = (n) => (/Document\.iwa$/.test(n) ? 0 : /Slide/i.test(n) ? 1 : 2);
  iwas.sort((a, b) => order(a) - order(b) || a.localeCompare(b, undefined, { numeric: true }));
  const blocks = [];
  let chars = 0;
  for (const name of iwas) {
    let msgs;
    try {
      msgs = messages(parts.read(name) || Buffer.alloc(0));
    } catch {
      continue;
    }
    for (const m of msgs) {
      if (chars > 3000000) break;
      if (m.type === STORAGE) {
        const f = fields(m.data);
        const kind = KIND[(f.find((x) => x.field === 1) || {}).value] || "body";
        const text = f.filter((x) => x.field === 3 && x.wire === 2).map((x) => x.value.toString("utf8")).join("");
        if (text.trim() && kind !== "header") {
          blocks.push({ kind, text, file: name });
          chars += text.length;
        }
      } else if (m.type === DATALIST && app === "numbers") {
        const f = fields(m.data);
        for (const entry of f.filter((x) => x.field === 3 && x.wire === 2)) {
          const s = fields(entry.value).find((x) => x.field === 3 && x.wire === 2);
          if (s && s.value.length) blocks.push({ kind: "cell", text: s.value.toString("utf8"), file: name });
        }
      }
    }
  }
  return blocks;
}

/**
 * Returns { pdf: Buffer } when the file carries a PDF of the whole document, else { html,
 * partial: true } with the text and the preview of the first page.
 */
function convert(file, ext) {
  const parts = partsOf(file);
  try {
    const pdfName = parts.names.find((n) => /^QuickLook\/Preview\.pdf$/i.test(n)) || parts.names.find((n) => /(^|\/)preview\.pdf$/i.test(n));
    if (pdfName) {
      const pdf = parts.read(pdfName);
      if (pdf && pdf.subarray(0, 5).toString("latin1") === "%PDF-") return { pdf };
    }
    const app = ext === "numbers" ? "numbers" : ext === "key" ? "keynote" : "pages";
    const blocks = textOf(parts, app);
    const previewName = ["preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg", "preview-micro.jpg"].find((n) => parts.names.includes(n));
    const preview = previewName ? parts.read(previewName) : null;
    if (!blocks.length && !preview) throw coded("unsupported");
    const clean = (t) => esc(t.replace(/\uFFFC/g, "").replace(/\u2028/g, "\n")).replace(/[\u2029\n]/g, "<br>");
    let body = "";
    if (preview) body += `<section>${picture(preview, "preview.jpg", "", "display:block;margin:0 auto;max-height:250mm") || ""}</section>`;
    if (blocks.length) {
      const text =
        app === "numbers"
          ? `<p>${blocks.map((b) => clean(b.text)).join(" · ")}</p>`
          : blocks.map((b) => `<p${b.kind === "footnote" ? ' style="font-size:9pt"' : ""}>${clean(b.text)}</p>`).join("");
      body += `<section${preview ? ' class="break"' : ""}>${text}</section>`;
    }
    return { html: documentOf({ body }), partial: true };
  } finally {
    parts.close();
  }
}

module.exports = { convert, unsnappy, messages, fields, textOf };

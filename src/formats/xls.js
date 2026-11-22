// Old Excel workbooks (.xls, Excel 97 to 2003; Excel 5 and 95 as far as their text goes).
// They are "compound files", a small file system inside the file, holding a stream of records.
// Every number read from the file is checked against the file's own size before it is used:
// a damaged or hostile file ends in "damaged", never in a loop or an out-of-memory crash.
const fs = require("fs");
const { formatNumber, general, BUILTIN, LIMITS } = require("./sheet");

const coded = (code) => Object.assign(new Error(code), { code });
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** Opens a compound file. Returns { stream(name) -> Buffer | null, names }. */
function compound(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) throw coded("damaged");
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  if (sectorSize !== 512 && sectorSize !== 4096) throw coded("damaged");
  const fatCount = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const cutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  const miniFatCount = buf.readUInt32LE(64);
  let difatNext = buf.readUInt32LE(68);
  const sectors = Math.floor((buf.length - sectorSize) / sectorSize) + 1;
  const offset = (s) => (s + 1) * sectorSize;
  const sector = (s) => {
    if (s >= sectors) throw coded("damaged");
    return buf.subarray(offset(s), offset(s) + sectorSize);
  };

  // Where the FAT is: 109 places in the header, the rest in a chain of DIFAT sectors.
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== FREESECT) fatSectors.push(s);
  }
  for (let guard = 0; difatNext !== ENDOFCHAIN && difatNext !== FREESECT && fatSectors.length < fatCount; guard++) {
    if (guard > sectors) throw coded("damaged");
    const d = sector(difatNext);
    for (let i = 0; i < sectorSize / 4 - 1 && fatSectors.length < fatCount; i++) fatSectors.push(d.readUInt32LE(i * 4));
    difatNext = d.readUInt32LE(sectorSize - 4);
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((s, i) => {
    const d = sector(s);
    for (let k = 0; k < sectorSize / 4; k++) fat[i * (sectorSize / 4) + k] = d.readUInt32LE(k * 4);
  });

  const chain = (start, table = fat, limit = sectors) => {
    const out = [];
    for (let s = start; s !== ENDOFCHAIN && s !== FREESECT; s = table[s]) {
      if (s >= table.length || out.length > limit) throw coded("damaged");
      out.push(s);
    }
    return out;
  };
  const readChain = (start, size) => {
    const parts = chain(start).map(sector);
    const all = Buffer.concat(parts);
    return size === undefined ? all : all.subarray(0, Math.min(size, all.length));
  };

  // The directory: 128-byte entries.
  const dir = readChain(firstDir);
  const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLength = Math.min(64, dir.readUInt16LE(p + 64));
    const type = dir[p + 66];
    if (!type) continue;
    entries.push({
      name: dir.subarray(p, p + Math.max(0, nameLength - 2)).toString("utf16le"),
      type,
      start: dir.readUInt32LE(p + 116),
      size: Number(dir.readBigUInt64LE(p + 120) & 0xffffffffn),
    });
  }
  const root = entries.find((e) => e.type === 5);
  // Small streams live in the "mini stream", in 64-byte pieces of their own table.
  let miniStream = null;
  let miniFat = null;
  const mini = () => {
    if (miniStream) return;
    miniStream = root ? readChain(root.start, root.size) : Buffer.alloc(0);
    const mf = firstMiniFat !== ENDOFCHAIN && miniFatCount ? readChain(firstMiniFat) : Buffer.alloc(0);
    miniFat = new Uint32Array(mf.length / 4);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mf.readUInt32LE(i * 4);
  };
  return {
    names: entries.map((e) => e.name),
    stream(name) {
      const e = entries.find((x) => x.type === 2 && x.name.toLowerCase() === name.toLowerCase());
      if (!e) return null;
      if (e.size < cutoff) {
        mini();
        const parts = chain(e.start, miniFat, miniFat.length).map((s) => {
          if ((s + 1) * miniSize > miniStream.length) throw coded("damaged");
          return miniStream.subarray(s * miniSize, (s + 1) * miniSize);
        });
        return Buffer.concat(parts).subarray(0, e.size);
      }
      return readChain(e.start, e.size);
    },
  };
}

/** The value an RK record holds: a 30-bit integer or the top of a double, perhaps divided by 100. */
function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(v & 0xfffffffc, 4);
    n = b.readDoubleLE(0);
  }
  return v & 1 ? n / 100 : n;
}

function convert(file) {
  const size = fs.statSync(file).size;
  if (size > 200 * 1024 * 1024) throw coded("tooLarge");
  const cf = compound(fs.readFileSync(file));
  const data = cf.stream("Workbook") || cf.stream("Book");
  if (!data) throw coded("damaged");

  // All records, with CONTINUE records kept apart (a string can run on into one).
  const records = [];
  for (let p = 0; p + 4 <= data.length; ) {
    const type = data.readUInt16LE(p);
    const length = data.readUInt16LE(p + 2);
    if (p + 4 + length > data.length) break;
    records.push({ type, at: p, body: data.subarray(p + 4, p + 4 + length) });
    p += 4 + length;
  }

  let biff8 = true;
  let date1904 = false;
  const sst = [];
  const formats = new Map();
  const xfFormat = [];
  const sheets = [];
  let index = 0;

  /** Reads a string that may continue in the following CONTINUE records. */
  function unicodeString(recIndex, offset, cch, flagsAt = offset) {
    let rec = records[recIndex];
    let p = flagsAt;
    let flags = rec.body[p++];
    let rich = 0;
    let ext = 0;
    if (flags & 0x08) {
      rich = rec.body.readUInt16LE(p);
      p += 2;
    }
    if (flags & 0x04) {
      ext = rec.body.readUInt32LE(p);
      p += 4;
    }
    let text = "";
    let left = cch;
    for (;;) {
      const wide = flags & 0x01;
      const can = Math.min(left, Math.floor((rec.body.length - p) / (wide ? 2 : 1)));
      text += wide ? rec.body.subarray(p, p + can * 2).toString("utf16le") : rec.body.subarray(p, p + can).toString("latin1");
      p += can * (wide ? 2 : 1);
      left -= can;
      if (left <= 0) break;
      // The characters go on in the next CONTINUE record, which starts with its own flags byte.
      recIndex++;
      rec = records[recIndex];
      if (!rec || rec.type !== 0x003c) break;
      p = 0;
      flags = rec.body[p++];
    }
    // Formatting runs and phonetic data after the characters: skipped, across records if need be.
    let skip = rich * 4 + ext;
    while (skip > 0 && rec) {
      const here = Math.min(skip, rec.body.length - p);
      p += here;
      skip -= here;
      if (skip > 0) {
        recIndex++;
        rec = records[recIndex];
        if (!rec || rec.type !== 0x003c) break;
        p = 0;
      }
    }
    return { text, recIndex, offset: p };
  }

  const shortName = (body, at) => {
    const cch = body[at];
    if (!biff8) return body.subarray(at + 1, at + 1 + cch).toString("latin1");
    const wide = body[at + 1] & 1;
    return wide ? body.subarray(at + 2, at + 2 + cch * 2).toString("utf16le") : body.subarray(at + 2, at + 2 + cch).toString("latin1");
  };
  const longString = (body, at) => {
    const cch = body.readUInt16LE(at);
    if (!biff8) return body.subarray(at + 2, at + 2 + cch).toString("latin1");
    const wide = body[at + 2] & 1;
    const rich = body[at + 2] & 0x08 ? 2 : 0;
    const ext = body[at + 2] & 0x04 ? 4 : 0;
    const start = at + 3 + rich + ext;
    return wide ? body.subarray(start, start + cch * 2).toString("utf16le") : body.subarray(start, start + cch).toString("latin1");
  };

  // The workbook part: settings, strings, formats, and where the sheets are.
  for (; index < records.length; index++) {
    const { type, body } = records[index];
    if (type === 0x0809 && index === 0) biff8 = body.readUInt16LE(0) === 0x0600;
    else if (type === 0x002f) throw coded("protected");
    else if (type === 0x0022) date1904 = body.readUInt16LE(0) === 1;
    else if (type === 0x041e || type === 0x001e) formats.set(body.readUInt16LE(0), biff8 ? longString(body, 2) : body.subarray(3, 3 + body[2]).toString("latin1"));
    else if (type === 0x00e0) xfFormat.push(body.readUInt16LE(2));
    else if (type === 0x0085) {
      sheets.push({ pos: body.readUInt32LE(0), hidden: body[4] !== 0, kind: body[5], name: shortName(body, 6) });
    } else if (type === 0x00fc) {
      const unique = body.readUInt32LE(4);
      let at = 8;
      let ri = index;
      for (let i = 0; i < unique && i < 2000000; i++) {
        let rec = records[ri];
        if (at >= rec.body.length) {
          ri++;
          rec = records[ri];
          if (!rec || rec.type !== 0x003c) break;
          at = 0;
        }
        const cch = rec.body.readUInt16LE(at);
        const read = unicodeString(ri, at + 2, cch, at + 2);
        sst.push(read.text);
        ri = read.recIndex;
        at = read.offset;
      }
    } else if (type === 0x000a) break;
  }

  const fmtOf = (ixfe) => {
    const id = xfFormat[ixfe] ?? 0;
    return formats.get(id) || BUILTIN[id] || "General";
  };

  const out = [];
  for (const sheet of sheets) {
    if (sheet.hidden || sheet.kind !== 0) continue;
    const at = records.findIndex((r) => r.at === sheet.pos);
    if (at < 0) continue;
    const rows = [];
    let totalRows = 0;
    let totalCols = 0;
    const put = (r, c, v) => {
      if (r >= LIMITS.rows || c >= LIMITS.cols * 4) return;
      (rows[r] = rows[r] || [])[c] = v;
    };
    let pendingFormula = null;
    for (let i = at + 1; i < records.length; i++) {
      const { type, body } = records[i];
      if (type === 0x000a) break;
      try {
        switch (type) {
          case 0x0200:
            totalRows = biff8 ? body.readUInt32LE(4) : body.readUInt16LE(2);
            totalCols = biff8 ? body.readUInt16LE(10) : body.readUInt16LE(6);
            break;
          case 0x00fd:
            put(body.readUInt16LE(0), body.readUInt16LE(2), sst[body.readUInt32LE(6)] ?? "");
            break;
          case 0x0204:
          case 0x00d6:
            put(body.readUInt16LE(0), body.readUInt16LE(2), longString(body, 6));
            break;
          case 0x0203:
            put(body.readUInt16LE(0), body.readUInt16LE(2), formatNumber(body.readDoubleLE(6), fmtOf(body.readUInt16LE(4)), date1904));
            break;
          case 0x027e:
            put(body.readUInt16LE(0), body.readUInt16LE(2), formatNumber(rk(body.readUInt32LE(6)), fmtOf(body.readUInt16LE(4)), date1904));
            break;
          case 0x00bd: {
            const r = body.readUInt16LE(0);
            const first = body.readUInt16LE(2);
            for (let k = 0; 4 + k * 6 + 6 <= body.length - 2; k++) put(r, first + k, formatNumber(rk(body.readUInt32LE(4 + k * 6 + 2)), fmtOf(body.readUInt16LE(4 + k * 6)), date1904));
            break;
          }
          case 0x0205:
            put(body.readUInt16LE(0), body.readUInt16LE(2), body[7] ? "#ERROR" : body[6] ? "TRUE" : "FALSE");
            break;
          case 0x0006: {
            const r = body.readUInt16LE(0);
            const c = body.readUInt16LE(2);
            if (body.readUInt16LE(12) === 0xffff) {
              const kind = body[6];
              if (kind === 0) pendingFormula = [r, c];
              else if (kind === 1) put(r, c, body[8] ? "TRUE" : "FALSE");
              else if (kind === 2) put(r, c, "#ERROR");
            } else put(r, c, formatNumber(body.readDoubleLE(6), fmtOf(body.readUInt16LE(4)), date1904));
            break;
          }
          case 0x0207:
            if (pendingFormula) put(pendingFormula[0], pendingFormula[1], longString(body, 0));
            pendingFormula = null;
            break;
          default:
            break;
        }
      } catch {
        // one damaged record: the cell stays empty
      }
    }
    out.push({ name: sheet.name, rows: Array.from(rows, (r) => Array.from(r || [], (v) => v ?? "")), totalRows, totalCols });
  }
  return out;
}

module.exports = { convert, compound, rk, general };

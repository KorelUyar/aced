// Word (.docx, .docm, .dotx) to a printable page: headings, paragraphs with their numbering
// ("1.", "a)", as Word counts them: worksheets number their exercises this way), lists,
// tables with merged cells, pictures, footnotes, text boxes, page breaks, and formulas (Word's
// own format, see math.js).
const X = require("./xml");
const zip = require("./zip");
const M = require("./math");
const { esc, documentOf, picture } = require("./page");

const REL_DOC = /officeDocument$/;

function relsOf(archive, part) {
  const relsPath = part.replace(/([^/]+)$/, "_rels/$1.rels");
  const map = new Map();
  if (!archive.has(relsPath)) return map;
  for (const r of X.all(X.parse(archive.text(relsPath)), "Relationship")) {
    const id = X.attr(r, "Id");
    const target = X.attr(r, "Target") || "";
    const external = X.attr(r, "TargetMode") === "External";
    map.set(id, { type: X.attr(r, "Type") || "", target: external ? null : zip.resolve(part, safeDecode(target)), external });
  }
  return map;
}
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The main part of an Office file, through its package relationships. */
function mainPart(archive, fallback) {
  if (archive.has("_rels/.rels")) {
    for (const r of X.all(X.parse(archive.text("_rels/.rels")), "Relationship")) {
      if (REL_DOC.test(X.attr(r, "Type") || "")) {
        const target = zip.resolve("", safeDecode(X.attr(r, "Target") || ""));
        if (target && archive.has(target)) return target;
      }
    }
  }
  return fallback;
}

// ------------------------------------------------------------ numbering ("1.", "a)", "•")

const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
const roman = (n) => ROMAN.reduce((out, [v, s]) => {
  while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
}, "");
const letters = (n) => {
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
function formatNumber(n, fmt) {
  switch (fmt) {
    case "lowerLetter":
      return letters(n);
    case "upperLetter":
      return letters(n).toUpperCase();
    case "lowerRoman":
      return roman(n);
    case "upperRoman":
      return roman(n).toUpperCase();
    case "decimalZero":
      return String(n).padStart(2, "0");
    case "none":
      return "";
    default:
      return String(n);
  }
}
// Bullets in Word are characters of symbol fonts, in the private area of Unicode.
const bulletOf = (text) => {
  const ch = String(text || "").trim();
  if (!ch) return "•";
  const code = ch.codePointAt(0);
  if (code >= 0xf000 && code <= 0xf0ff) return { 0xb7: "•", 0xa7: "▪", 0xd8: "➢", 0xfc: "✓", 0x76: "❖", 0x6f: "◦", 0x71: "▫" }[code - 0xf000] || "•";
  return ch === "o" ? "◦" : ch;
};

function numberingOf(archive, rels) {
  const rel = [...rels.values()].find((r) => /numbering$/.test(r.type));
  const abstract = new Map();
  const nums = new Map();
  if (!rel || !rel.target || !archive.has(rel.target)) return { label: () => null };
  const root = X.parse(archive.text(rel.target));
  const levelsOf = (node) => {
    const out = {};
    for (const lvl of X.kids(node, "lvl")) {
      const i = Number(X.attr(lvl, "ilvl") || 0);
      out[i] = {
        start: Number(X.attr(X.kid(lvl, "start"), "val") ?? 1),
        fmt: X.attr(X.kid(lvl, "numFmt"), "val") || "decimal",
        text: X.attr(X.kid(lvl, "lvlText"), "val") ?? `%${i + 1}.`,
      };
    }
    return out;
  };
  for (const a of X.kids(root, "abstractNum")) abstract.set(X.attr(a, "abstractNumId"), levelsOf(a));
  for (const n of X.kids(root, "num")) {
    const id = X.attr(n, "numId");
    const base = abstract.get(X.attr(X.kid(n, "abstractNumId"), "val")) || {};
    const levels = structuredClone(base);
    for (const o of X.kids(n, "lvlOverride")) {
      const i = Number(X.attr(o, "ilvl") || 0);
      const own = levelsOf(o)[i];
      if (own) levels[i] = { ...levels[i], ...own };
      const start = X.kid(o, "startOverride");
      if (start) levels[i] = { ...(levels[i] || { fmt: "decimal", text: `%${i + 1}.` }), start: Number(X.attr(start, "val") || 1) };
    }
    nums.set(id, levels);
  }
  const counters = new Map(); // numId -> [count per level]
  return {
    label(numId, ilvl) {
      const levels = nums.get(numId);
      if (!levels || numId === "0") return null;
      const lvl = levels[ilvl] || { start: 1, fmt: "decimal", text: `%${ilvl + 1}.` };
      const c = counters.get(numId) || [];
      c[ilvl] = c[ilvl] === undefined ? lvl.start : c[ilvl] + 1;
      for (let k = ilvl + 1; k < 9; k++) c[k] = undefined;
      counters.set(numId, c);
      if (lvl.fmt === "bullet") return { bullet: true, text: bulletOf(lvl.text) };
      const text = lvl.text.replace(/%(\d)/g, (_, d) => {
        const k = Number(d) - 1;
        const l = levels[k] || { start: 1, fmt: "decimal" };
        return formatNumber(c[k] === undefined ? l.start : c[k], l.fmt);
      });
      return { bullet: false, text };
    },
  };
}

// ------------------------------------------------------------ styles: which paragraphs are headings

function stylesOf(archive, rels) {
  const rel = [...rels.values()].find((r) => /styles$/.test(r.type));
  const map = new Map(); // styleId -> { heading: 1..6 | 0, numId, ilvl }
  if (!rel || !rel.target || !archive.has(rel.target)) return map;
  const root = X.parse(archive.text(rel.target));
  const raw = new Map();
  for (const s of X.kids(root, "style")) {
    if (X.attr(s, "type") !== "paragraph") continue;
    const id = X.attr(s, "styleId");
    const name = (X.attr(X.kid(s, "name"), "val") || "").toLowerCase();
    const pPr = X.kid(s, "pPr");
    const outline = X.attr(X.kid(pPr, "outlineLvl"), "val");
    const numPr = X.kid(pPr, "numPr");
    let heading = 0;
    const m = /^heading\s*(\d)$/.exec(name) || /^(?:berschrift|ueberschrift|überschrift|titre|titolo)\s*(\d)$/.exec(name);
    if (m) heading = Number(m[1]);
    else if (name === "title" || name === "titel") heading = 1;
    else if (outline !== undefined && Number(outline) < 6) heading = Number(outline) + 1;
    raw.set(id, { heading, basedOn: X.attr(X.kid(s, "basedOn"), "val"), numId: X.attr(X.kid(numPr, "numId"), "val"), ilvl: X.attr(X.kid(numPr, "ilvl"), "val") });
  }
  const resolve = (id, depth = 0) => {
    const s = raw.get(id);
    if (!s) return { heading: 0 };
    if (depth > 10 || !s.basedOn) return s;
    const base = resolve(s.basedOn, depth + 1);
    return { heading: s.heading || base.heading, numId: s.numId ?? base.numId, ilvl: s.ilvl ?? base.ilvl };
  };
  for (const id of raw.keys()) map.set(id, resolve(id));
  return map;
}

// ------------------------------------------------------------ the body

const on = (node) => node && !["0", "false", "off", "none"].includes(String(X.attr(node, "val") ?? "true"));
const twipsToPt = (v) => Number(v) / 20;

function convert(file) {
  const archive = zip.open(file);
  try {
    return convertArchive(archive);
  } finally {
    archive.close();
  }
}

function convertArchive(archive) {
  const part = mainPart(archive, "word/document.xml");
  if (!archive.has(part)) throw Object.assign(new Error("damaged"), { code: "damaged" });
  const rels = relsOf(archive, part);
  const numbering = numberingOf(archive, rels);
  const styles = stylesOf(archive, rels);
  const doc = X.parse(archive.text(part));
  const body = X.first(doc, "body");
  const notes = [];
  const noteNumbers = new Map();
  let missingPictures = 0;
  let pictureBytes = 0;
  let leftOut = 0;

  const footnotes = new Map();
  for (const kind of ["footnotes", "endnotes"]) {
    const rel = [...rels.values()].find((r) => r.type.endsWith("/" + kind));
    if (!rel || !rel.target || !archive.has(rel.target)) continue;
    for (const n of X.kids(X.parse(archive.text(rel.target)), kind === "footnotes" ? "footnote" : "endnote")) {
      if (["separator", "continuationSeparator", "continuationNotice"].includes(X.attr(n, "type"))) continue;
      footnotes.set(kind + ":" + X.attr(n, "id"), n);
    }
  }

  function image(rId, widthPt) {
    const rel = rels.get(rId);
    if (!rel || !rel.target || !archive.has(rel.target)) return "";
    // Pictures beyond 60 MB in one document are left out: the page would not print.
    if (pictureBytes > 60 * 1024 * 1024) {
      missingPictures++;
      return "";
    }
    let bytes;
    try {
      bytes = archive.read(rel.target, 24 * 1024 * 1024);
    } catch {
      missingPictures++;
      return "";
    }
    pictureBytes += bytes.length;
    const tag = picture(bytes, rel.target, "", widthPt ? `width:${Math.min(widthPt, 520).toFixed(1)}pt` : "");
    if (!tag) missingPictures++;
    return tag || "";
  }

  // Runs: text with its look.
  function run(r) {
    const rPr = X.kid(r, "rPr");
    let out = "";
    for (const c of X.kids(r)) {
      switch (c.local) {
        case "t":
          out += esc(X.text(c));
          break;
        case "tab":
          out += " &emsp;";
          break;
        case "br":
          out += X.attr(c, "type") === "page" ? '</p><div class="break"></div><p>' : "<br>";
          break;
        case "cr":
          out += "<br>";
          break;
        case "noBreakHyphen":
          out += "‑";
          break;
        case "softHyphen":
          break;
        case "sym": {
          const code = parseInt(X.attr(c, "char") || "", 16);
          out += code ? esc(bulletOf(String.fromCodePoint(code >= 0xf000 ? code : code + 0xf000))) : "";
          break;
        }
        case "drawing":
          out += drawing(c);
          break;
        case "pict":
        case "object": {
          const data = X.first(c, "imagedata");
          if (data) out += image(X.attr(data, "id"));
          else if (X.first(c, "txbxContent")) out += blocks(X.first(c, "txbxContent"));
          break;
        }
        case "footnoteReference":
        case "endnoteReference": {
          const key = (c.local === "footnoteReference" ? "footnotes:" : "endnotes:") + X.attr(c, "id");
          if (!noteNumbers.has(key)) {
            noteNumbers.set(key, noteNumbers.size + 1);
            notes.push(key);
          }
          out += `<sup>${noteNumbers.get(key)}</sup>`;
          break;
        }
        case "AlternateContent": {
          // A newer kind of drawing, with an older one to fall back on.
          const shape = X.first(X.kid(c, "Choice"), "drawing");
          const older = X.kid(c, "Fallback");
          out += shape ? drawing(shape) : older ? run(older) : "";
          break;
        }
        default:
          break;
      }
    }
    if (!out) return "";
    if (!rPr) return out;
    const look = [];
    const sz = X.attr(X.kid(rPr, "sz"), "val");
    if (sz && Number(sz) > 0 && Math.abs(Number(sz) - 22) > 1) look.push(`font-size:${Math.min(40, Number(sz) / 2)}pt`);
    const color = X.attr(X.kid(rPr, "color"), "val");
    if (color && /^[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== "000000") look.push(`color:#${color}`);
    if (look.length) out = `<span style="${look.join(";")}">${out}</span>`;
    const vert = X.attr(X.kid(rPr, "vertAlign"), "val");
    if (vert === "superscript") out = `<sup>${out}</sup>`;
    if (vert === "subscript") out = `<sub>${out}</sub>`;
    if (on(X.kid(rPr, "b"))) out = `<b>${out}</b>`;
    if (on(X.kid(rPr, "i"))) out = `<i>${out}</i>`;
    if (X.kid(rPr, "u") && X.attr(X.kid(rPr, "u"), "val") !== "none") out = `<u>${out}</u>`;
    if (on(X.kid(rPr, "strike")) || on(X.kid(rPr, "dstrike"))) out = `<s>${out}</s>`;
    return out;
  }

  const fallback = (alt) => {
    const f = X.kid(alt, "Fallback");
    return f ? inline(f) : "";
  };

  function drawing(d) {
    // A text box keeps its text; a picture is drawn as large as it is in the document.
    const box = X.first(d, "txbxContent");
    if (box) return `<div class="note">${blocks(box)}</div>`;
    const blip = X.first(d, "blip");
    if (!blip) return "";
    const extent = X.first(d, "extent");
    const width = extent ? Number(X.attr(extent, "cx")) / 12700 : 0;
    return image(X.attr(blip, "embed") || X.attr(blip, "link"), width > 0 ? width : 0);
  }

  /** What stands inline in a paragraph: runs, links, fields, formulas, inserted text. */
  function inline(node) {
    let out = "";
    for (const c of X.kids(node)) {
      switch (c.local) {
        case "r":
          out += run(c);
          break;
        case "oMath":
          out += M.marked(M.fromOmml(c));
          break;
        case "oMathPara":
          out += X.kids(c, "oMath").map((m) => M.marked({ ...M.fromOmml(m), a: { display: "block" } })).join("");
          break;
        case "hyperlink":
        case "fldSimple":
        case "ins":
        case "moveTo":
        case "smartTag":
        case "customXml":
        case "dir":
        case "bdo":
          out += inline(c);
          break;
        case "sdt":
          out += inline(X.kid(c, "sdtContent") || c);
          break;
        case "AlternateContent":
          out += fallback(c);
          break;
        default:
          break;
      }
    }
    return out;
  }

  function paragraph(p) {
    const pPr = X.kid(p, "pPr");
    const styleId = X.attr(X.kid(pPr, "pStyle"), "val");
    const style = styles.get(styleId) || { heading: 0 };
    const numPr = X.kid(pPr, "numPr");
    const numId = X.attr(X.kid(numPr, "numId"), "val") ?? style.numId;
    const ilvl = Number(X.attr(X.kid(numPr, "ilvl"), "val") ?? style.ilvl ?? 0);
    const outline = X.attr(X.kid(pPr, "outlineLvl"), "val");
    const heading = style.heading || (outline !== undefined && Number(outline) < 6 ? Number(outline) + 1 : 0);
    let content = inline(p);
    const label = numId ? numbering.label(numId, ilvl) : null;
    const css = [];
    const jc = X.attr(X.kid(pPr, "jc"), "val");
    if (jc === "center") css.push("text-align:center");
    if (jc === "right" || jc === "end") css.push("text-align:right");
    if (jc === "both") css.push("text-align:justify");
    const ind = X.kid(pPr, "ind");
    const left = Number(X.attr(ind, "left") ?? X.attr(ind, "start") ?? 0);
    const indent = label ? Math.max(left, 360 * (ilvl + 1)) : left;
    if (indent > 0 && !heading) css.push(`margin-left:${Math.min(200, twipsToPt(indent))}pt`);
    if (label && label.text) {
      // The number stands in front, as Word shows it; the text after it keeps its own line.
      content = `<span class="label">${esc(label.text)}</span>&nbsp; ${content}`;
      if (!heading) css.push(`text-indent:-${label.bullet ? 11 : 16}pt`);
    }
    const before = on(X.kid(pPr, "pageBreakBefore")) ? '<div class="break"></div>' : "";
    const sect = X.kid(pPr, "sectPr");
    const after = sect && ["nextPage", "oddPage", "evenPage", undefined].includes(X.attr(X.kid(sect, "type"), "val")) ? '<div class="break"></div>' : "";
    if (!content.trim()) return before + (heading ? "" : "<p>&nbsp;</p>") + after;
    const tag = heading ? `h${Math.min(6, heading)}` : "p";
    return `${before}<${tag}${css.length ? ` style="${css.join(";")}"` : ""}>${content}</${tag}>${after}`;
  }

  function table(tbl) {
    const rows = X.kids(tbl, "tr");
    // Cells merged downwards: Word marks the first with "restart", the ones below with "continue".
    const grid = rows.map((tr) => {
      let col = 0;
      return X.kids(tr, ["tc", "sdt"]).flatMap((tc) => (tc.local === "sdt" ? X.kids(X.kid(tc, "sdtContent"), "tc") : [tc])).map((tc) => {
        const tcPr = X.kid(tc, "tcPr");
        const span = Number(X.attr(X.kid(tcPr, "gridSpan"), "val") || 1);
        const vMerge = X.kid(tcPr, "vMerge");
        const cell = { tc, col, span, merge: vMerge ? X.attr(vMerge, "val") || "continue" : null, rows: 1 };
        col += span;
        return cell;
      });
    });
    grid.forEach((row, r) => {
      for (const cell of row) {
        if (cell.merge !== "restart") continue;
        for (let k = r + 1; k < grid.length; k++) {
          const below = grid[k].find((c) => c.col === cell.col);
          if (!below || below.merge !== "continue") break;
          cell.rows++;
          below.hidden = true;
        }
      }
    });
    const body = grid
      .map((row) => `<tr>${row.filter((c) => !c.hidden).map((c) => `<td${c.span > 1 ? ` colspan="${c.span}"` : ""}${c.rows > 1 ? ` rowspan="${c.rows}"` : ""}>${blocks(c.tc)}</td>`).join("")}</tr>`)
      .join("");
    return `<table>${body}</table>`;
  }

  /**
   * A part of the document kept in another format (an "altChunk", which other programs write
   * when they paste into Word): a web page or plain text is put in; anything else (RTF, another
   * Word file) is counted, and the app says that part of the document was left out.
   */
  function altChunk(node) {
    const rel = rels.get(X.attr(node, "id"));
    if (!rel || !rel.target || !archive.has(rel.target)) {
      leftOut++;
      return "";
    }
    let bytes;
    try {
      bytes = archive.read(rel.target, 8 * 1024 * 1024);
    } catch {
      leftOut++;
      return "";
    }
    const text = bytes.toString("utf8");
    if (/\.html?$/i.test(rel.target) || /^\s*(<!doctype html|<html|<body|<p[\s>]|<div[\s>])/i.test(text)) {
      // Its body only; the page that prints it runs no script and loads nothing.
      const body = /<body[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(text);
      // (A picture it points to elsewhere would not load anyway: it is left out, not shown as a broken one.)
      const html = (body ? body[1] : text).replace(/<\/?(script|style|link|meta|iframe|object|embed)\b[^>]*>/gi, "").replace(/<img\b(?![^>]*\bsrc\s*=\s*["']?data:)[^>]*>/gi, "");
      return `<div class="alt-chunk">${html}</div>`;
    }
    if (/\.txt$/i.test(rel.target)) return `<pre style="font:inherit;white-space:pre-wrap">${esc(text)}</pre>`;
    leftOut++;
    return "";
  }

  function blocks(node) {
    let out = "";
    for (const c of X.kids(node)) {
      if (c.local === "p") out += paragraph(c);
      else if (c.local === "tbl") out += table(c);
      else if (c.local === "sdt") out += blocks(X.kid(c, "sdtContent") || c);
      else if (c.local === "customXml" || c.local === "ins" || c.local === "moveTo") out += blocks(c);
      else if (c.local === "altChunk") out += altChunk(c);
      else if (c.local === "oMathPara") out += X.kids(c, "oMath").map((m) => M.marked({ ...M.fromOmml(m), a: { display: "block" } })).join("");
      else if (c.local === "AlternateContent") out += blocks(X.kid(c, "Fallback") || c);
    }
    return out;
  }

  let html = blocks(body);
  // Footnotes and endnotes, numbered as they were referred to, at the end.
  if (notes.length) {
    html += `<hr><ol class="footnotes" style="font-size:9pt">${notes.map((key) => `<li>${blocks(footnotes.get(key) || { children: [] })}</li>`).join("")}</ol>`;
  }
  // The page as the document sets it up: its size, its orientation and its margins.
  const sect = X.kid(body, "sectPr");
  const pgSz = X.kid(sect, "pgSz");
  const pgMar = X.kid(sect, "pgMar");
  let size = "A4";
  let margin;
  const w = Number(X.attr(pgSz, "w"));
  const h = Number(X.attr(pgSz, "h"));
  if (w > 2000 && h > 2000 && w < 40000 && h < 40000) size = `${(w / 1440).toFixed(2)}in ${(h / 1440).toFixed(2)}in`;
  if (pgMar) {
    const m = ["top", "right", "bottom", "left"].map((k) => Math.max(0.25, Math.min(2, Number(X.attr(pgMar, k) || 1134) / 1440)).toFixed(2) + "in");
    margin = m.join(" ");
  }
  return { html: documentOf({ body: html, size, margin, css: ".label{font-weight:inherit}" }), missingPictures, leftOut };
}

module.exports = { convert, convertArchive, relsOf, mainPart };

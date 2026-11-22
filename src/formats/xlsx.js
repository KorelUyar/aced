// Excel workbooks (.xlsx, .xlsm, .xltx) to sheets of text, each cell as Excel shows it.
const X = require("./xml");
const zip = require("./zip");
const { relsOf, mainPart } = require("./docx");
const { formatNumber, general, BUILTIN, LIMITS } = require("./sheet");

const coded = (code) => Object.assign(new Error(code), { code });

/** Column number (0-based) from a cell reference ("C12" -> 2). */
const colOf = (ref) => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref || "")?.[0].toUpperCase() || "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/**
 * A worksheet's XML, cut after `rows` rows: a sheet of a million rows is not read whole to
 * print its first thousand. (Rows come in order in the file.)
 */
function firstRows(xml, rows) {
  let at = 0;
  for (let i = 0; i < rows; i++) {
    const next = xml.indexOf("</row>", at);
    if (next < 0) return { xml, more: false };
    at = next + 6;
  }
  const more = xml.indexOf("<row", at) >= 0 || /<[a-z]+:row[\s>]/.test(xml.slice(at, at + 2000));
  return more ? { xml: xml.slice(0, at) + "</sheetData></worksheet>", more } : { xml, more };
}

function convert(file) {
  const archive = zip.open(file);
  try {
    return read(archive);
  } finally {
    archive.close();
  }
}

function read(archive) {
  const book = mainPart(archive, "xl/workbook.xml");
  if (!archive.has(book)) throw coded("damaged");
  const rels = relsOf(archive, book);
  const wb = X.parse(archive.text(book));
  const date1904 = ["1", "true"].includes(X.attr(X.first(wb, "workbookPr"), "date1904"));

  const strings = [];
  const sharedRel = [...rels.values()].find((r) => /sharedStrings$/.test(r.type));
  if (sharedRel && sharedRel.target && archive.has(sharedRel.target)) {
    for (const si of X.kids(X.parse(archive.text(sharedRel.target)), "si")) {
      // Rich text keeps its runs' text; the phonetic guide (rPh) is not part of the value.
      strings.push(X.kids(si).filter((k) => k.local !== "rPh").map((k) => (k.local === "t" ? X.text(k) : k.local === "r" ? X.text(X.kid(k, "t")) : "")).join(""));
    }
  }

  const formats = []; // style index -> number format code
  const stylesRel = [...rels.values()].find((r) => /styles$/.test(r.type));
  if (stylesRel && stylesRel.target && archive.has(stylesRel.target)) {
    const st = X.parse(archive.text(stylesRel.target));
    const custom = new Map(X.all(X.kid(st, "numFmts"), "numFmt").map((f) => [X.attr(f, "numFmtId"), X.attr(f, "formatCode")]));
    for (const xf of X.kids(X.kid(st, "cellXfs"), "xf")) {
      const id = X.attr(xf, "numFmtId") || "0";
      formats.push(custom.get(id) || BUILTIN[id] || "General");
    }
  }

  const sheets = [];
  for (const s of X.all(X.kid(wb, "sheets"), "sheet")) {
    if (["hidden", "veryHidden"].includes(X.attr(s, "state"))) continue;
    const rel = rels.get(X.attr(s, "id"));
    if (!rel || !rel.target || !archive.has(rel.target) || !/worksheet$/.test(rel.type)) continue;
    const { xml, more } = firstRows(archive.text(rel.target), LIMITS.rows);
    const ws = X.parse(xml);
    const dim = X.attr(X.first(ws, "dimension"), "ref") || "";
    const [, end = ""] = dim.split(":");
    const rows = [];
    let next = 0;
    for (const r of X.kids(X.first(ws, "sheetData"), "row")) {
      const index = Number(X.attr(r, "r")) ? Number(X.attr(r, "r")) - 1 : next;
      next = index + 1;
      if (index >= LIMITS.rows) break;
      const cells = [];
      let col = 0;
      for (const c of X.kids(r, "c")) {
        const ref = X.attr(c, "r");
        col = ref ? colOf(ref) : col;
        if (col < 0 || col >= LIMITS.cols * 4) {
          col++;
          continue;
        }
        const type = X.attr(c, "t") || "n";
        const v = X.text(X.kid(c, "v"));
        const f = X.text(X.kid(c, "f"));
        let shown = "";
        if (type === "s") shown = strings[Number(v)] ?? "";
        else if (type === "inlineStr") shown = X.text(X.kid(c, "is"));
        else if (type === "str") shown = v;
        else if (type === "b") shown = v === "1" ? "TRUE" : "FALSE";
        else if (type === "e") shown = v;
        else if (type === "d") shown = v.replace("T", " ").replace(/\.\d+Z?$|Z$/, "");
        else if (v !== "") shown = formatNumber(Number(v), formats[Number(X.attr(c, "s") || 0)] || "General", date1904);
        // A formula whose result was never saved (a file written by a program, not by Excel): the formula itself.
        if (shown === "" && f) shown = "=" + f;
        cells[col] = shown;
        col++;
      }
      rows[index] = cells;
    }
    sheets.push({
      name: X.attr(s, "name") || `Sheet ${sheets.length + 1}`,
      rows: Array.from(rows, (r) => r || []),
      totalRows: more ? Math.max(rows.length + 1, Number(/\d+$/.exec(end)?.[0] || 0)) : rows.length,
      totalCols: end ? colOf(end) + 1 : 0,
    });
  }
  return sheets;
}

module.exports = { convert, read, colOf, general };

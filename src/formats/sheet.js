// Spreadsheets (Excel, Numbers, OpenDocument, CSV) as printed tables: every sheet with its
// name, columns lettered as in the spreadsheet (A, B, C …) and rows numbered, so "row 12,
// column C" means the same on the page as in the file. A wide sheet is printed in blocks of
// columns side by side; a very large one is cut, and the page and the app both say so.
const { esc, documentOf } = require("./page");

const LIMITS = { rows: 1000, cols: 40, cells: 60000 };

const letter = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Is this cell a number (right-aligned)? */
const numeric = (s) => /^[-+]?[\d'’ .,]*\d([.,]\d+)?\s?(%|[A-Z]{3}|€|\$|CHF|Fr\.)?$/.test(String(s).trim());

/**
 * `sheets`: [{ name, rows: [[text]], totalRows?, totalCols? }]. Returns { html, cut } where cut
 * says whether anything was left out (rows, columns, or whole sheets).
 */
const NOTES = {
  en: {
    rows: (n, total) => `Only rows 1 to ${n} of ${total} are printed here.`,
    cols: (last, total) => `Only columns A to ${last} of ${total} are printed here.`,
    full: "Left out: this workbook has more cells than are printed here.",
    empty: "This sheet is empty.",
  },
  de: {
    rows: (n, total) => `Hier stehen nur die Zeilen 1 bis ${n} von ${total}.`,
    cols: (last, total) => `Hier stehen nur die Spalten A bis ${last} von ${total}.`,
    full: "Ausgelassen: Diese Arbeitsmappe hat mehr Zellen, als hier gedruckt werden.",
    empty: "Dieses Blatt ist leer.",
  },
};

function sheetsToHtml(sheets, { title = "", lang = "en" } = {}) {
  const say = NOTES[lang] || NOTES.en;
  let cells = 0;
  let cut = false;
  const parts = [];
  sheets.forEach((sheet, index) => {
    // The used part only: no empty rows at the end, no empty columns on the right.
    let rows = sheet.rows.map((r) => (r || []).map((c) => (c === null || c === undefined ? "" : String(c))));
    while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
    let width = rows.reduce((w, r) => {
      let last = r.length;
      while (last > 0 && !r[last - 1].trim()) last--;
      return Math.max(w, last);
    }, 0);
    const totalRows = Math.max(sheet.totalRows || 0, rows.length);
    const totalCols = Math.max(sheet.totalCols || 0, width);
    const left = Math.max(0, LIMITS.cells - cells);
    let rowLimit = Math.min(LIMITS.rows, width ? Math.floor(left / Math.min(width, LIMITS.cols)) : LIMITS.rows);
    if (rowLimit < 1 && rows.length) {
      cut = true;
      parts.push(`<section class="${index ? "break" : ""}"><h2 class="sheet-title">${esc(sheet.name)}</h2><p class="note">${esc(say.full)}</p></section>`);
      return;
    }
    const sheetCut = rows.length > rowLimit || width > LIMITS.cols || totalRows > rows.length || totalCols > width;
    if (sheetCut) cut = true;
    rows = rows.slice(0, rowLimit);
    width = Math.min(width, LIMITS.cols);
    cells += rows.length * width;

    // Columns as wide as their longest text (within reason), grouped into blocks that fit across a landscape page.
    const widths = Array.from({ length: width }, (_, c) => Math.min(38, Math.max(3, ...rows.map((r) => (r[c] || "").length))));
    const blocks = [];
    let block = [];
    let used = 4;
    for (let c = 0; c < width; c++) {
      if (block.length && used + widths[c] > 150) {
        blocks.push(block);
        block = [];
        used = 4;
      }
      block.push(c);
      used += widths[c] + 2;
    }
    if (block.length) blocks.push(block);
    const tables = blocks.map((cols) => {
      const head = `<tr><th class="rn"></th>${cols.map((c) => `<th>${letter(c)}</th>`).join("")}</tr>`;
      const body = rows
        .map((r, i) => `<tr><th class="rn">${i + 1}</th>${cols.map((c) => {
          const v = r[c] || "";
          return `<td${v && numeric(v) ? ' class="num"' : ""}>${esc(v)}</td>`;
        }).join("")}</tr>`)
        .join("");
      return `<table class="sheet"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    });
    const notes = [];
    if (totalRows > rows.length) notes.push(say.rows(rows.length, totalRows));
    if (totalCols > width) notes.push(say.cols(letter(width - 1), totalCols));
    parts.push(
      `<section class="${index ? "break" : ""}"><h2 class="sheet-title">${esc(sheet.name)}</h2>${notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}${
        rows.length ? tables.join("") : '<p class="note">' + esc(say.empty) + "</p>"
      }</section>`,
    );
  });
  return { html: documentOf({ title, body: parts.join(""), size: "A4 landscape", margin: "12mm" }), cut };
}

/** A date from a spreadsheet's day number (1900 system: day 1 is 1900-01-01, with Excel's leap-year bug; 1904 system). */
function dateOf(serial, date1904 = false) {
  if (!Number.isFinite(serial)) return null;
  const ms = date1904 ? Date.UTC(1904, 0, 1) + serial * 864e5 : Date.UTC(1899, 11, serial < 61 ? 31 : 30) + serial * 864e5;
  const d = new Date(Math.round(ms / 1000) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A number as a spreadsheet shows it under its number format. Covers what exercise sheets use:
 * dates and times, percentages, a fixed number of decimals, thousands separators, and text
 * before or after (units, currencies). Anything else: the number as it is.
 */
function formatNumber(value, code, date1904 = false) {
  if (!Number.isFinite(value)) return String(value);
  const f = String(code || "General");
  const plain = f.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  if (/^General$/i.test(f) || !f) return general(value);
  const section = f.split(";")[value < 0 && f.split(";").length > 1 ? 1 : 0];
  const bare = section.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  if (/[dy]/i.test(plain) || /\bm{1,5}\b/i.test(bare.replace(/[0#?.,%]/g, "")) || /h/i.test(bare)) {
    const d = dateOf(value, date1904);
    return d ? formatDate(d, section) : general(value);
  }
  const literal = (section.match(/"([^"]*)"|\\(.)/g) || []).map((s) => s.replace(/^"|"$/g, "").replace(/^\\/, ""));
  const before = section.match(/^(?:"[^"]*"|\\.|[^0#?.,%"\\])*/)[0].replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/[_*].|\[[^\]]*\]/g, "").trim();
  const afterMatch = section.match(/[0#?](?:[^0#?]*)$/);
  const after = afterMatch ? afterMatch[0].slice(1).replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/[_*].|\[[^\]]*\]/g, "").replace(/[%]/g, "").trim() : literal.join("");
  const percent = /%/.test(bare);
  const decimals = (/\.([0#?]+)/.exec(bare) || [, ""])[1].length;
  const grouped = /[0#],[0#]/.test(bare);
  let v = Math.abs(percent ? value * 100 : value);
  let text = v.toFixed(Math.min(decimals, 10));
  if (grouped) text = text.replace(/^(\d+)/, (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  if (value < 0 && f.split(";").length < 2) text = "-" + text;
  return `${before ? before + " " : ""}${text}${percent ? "%" : ""}${after ? " " + after : ""}`.trim();
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A date as a date format says: "dd.mm.yyyy" gives 05.12.2026, "d mmm yy" 5 Dec 26, "hh:mm" 14:05. */
function formatDate(d, section) {
  const tokens = section.match(/"[^"]*"|\\.|\[[^\]]*\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|0+|[^"\\[ymdhsA0]+|./gi) || [];
  const hour = d.getUTCHours();
  const twelve = tokens.some((t) => /^(AM\/PM|A\/P)$/i.test(t));
  return tokens
    .map((t, i) => {
      const lower = t.toLowerCase();
      // "m" means minutes right after an hour or right before seconds.
      const prev = tokens.slice(0, i).reverse().find((x) => /^[hs]+$|^[ymd]+$/i.test(x)) || "";
      const next = tokens.slice(i + 1).find((x) => /^[hs]+$|^[ymd]+$/i.test(x)) || "";
      const minute = /^m{1,2}$/.test(lower) && (/^h/i.test(prev) || /^s/i.test(next));
      if (t.startsWith('"')) return t.slice(1, -1);
      if (t.startsWith("\\")) return t.slice(1);
      if (t.startsWith("[")) return "";
      if (lower === "yyyy") return String(d.getUTCFullYear());
      if (lower === "yy") return pad(d.getUTCFullYear() % 100);
      if (minute) return lower === "mm" ? pad(d.getUTCMinutes()) : String(d.getUTCMinutes());
      if (lower === "mmmmm") return MONTHS[d.getUTCMonth()][0];
      if (lower === "mmmm") return MONTHS[d.getUTCMonth()];
      if (lower === "mmm") return MONTHS[d.getUTCMonth()].slice(0, 3);
      if (lower === "mm") return pad(d.getUTCMonth() + 1);
      if (lower === "m") return String(d.getUTCMonth() + 1);
      if (lower === "dddd") return DAYS[d.getUTCDay()];
      if (lower === "ddd") return DAYS[d.getUTCDay()].slice(0, 3);
      if (lower === "dd") return pad(d.getUTCDate());
      if (lower === "d") return String(d.getUTCDate());
      if (lower === "hh") return pad(twelve ? hour % 12 || 12 : hour);
      if (lower === "h") return String(twelve ? hour % 12 || 12 : hour);
      if (lower === "ss") return pad(d.getUTCSeconds());
      if (lower === "s") return String(d.getUTCSeconds());
      if (/^am\/pm$/i.test(t)) return hour < 12 ? "AM" : "PM";
      if (/^a\/p$/i.test(t)) return hour < 12 ? "A" : "P";
      if (/^0+$/.test(t)) return "";
      return t.replace(/[_*]./g, "");
    })
    .join("")
    .trim();
}

/** A number as a spreadsheet's "General" format shows it: at most ten significant digits. */
function general(value) {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const s = Number(value.toPrecision(10)).toString();
  return s.includes("e") ? value.toExponential(5) : s;
}

// Built-in formats of Excel, by number.
const BUILTIN = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};

module.exports = { sheetsToHtml, formatNumber, general, dateOf, letter, BUILTIN, LIMITS };

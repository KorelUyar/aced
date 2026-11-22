// OpenDocument (LibreOffice, OpenOffice, and what Google Docs and Word can save as): text
// (.odt), spreadsheets (.ods) and presentations (.odp), zipped or as one flat XML file
// (.fodt, .fods, .fodp). Formulas are MathML objects inside the document.
const fs = require("fs");
const X = require("./xml");
const zip = require("./zip");
const M = require("./math");
const { esc, documentOf, picture } = require("./page");
const { decode } = require("./text");

const coded = (code) => Object.assign(new Error(code), { code });

/** The document's parts: its content and its styles (both in one file when it is flat). */
function openOdf(file) {
  const head = fs.readFileSync(file).subarray(0, 4);
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const archive = zip.open(file);
    if (!archive.has("content.xml")) {
      archive.close();
      throw coded("damaged");
    }
    if (archive.has("META-INF/manifest.xml") && /encryption-data/.test(archive.text("META-INF/manifest.xml"))) {
      archive.close();
      throw coded("protected");
    }
    const content = X.parse(archive.text("content.xml"));
    const styles = archive.has("styles.xml") ? X.parse(archive.text("styles.xml")) : null;
    return { content, styles, archive };
  }
  const flat = X.parse(decode(fs.readFileSync(file)));
  return { content: flat, styles: flat, archive: null };
}

const UNITS = { cm: 28.3465, mm: 2.83465, in: 72, pt: 1, pc: 12, px: 0.75 };
const toPt = (v) => {
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?$/.exec(String(v || "").trim());
  return m ? Number(m[1]) * (UNITS[m[2] || "pt"] || 1) : 0;
};

/** Which automatic styles make text bold, italic, raised or lowered. */
function textStyles(...roots) {
  const map = new Map();
  for (const root of roots) {
    for (const s of X.all(root, "style")) {
      const p = X.kid(s, "text-properties");
      if (!p) continue;
      map.set(X.attr(s, "name"), {
        bold: /bold|[6-9]00/.test(X.attr(p, "font-weight") || ""),
        italic: X.attr(p, "font-style") === "italic",
        pos: /^super/.test(X.attr(p, "text-position") || "") ? "sup" : /^sub/.test(X.attr(p, "text-position") || "") ? "sub" : "",
      });
    }
  }
  return map;
}

/** How each list style numbers its levels. */
function listStyles(...roots) {
  const map = new Map();
  for (const root of roots) {
    for (const s of X.all(root, "list-style")) {
      const levels = {};
      for (const l of X.kids(s)) {
        const lvl = Number(X.attr(l, "level") || 1) - 1;
        if (l.local === "list-level-style-number") levels[lvl] = { number: true, format: X.attr(l, "num-format") || "1", prefix: X.attr(l, "num-prefix") || "", suffix: X.attr(l, "num-suffix") ?? ".", start: Number(X.attr(l, "start-value") || 1), shown: Number(X.attr(l, "display-levels") || 1) };
        else if (l.local === "list-level-style-bullet") levels[lvl] = { number: false, bullet: X.attr(l, "bullet-char") || "•" };
      }
      map.set(X.attr(s, "name"), levels);
    }
  }
  return map;
}

const formatNum = (n, f) => {
  if (f === "a" || f === "A") {
    let s = "";
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
    return f === "A" ? s.toUpperCase() : s;
  }
  if (f === "i" || f === "I") {
    const r = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]].reduce((o, [v, s]) => {
      while (n >= v) {
        o += s;
        n -= v;
      }
      return o;
    }, "");
    return f === "I" ? r.toUpperCase() : r;
  }
  return f === "" ? "" : String(n);
};

function odfWriter({ archive, styles: tStyles, lists }) {
  let pictureBytes = 0;
  let missing = 0;

  function image(href) {
    if (!archive || !href || pictureBytes > 60 * 1024 * 1024) return "";
    const target = zip.resolve("", href.replace(/^\.\//, ""));
    if (!archive.has(target)) return "";
    try {
      const bytes = archive.read(target, 24 * 1024 * 1024);
      pictureBytes += bytes.length;
      const tag = picture(bytes, target);
      if (!tag) missing++;
      return tag || "";
    } catch {
      missing++;
      return "";
    }
  }

  function formula(obj) {
    // A formula object stands in its line, as LibreOffice shows it, whatever its MathML says.
    const inLine = (tree) => M.marked({ ...tree, a: { ...tree.a, display: undefined } });
    const inlineMath = X.first(obj, "math");
    if (inlineMath) return inLine(M.fromMathml(inlineMath));
    const href = (X.attr(obj, "href") || "").replace(/^\.\//, "");
    if (archive && href && archive.has(href + "/content.xml")) {
      const math = X.first(X.parse(archive.text(href + "/content.xml")), "math") || X.parse(archive.text(href + "/content.xml"));
      if (math && math.local === "math") return inLine(M.fromMathml(math));
    }
    return "";
  }

  function spans(node) {
    let out = "";
    for (const c of node.children) {
      if (typeof c === "string") {
        out += esc(c);
        continue;
      }
      switch (c.local) {
        case "s":
          out += "&nbsp;".repeat(Math.min(50, Number(X.attr(c, "c") || 1)));
          break;
        case "tab":
          out += " &emsp;";
          break;
        case "line-break":
          out += "<br>";
          break;
        case "span": {
          let inner = spans(c);
          const st = tStyles.get(X.attr(c, "style-name"));
          if (st && st.pos) inner = `<${st.pos}>${inner}</${st.pos}>`;
          if (st && st.bold) inner = `<b>${inner}</b>`;
          if (st && st.italic) inner = `<i>${inner}</i>`;
          out += inner;
          break;
        }
        case "frame":
          out += frame(c);
          break;
        case "note": {
          const citation = X.text(X.kid(c, "note-citation"));
          notes.push(blocks(X.kid(c, "note-body")));
          out += `<sup>${esc(citation || notes.length)}</sup>`;
          break;
        }
        case "soft-page-break":
        case "bookmark":
        case "bookmark-start":
        case "bookmark-end":
        case "annotation":
          break;
        default:
          out += spans(c);
      }
    }
    return out;
  }

  function frame(f) {
    const obj = X.kid(f, "object");
    if (obj) return formula(obj);
    const img = X.kid(f, "image");
    if (img) return image(X.attr(img, "href"));
    const box = X.kid(f, "text-box");
    if (box) return `<div class="note">${blocks(box)}</div>`;
    return "";
  }

  const notes = [];

  function list(node, depth, counters, style) {
    const own = X.attr(node, "style-name") || style;
    const levels = lists.get(own) || {};
    const lvl = levels[depth] || { number: false, bullet: "•" };
    let out = "";
    for (const item of X.kids(node, ["list-item", "list-header"])) {
      let label = "";
      if (item.local === "list-item") {
        counters[depth] = counters[depth] === undefined ? Number(X.attr(item, "start-value") || lvl.start || 1) : counters[depth] + 1;
        counters.length = depth + 1;
        if (lvl.number) {
          const shown = [];
          for (let k = Math.max(0, depth - (lvl.shown || 1) + 1); k <= depth; k++) shown.push(formatNum(counters[k] ?? 1, (levels[k] || lvl).format));
          label = `${lvl.prefix || ""}${shown.join(".")}${lvl.suffix ?? "."}`;
        } else label = lvl.bullet || "•";
      }
      for (const c of X.kids(item)) {
        if (c.local === "list") out += list(c, depth + 1, counters, own);
        else {
          const inner = c.local === "p" || c.local === "h" ? spans(c) : blocks({ children: [c] });
          out += `<p style="margin-left:${(depth + 1) * 18}pt;text-indent:-14pt">${label ? `<span>${esc(label)}</span>&nbsp; ` : ""}${inner}</p>`;
          label = "";
        }
      }
    }
    return out;
  }

  function table(t) {
    const rows = [];
    const walkRows = (n) => {
      for (const c of X.kids(n)) {
        if (c.local === "table-row") {
          const times = Math.min(Number(X.attr(c, "number-rows-repeated") || 1), 50);
          for (let i = 0; i < times; i++) rows.push(c);
        } else if (/^table-(header-rows|rows|row-group)$/.test(c.local)) walkRows(c);
      }
    };
    walkRows(t);
    return `<table>${rows
      .slice(0, 2000)
      .map((r) => `<tr>${X.kids(r, ["table-cell", "covered-table-cell"]).filter((c) => c.local === "table-cell").map((c) => {
        const span = Number(X.attr(c, "number-columns-spanned") || 1);
        const rs = Number(X.attr(c, "number-rows-spanned") || 1);
        return `<td${span > 1 ? ` colspan="${span}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}>${blocks(c)}</td>`;
      }).join("")}</tr>`)
      .join("")}</table>`;
  }

  function blocks(node) {
    let out = "";
    for (const c of X.kids(node)) {
      switch (c.local) {
        case "h": {
          const level = Math.min(6, Number(X.attr(c, "outline-level") || 1));
          out += `<h${level}>${spans(c)}</h${level}>`;
          break;
        }
        case "p":
          out += spans(c).trim() ? `<p>${spans(c)}</p>` : "<p>&nbsp;</p>";
          break;
        case "list":
          out += list(c, 0, [], null);
          break;
        case "table":
          out += table(c);
          break;
        case "section":
        case "text-box":
        case "index-body":
        case "table-of-content":
          out += blocks(c);
          break;
        case "frame":
          out += frame(c);
          break;
        default:
          break;
      }
    }
    return out;
  }

  return { blocks, spans, frame, table, notes, get missing() { return missing; } };
}

function convertText(file) {
  const { content, styles, archive } = openOdf(file);
  try {
    const body = X.first(content, "text");
    if (!body) throw coded("damaged");
    const w = odfWriter({ archive, styles: textStyles(content, styles), lists: listStyles(content, styles) });
    let html = w.blocks(body);
    if (w.notes.length) html += `<hr><ol style="font-size:9pt">${w.notes.map((n) => `<li>${n}</li>`).join("")}</ol>`;
    return { html: documentOf({ body: html }), missingPictures: w.missing };
  } finally {
    if (archive) archive.close();
  }
}

/** The sheets of a spreadsheet, each cell as LibreOffice shows it. */
function convertSheet(file, { rows: maxRows = 1000, cols: maxCols = 160 } = {}) {
  const { content, archive } = openOdf(file);
  if (archive) archive.close();
  const book = X.first(content, "spreadsheet");
  if (!book) throw coded("damaged");
  return X.kids(book, "table").map((t) => {
    const rows = [];
    let total = 0; // rows up to the last one with something in it
    let gap = 0; // empty rows seen since the last one with something in it
    let widest = 0;
    const walk = (n) => {
      for (const r of X.kids(n)) {
        if (/^table-(header-rows|rows|row-group)$/.test(r.local)) {
          walk(r);
          continue;
        }
        if (r.local !== "table-row") continue;
        const cells = [];
        for (const c of X.kids(r, ["table-cell", "covered-table-cell"])) {
          const times = Number(X.attr(c, "number-columns-repeated") || 1);
          const text = X.kids(c, "p").map((p) => X.text(p)).join("\n");
          for (let i = 0; i < Math.min(times, maxCols - cells.length); i++) cells.push(text);
          if (cells.length >= maxCols) break;
        }
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        const times = Number(X.attr(r, "number-rows-repeated") || 1);
        // Empty rows count only when something comes after them: the million empty rows a
        // spreadsheet program writes at the end are not part of the sheet.
        if (!cells.length) {
          gap += times;
          continue;
        }
        for (let i = 0; i < gap && rows.length < maxRows; i++) rows.push([]);
        total += gap;
        gap = 0;
        for (let i = 0; i < Math.min(times, maxRows + 1); i++) {
          total++;
          if (rows.length < maxRows) rows.push(cells);
        }
        widest = Math.max(widest, cells.length);
      }
    };
    walk(t);
    return { name: X.attr(t, "name") || "Sheet", rows, totalRows: total, totalCols: widest };
  });
}

function convertSlides(file) {
  const { content, styles, archive } = openOdf(file);
  try {
    const pres = X.first(content, "presentation");
    if (!pres) throw coded("damaged");
    // The size of a slide: from the page layout of its master, else 28 × 15.75 cm.
    let W = 793.7;
    let H = 446.5;
    const layout = X.all(styles, "page-layout-properties").find((p) => X.attr(p, "page-width"));
    if (layout) {
      W = toPt(X.attr(layout, "page-width")) || W;
      H = toPt(X.attr(layout, "page-height")) || H;
    }
    const w = odfWriter({ archive, styles: textStyles(content, styles), lists: listStyles(content, styles) });
    const slides = X.kids(pres, "page").map((page) => {
      const shapes = X.kids(page, ["frame", "custom-shape", "rect", "g"]).map((f) => {
        const x = toPt(X.attr(f, "x"));
        const y = toPt(X.attr(f, "y"));
        const fw = toPt(X.attr(f, "width")) || W * 0.8;
        const fh = toPt(X.attr(f, "height")) || H * 0.2;
        const cls = X.attr(f, "class") || "";
        const size = cls === "title" ? 28 : cls === "subtitle" ? 20 : 17;
        const inner = f.local === "frame" ? (X.kid(f, "text-box") ? w.blocks(X.kid(f, "text-box")) : w.frame(f) || (X.kid(f, "table") ? w.table(X.kid(f, "table")) : "")) : w.blocks(f);
        return inner ? `<div class="shape" style="left:${x.toFixed(1)}pt;top:${y.toFixed(1)}pt;width:${fw.toFixed(1)}pt;height:${fh.toFixed(1)}pt;font-size:${size}pt">${inner}</div>` : "";
      });
      return `<section class="slide">${shapes.join("")}</section>`;
    });
    const css = `
      .slide { position: relative; width: ${W}pt; height: ${H}pt; overflow: hidden; break-after: page; }
      .slide:last-child { break-after: auto; }
      .shape { position: absolute; line-height: 1.2; }
      .shape p { margin: 0 0 5pt; }
    `;
    return { html: documentOf({ body: slides.join("") || '<p class="note">No slides.</p>', size: `${W.toFixed(1)}pt ${H.toFixed(1)}pt`, margin: "0", css }), slides: slides.length, missingPictures: w.missing };
  } finally {
    if (archive) archive.close();
  }
}

module.exports = { convertText, convertSheet, convertSlides, toPt };

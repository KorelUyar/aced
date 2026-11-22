// Text files as pages: plain text and notes, Markdown, LaTeX sources, data and source code,
// Jupyter notebooks, and tables saved as CSV.
const { esc, documentOf, picture } = require("./page");

/**
 * A text file as text, whatever it was saved as: UTF-8 (with or without a mark at the start),
 * UTF-16 (which Windows and TextEdit both write), or the Western European encoding of older
 * files, in which every byte is a letter.
 */
function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // UTF-16 without a mark: every other byte of ordinary text is zero.
  const sample = bytes.subarray(0, 2000);
  let zeroEven = 0;
  let zeroOdd = 0;
  sample.forEach((b, i) => b === 0 && (i % 2 ? zeroOdd++ : zeroEven++));
  if (sample.length >= 8 && zeroOdd > sample.length * 0.3 && zeroEven < sample.length * 0.05) return new TextDecoder("utf-16le").decode(bytes);
  if (sample.length >= 8 && zeroEven > sample.length * 0.3 && zeroOdd < sample.length * 0.05) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const TEXT_LIMIT = 1500000; // characters of one file that are printed (about 500 pages)

/** Inline Markdown: code, bold, italic, links (as their text). */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<b>${a || b}</b>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** Markdown as a page: headings, paragraphs, lists, quotes, code blocks, tables. Formulas stay as written ($…$). */
function markdown(text) {
  const lines = text.split("\n");
  const out = [];
  let para = [];
  let list = null; // "ul" | "ol"
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const endList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      endList();
      const fence = line.trim().slice(0, 3);
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i]);
      out.push(`<pre>${esc(code.join("\n"))}</pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      endList();
      out.push(`<h${h[1].length}>${inline(h[2].replace(/\s+#+\s*$/, ""))}</h${h[1].length}>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      endList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const rows = [cells(line)];
      i++;
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table>${rows.map((r, k) => `<tr>${r.map((c) => (k ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join("")}</tr>`).join("")}</table>`);
      continue;
    }
    const item = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== kind) {
        endList();
        out.push(`<${kind}>`);
        list = kind;
      }
      // The number stays as written: "3." in the file is "3." on the page, whatever comes before it.
      out.push(kind === "ol" ? `<li value="${parseInt(item[1], 10)}">${inline(item[2])}</li>` : `<li>${inline(item[2])}</li>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      endList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      endList();
      out.push("<hr>");
      continue;
    }
    if (!line.trim()) {
      flush();
      endList();
      continue;
    }
    if (list && /^\s{2,}/.test(line)) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
      continue;
    }
    endList();
    para.push(line.trim());
  }
  flush();
  endList();
  return out.join("\n");
}

const PROSE = new Set(["txt", "text", "md", "markdown", "mdown", "mkd", "srt", "vtt", "log", ""]);
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

/** A text file as a page. Returns { html, cut }. */
function textToHtml(bytes, ext) {
  const whole = decode(bytes).replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  const text = whole.slice(0, TEXT_LIMIT);
  const cut = whole.length > text.length;
  if (!text.trim()) throw Object.assign(new Error("empty"), { code: "empty" });
  let body;
  if (MARKDOWN.has(ext)) body = markdown(text);
  else if (PROSE.has(ext)) body = `<pre style="font:11pt/1.5 -apple-system,Helvetica,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`;
  else body = `<pre>${esc(text)}</pre>`;
  return { html: documentOf({ body }), cut };
}

/** A Jupyter notebook: its text cells, its code, and what the code printed or drew. */
function notebookToHtml(bytes) {
  let nb;
  try {
    nb = JSON.parse(decode(bytes));
  } catch {
    throw Object.assign(new Error("damaged"), { code: "damaged" });
  }
  const src = (s) => (Array.isArray(s) ? s.join("") : String(s || ""));
  const cells = Array.isArray(nb.cells) ? nb.cells : (nb.worksheets || []).flatMap((w) => w.cells || []);
  const parts = cells.slice(0, 2000).map((cell) => {
    if (cell.cell_type === "markdown") return markdown(src(cell.source));
    if (cell.cell_type !== "code") return `<pre>${esc(src(cell.source))}</pre>`;
    const outputs = (cell.outputs || []).slice(0, 20).map((o) => {
      const data = o.data || {};
      if (data["image/png"]) return picture(Buffer.from(src(data["image/png"]).replace(/\s/g, ""), "base64"), "out.png") || "";
      if (data["image/jpeg"]) return picture(Buffer.from(src(data["image/jpeg"]).replace(/\s/g, ""), "base64"), "out.jpg") || "";
      const text = src(o.text || data["text/plain"] || (o.traceback ? o.traceback.join("\n").replace(/\u001b\[[0-9;]*m/g, "") : ""));
      return text ? `<pre style="color:#333;background:#f6f7f9;padding:3pt 5pt">${esc(text.slice(0, 20000))}</pre>` : "";
    });
    return `<pre style="border-left:2pt solid #c8ccd2;padding-left:6pt">${esc(src(cell.source))}</pre>${outputs.join("")}`;
  });
  if (!parts.length) throw Object.assign(new Error("empty"), { code: "empty" });
  return { html: documentOf({ body: parts.join('<div style="height:8pt"></div>') }), cut: cells.length > 2000 };
}

/** CSV, TSV: rows of cells. The separator is the one the file uses most (comma, semicolon or tab). */
function csvRows(text, maxRows) {
  const firstLines = text.slice(0, 20000).split("\n").slice(0, 20).join("\n");
  const count = (ch) => (firstLines.match(new RegExp(ch === "\t" ? "\t" : "\\" + ch, "g")) || []).length;
  const sep = ["\t", ";", ",", "|"].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      total++;
      if (rows.length < maxRows) rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    total++;
    if (rows.length < maxRows) rows.push(row);
  }
  return { rows, total };
}

module.exports = { decode, textToHtml, notebookToHtml, csvRows, markdown, TEXT_LIMIT };

// The page every converted file is printed on: an HTML document with the app's print styles.
// It is drawn by a hidden page with JavaScript off and every request blocked (src/print.js),
// so nothing here may rely on a script, and pictures travel inside it as data: addresses.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STYLE = `
@page { size: A4; margin: 16mm 15mm 16mm 15mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 11pt/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; background: #fff; overflow-wrap: break-word; }
h1 { font-size: 19pt; line-height: 1.2; margin: 0 0 10pt; }
h2 { font-size: 15pt; line-height: 1.25; margin: 14pt 0 7pt; }
h3 { font-size: 12.5pt; margin: 12pt 0 6pt; }
h4, h5, h6 { font-size: 11pt; margin: 10pt 0 5pt; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; }
p { margin: 0 0 6pt; }
ul, ol { margin: 0 0 6pt; padding-left: 22pt; }
li { margin: 0 0 2pt; }
table { border-collapse: collapse; margin: 4pt 0 10pt; max-width: 100%; }
td, th { border: 0.6pt solid #9aa0a6; padding: 2pt 5pt; vertical-align: top; text-align: left; }
th { background: #eef0f3; font-weight: 600; }
tr { break-inside: avoid; }
img, svg { max-width: 100%; height: auto; }
pre, code { font-family: Menlo, "SF Mono", Monaco, monospace; }
pre { font-size: 9pt; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
math { font-size: 1.08em; }
.formula { margin: 6pt 0 8pt; text-align: center; break-inside: avoid; }
.formula math { display: block math; }
.tx { font-size: 0.01px; color: transparent; }
.note { color: #555; font-size: 9pt; margin: 6pt 0 10pt; padding: 4pt 7pt; border-left: 2pt solid #c8ccd2; }
.sheet-title { font-size: 13pt; margin: 0 0 6pt; }
.sheet { font-size: 8.5pt; line-height: 1.3; }
.sheet td, .sheet th { padding: 1.5pt 4pt; }
.sheet .rn { color: #777; background: #f4f5f7; text-align: right; font-weight: 400; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.break { break-before: page; }
.source { color: #666; font-size: 8.5pt; margin-bottom: 8pt; }
`;

/**
 * A whole HTML document. `size` is a CSS page size ("A4", "A4 landscape", "960px 540px");
 * `margin` the page margin; `css` more styles; `body` the content.
 */
function documentOf({ title = "", body, size = "A4", margin, css = "", lang = "" }) {
  const pageRule = `@page { size: ${size}; ${margin !== undefined ? `margin: ${margin};` : ""} }`;
  return `<!doctype html><html${lang ? ` lang="${esc(lang)}"` : ""}><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}${pageRule}${css}</style></head><body>${body}</body></html>`;
}

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", emf: "image/emf", wmf: "image/wmf", avif: "image/avif", ico: "image/x-icon" };
// What the page can draw. (TIFF, EMF and WMF it cannot: such a picture is left out, with a note.)
const DRAWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/svg+xml", "image/avif", "image/x-icon"]);

/** The media type of a picture from its first bytes, or from its name. */
function mimeOf(bytes, name = "") {
  if (bytes && bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return "image/tiff";
    const head = bytes.subarray(0, 300).toString("utf8");
    if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && /<svg/i.test(bytes.subarray(0, 4000).toString("utf8")))) return "image/svg+xml";
  }
  return MIME[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";
}

/** A picture as an <img> the page can draw, or null when it cannot draw that kind. */
function picture(bytes, name, alt = "", style = "") {
  const mime = mimeOf(bytes, name);
  if (!DRAWABLE.has(mime)) return null;
  return `<img alt="${esc(alt)}"${style ? ` style="${esc(style)}"` : ""} src="data:${mime};base64,${bytes.toString("base64")}">`;
}

module.exports = { esc, documentOf, picture, mimeOf, DRAWABLE };

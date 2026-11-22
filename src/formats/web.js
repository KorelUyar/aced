// Web pages, drawings (SVG) and e-books (EPUB). A web page is printed as it is, by a page with
// JavaScript off and every request blocked (see src/print.js): its scripts never run and
// nothing it points to on the internet is loaded. Pictures saved next to it are put inside it.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const X = require("./xml");
const zip = require("./zip");
const M = require("./math");
const { esc, documentOf, picture, mimeOf, DRAWABLE } = require("./page");
const { decode } = require("./text");

const coded = (code) => Object.assign(new Error(code), { code });

/** The text of a web page, in the encoding it says it has (or UTF-8, or Western European). */
function htmlText(bytes) {
  const head = bytes.subarray(0, 4096).toString("latin1");
  const charset = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
  if (charset && !/utf-?8/i.test(charset)) {
    try {
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      // an encoding this decoder does not know: the usual guess below
    }
  }
  return decode(bytes);
}

/**
 * A saved web page. Pictures it refers to by a relative address, in its own folder or below
 * (a page saved "complete" keeps them in "<name>_files"), are put inside it; nothing outside
 * that folder is read, and addresses on the internet are left for the printer to refuse.
 */
function htmlFile(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 50 * 1024 * 1024) throw coded("tooLarge");
  let html = htmlText(bytes);
  const folder = fs.realpathSync(path.dirname(file));
  let budget = 40 * 1024 * 1024;
  html = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (whole, before, quote, src) => {
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return whole;
    let target;
    try {
      target = fs.realpathSync(path.resolve(folder, decodeURIComponent(src.split(/[?#]/)[0])));
    } catch {
      return whole;
    }
    if (!target.startsWith(folder + path.sep)) return whole;
    try {
      const st = fs.statSync(target);
      if (!st.isFile() || st.size > 10 * 1024 * 1024 || st.size > budget) return whole;
      const data = fs.readFileSync(target);
      const mime = mimeOf(data, target);
      if (!DRAWABLE.has(mime)) return whole;
      budget -= data.length;
      return `${before}${quote}data:${mime};base64,${data.toString("base64")}${quote}`;
    } catch {
      return whole;
    }
  });
  // A page without its own print styles gets the app's margins and type.
  const style = "<style>@page{size:A4;margin:14mm}body{font-family:-apple-system,Helvetica,Arial,sans-serif}img{max-width:100%;height:auto}</style>";
  html = /<head[\s>]/i.test(html) ? html.replace(/<head([\s>][^>]*>|>)/i, (m) => m + style) : style + html;
  return { html };
}

/** A drawing (SVG) on a page of its own, drawn as a picture: as a picture, an SVG runs no script and loads nothing. */
function svgFile(file) {
  let bytes = fs.readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = zlib.gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
    } catch {
      throw coded("damaged");
    }
  }
  if (bytes.length > 32 * 1024 * 1024) throw coded("tooLarge");
  const text = decode(bytes);
  if (!/<svg[\s>]/i.test(text)) throw coded("damaged");
  // Landscape or portrait, as the drawing is.
  const open = /<svg\b[^>]*>/i.exec(text)?.[0] || "";
  const num = (name) => Number((new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)`, "i").exec(open) || [])[1]) || 0;
  const box = (/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(open) || []).slice(1).map(Number);
  const w = num("width") || box[0] || 4;
  const h = num("height") || box[1] || 3;
  const landscape = w > h * 1.15;
  const img = `<img alt="" src="data:image/svg+xml;base64,${Buffer.from(text, "utf8").toString("base64")}" style="display:block;margin:0 auto;max-width:100%;max-height:${landscape ? 175 : 260}mm;width:auto;height:auto${w && h ? `;aspect-ratio:${w}/${h};width:100%` : ""}">`;
  return { html: documentOf({ body: img, size: landscape ? "A4 landscape" : "A4", margin: "12mm" }) };
}

// ------------------------------------------------------------ e-books

const HTML_TAGS = new Set(
  "p div span h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col img br hr em strong b i u s sub sup small big blockquote pre code q cite abbr figure figcaption section article aside header footer nav main mark del ins kbd samp var time".split(" "),
);
const KEEP_ATTRS = new Set(["colspan", "rowspan", "alt", "width", "height", "start", "value", "type", "class", "style", "lang", "dir"]);

/** One chapter of an e-book (XHTML) as clean HTML: its text, tables, pictures and formulas; nothing that could run or load. */
function chapterHtml(node, resolveImage) {
  if (typeof node === "string") return esc(node);
  const name = node.local.toLowerCase();
  if (["script", "style", "link", "meta", "iframe", "object", "embed", "noscript", "template", "form", "input", "button", "select", "textarea", "audio", "video", "source", "head", "title"].includes(name)) return "";
  const inner = () => node.children.map((c) => chapterHtml(c, resolveImage)).join("");
  if (name === "math") {
    try {
      return M.marked(M.fromMathml(node));
    } catch {
      return inner();
    }
  }
  if (name === "svg") {
    // A drawing inside a chapter (often a cover picture): the picture it shows, if any.
    const image = X.first(node, "image");
    const href = image && (X.attr(image, "href") || "");
    return href ? resolveImage(href) : "";
  }
  if (name === "img") return resolveImage(X.attr(node, "src") || "", X.attr(node, "alt") || "");
  if (name === "a") return inner();
  if (!HTML_TAGS.has(name)) return inner();
  const attrs = Object.entries(node.attrs)
    .filter(([k]) => KEEP_ATTRS.has(k.toLowerCase()))
    .map(([k, v]) => ` ${k.toLowerCase()}="${esc(k.toLowerCase() === "style" ? v.replace(/url\s*\([^)]*\)/gi, "none") : v)}"`)
    .join("");
  return name === "br" || name === "hr" || name === "col" ? `<${name}${attrs}>` : `<${name}${attrs}>${inner()}</${name}>`;
}

function epubFile(file) {
  const archive = zip.open(file);
  try {
    // Chapters that are encrypted (a book with copy protection) cannot be read. Fonts that are
    // only scrambled, as many books do, are no obstacle.
    if (archive.has("META-INF/encryption.xml")) {
      const locked = X.all(X.parse(archive.text("META-INF/encryption.xml")), "CipherReference").map((r) => X.attr(r, "URI") || "");
      if (locked.some((uri) => /\.(x?html?|xml)$/i.test(uri))) throw coded("protected");
    }
    const container = archive.has("META-INF/container.xml") ? X.parse(archive.text("META-INF/container.xml")) : null;
    const opfPath = X.attr(X.first(container, "rootfile"), "full-path") || archive.names.find((n) => n.endsWith(".opf"));
    if (!opfPath || !archive.has(opfPath)) throw coded("damaged");
    const opf = X.parse(archive.text(opfPath));
    const items = new Map(X.all(X.first(opf, "manifest"), "item").map((i) => [X.attr(i, "id"), { href: zip.resolve(opfPath, decodeSafe(X.attr(i, "href") || "")), type: X.attr(i, "media-type") || "" }]));
    const spine = X.all(X.first(opf, "spine"), "itemref").map((r) => items.get(X.attr(r, "idref"))).filter((i) => i && i.href && archive.has(i.href));
    let budget = 60 * 1024 * 1024;
    const parts = [];
    let chars = 0;
    let cut = false;
    spine.forEach((item, index) => {
      if (chars > 3000000) {
        cut = true;
        return;
      }
      let doc;
      try {
        doc = X.parse(archive.text(item.href));
      } catch {
        return;
      }
      const body = X.first(doc, "body") || doc;
      const resolveImage = (src, alt = "") => {
        const target = zip.resolve(item.href, decodeSafe(src.split("#")[0]));
        if (!target || !archive.has(target) || budget <= 0) return "";
        try {
          const bytes = archive.read(target, 16 * 1024 * 1024);
          budget -= bytes.length;
          return picture(bytes, target, alt) || "";
        } catch {
          return "";
        }
      };
      const html = body.children.map((c) => chapterHtml(c, resolveImage)).join("");
      chars += html.length;
      parts.push(`<section${index ? ' class="break"' : ""}>${html}</section>`);
    });
    if (!parts.length) throw coded("empty");
    const title = X.text(X.first(opf, "title"));
    return { html: documentOf({ title, body: parts.join(""), css: "section img{display:block;margin:6pt auto}" }), cut };
  } finally {
    archive.close();
  }
}

const decodeSafe = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

module.exports = { htmlFile, svgFile, epubFile, chapterHtml, htmlText };

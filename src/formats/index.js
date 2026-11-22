// Which kind of file is this, and how is it read? Decided by the name and, where the name
// does not say or could lie, by the first bytes.
const fs = require("fs");
const path = require("path");

const list = (s) => s.split(/\s+/).filter(Boolean);
const KINDS = {
  pdf: list("pdf"),
  picture: list("png jpg jpeg jpe jfif heic heif hif gif tif tiff bmp webp avif jp2 dng"),
  svg: list("svg svgz"),
  docx: list("docx docm dotx dotm"),
  xlsx: list("xlsx xlsm xltx xltm"),
  pptx: list("pptx pptm ppsx ppsm potx potm"),
  odt: list("odt ott fodt"),
  ods: list("ods ots fods"),
  odp: list("odp otp fodp"),
  epub: list("epub"),
  html: list("html htm xhtml xht shtml"),
  // Read by macOS itself (textutil): old Word files, RTF, Safari's web archives.
  textutil: list("doc dot rtf rtfd wordml webarchive"),
  xls: list("xls xlt"),
  // Read by macOS's Quick Look: old PowerPoint files.
  ppt: list("ppt pps pot"),
  csv: list("csv tsv tab"),
  iwork: list("pages numbers key"),
  ipynb: list("ipynb"),
  text: list(
    "txt text md markdown mdown mkd tex latex ltx sty cls bib json jsonl geojson xml yaml yml toml ini cfg conf log srt vtt sql " +
      "py pyw js mjs cjs ts tsx jsx java c h cpp hpp cc cxx cs go rs rb php swift kt kts m mm r jl sh bash zsh fish ps1 bat cmd " +
      "lua pl pm scala hs ml fs dart vue svelte css scss sass less asm s v vhd sv gradle make mk cmake dockerfile properties env gitignore",
  ),
};
const BY_EXT = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind])));
// Packages: folders that are one document (iWork saved as a package, RTF with pictures).
const PACKAGES = new Set(["pages", "numbers", "key", "rtfd"]);

const extOf = (file) => path.extname(file).slice(1).toLowerCase();

/** Files that are never material: what macOS, Windows and Office leave in folders. */
function isJunk(name) {
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    name.startsWith(".~lock.") ||
    /^(thumbs\.db|desktop\.ini|icon\r?|__macosx|\$recycle\.bin|system volume information)$/i.test(name) ||
    /\.(tmp|crdownload|part|download|partial|lnk|alias|ds_store)$/i.test(name)
  );
}

function head(file, n = 4096) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Looks like text: no zero bytes (or UTF-16 with its mark), and mostly printable characters. */
function looksLikeText(bytes) {
  if (!bytes.length) return false;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  let odd = 0;
  for (const b of bytes) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) odd++;
  }
  return odd / bytes.length < 0.02;
}

/**
 * What kind of material a file is: one of the keys of KINDS, "folder", or null when the app
 * cannot read it. `detail` says why, for the sentence the person gets.
 */
function identify(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { kind: null, why: "missing" };
  }
  const ext = extOf(file);
  if (stat.isDirectory()) return PACKAGES.has(ext) ? { kind: BY_EXT.get(ext), ext, package: true } : { kind: "folder" };
  if (!stat.isFile()) return { kind: null, why: "unsupported" };
  if (stat.size === 0) return { kind: null, why: "empty" };
  const bytes = head(file);
  const magic = bytes.subarray(0, 8);
  const isZip = magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 3 || magic[2] === 5);
  const isPdf = bytes.subarray(0, 1024).toString("latin1").includes("%PDF-");
  const isOle = magic.toString("hex") === "d0cf11e0a1b11ae1";
  const known = BY_EXT.get(ext);
  // The name decides, unless the bytes plainly say something else (a PDF named .doc, a picture without its ending).
  if (isPdf && known !== "pdf") return { kind: "pdf", ext };
  if (known && known !== "text") return { kind: known, ext };
  if (/^(zip)$/.test(ext) || (isZip && !known)) {
    return { kind: null, why: ext === "zip" ? "zip" : "unsupported", ext };
  }
  if (isOle && !known) return { kind: null, why: "unsupported", ext };
  if (known === "text" || looksLikeText(bytes)) return { kind: "text", ext };
  // A picture whose name does not say so.
  const sig = magic.toString("hex");
  if (/^89504e47|^ffd8ff|^47494638|^49492a00|^4d4d002a|^424d/.test(sig) || bytes.subarray(4, 12).toString("latin1").startsWith("ftypheic") || bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return { kind: "picture", ext };
  }
  return { kind: null, why: "unsupported", ext };
}

module.exports = { identify, isJunk, extOf, KINDS, PACKAGES, looksLikeText };

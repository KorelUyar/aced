// Copies the few third-party files the interface loads into ui/vendor, so the app needs no
// bundler and never reads from node_modules at run time. Run after updating a dependency.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = {
  "node_modules/htm/preact/standalone.module.js": "ui/vendor/htm-preact.js",
  "node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2": "ui/vendor/archivo.woff2",
  "node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-italic.woff2": "ui/vendor/archivo-italic.woff2",
  "node_modules/@fontsource-variable/archivo/LICENSE": "ui/vendor/archivo-LICENSE.txt",
  "node_modules/htm/LICENSE": "ui/vendor/htm-LICENSE.txt",
};
for (const [from, to] of Object.entries(files)) {
  fs.copyFileSync(path.join(root, from), path.join(root, to));
  console.log("vendored", to);
}

// KaTeX draws the formulas: its module, its stylesheet and its fonts (woff2 only).
const katex = path.join(root, "node_modules/katex/dist");
const target = path.join(root, "ui/vendor/katex");
fs.mkdirSync(path.join(target, "fonts"), { recursive: true });
fs.copyFileSync(path.join(katex, "katex.mjs"), path.join(target, "katex.mjs"));
fs.copyFileSync(path.join(katex, "katex.min.css"), path.join(target, "katex.min.css"));
fs.copyFileSync(path.join(root, "node_modules/katex/LICENSE"), path.join(target, "LICENSE.txt"));
for (const font of fs.readdirSync(path.join(katex, "fonts"))) {
  if (font.endsWith(".woff2")) fs.copyFileSync(path.join(katex, "fonts", font), path.join(target, "fonts", font));
}
console.log("vendored", "ui/vendor/katex");

// pdf.js draws the book inside the app: its module, its worker and the standard fonts. Books
// without text need more: the decoders for the pictures in scanned books (JPEG 2000, JBIG2 and
// fax coding; each as WebAssembly and as plain JavaScript, which is what runs where WebAssembly
// may not), colour profiles, and the character maps of East Asian fonts. Each folder brings
// its own licence files.
const pdfjs = path.join(root, "node_modules/pdfjs-dist");
const pdfTarget = path.join(root, "ui/vendor/pdfjs");
fs.rmSync(pdfTarget, { recursive: true, force: true }); // nothing of an older pdf.js stays behind
fs.mkdirSync(pdfTarget, { recursive: true });
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) fs.copyFileSync(path.join(pdfjs, "build", file), path.join(pdfTarget, file));
fs.copyFileSync(path.join(pdfjs, "LICENSE"), path.join(pdfTarget, "LICENSE.txt"));
// quickjs is the part of pdf.js that runs scripts found in a PDF. The app never does that, so it is left out.
const wanted = { standard_fonts: () => true, cmaps: () => true, iccs: () => true, wasm: (name) => !/quickjs/i.test(name) };
for (const [folder, keep] of Object.entries(wanted)) {
  fs.mkdirSync(path.join(pdfTarget, folder));
  for (const name of fs.readdirSync(path.join(pdfjs, folder))) if (keep(name)) fs.copyFileSync(path.join(pdfjs, folder, name), path.join(pdfTarget, folder, name));
}
console.log("vendored", "ui/vendor/pdfjs");

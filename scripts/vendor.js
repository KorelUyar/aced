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

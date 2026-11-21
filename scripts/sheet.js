// Puts the key screenshots side by side in one picture, <outDir>/checkpoint-1.png:
//
//   node_modules/.bin/electron scripts/sheet.js docs/shots
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { quiet, hiddenWindow, capture, sleep } = require("./hidden");
const brand = require("../src/brand");

quiet();
const out = path.resolve(process.argv[process.argv.length - 1]);
const root = path.join(__dirname, "..");
const url = (...parts) => pathToFileURL(path.join(...parts)).href;

const ROWS = [
  ["Light, English (the default). The sample exams are German, so everything the AI writes is German.", [
    ["home-light", "Home"],
    ["new-grade-light", "New exam, question 4 of 5: target grade"],
    ["new-pace-light", "New exam, question 5 of 5: pace"],
  ]],
  ["", [
    ["today-light", "One exam, Today: the one next thing to do"],
    ["strategy-light", "One exam, Strategy: what matters most, with pages and exercises"],
    ["quiz-light", "Quiz: a written answer, corrected"],
  ]],
  ["Dark, switched to German", [
    ["home-de-dark", "Home"],
    ["today-de-dark", "Heute"],
    ["quiz-de-dark", "Quiz"],
  ]],
];

const TILE = 1000;
const html = `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: Archivo; src: url("${url(root, "ui/vendor/archivo.woff2")}"); font-weight: 100 900; font-stretch: 62% 125%; }
  @font-face { font-family: Archivo; font-style: italic; src: url("${url(root, "ui/vendor/archivo-italic.woff2")}"); font-weight: 100 900; font-stretch: 62% 125%; }
  body { margin: 0; padding: 56px 56px 64px; width: max-content; background: #e7e9ee; color: #14161b; font: 420 19px/1.4 Archivo, sans-serif; -webkit-font-smoothing: antialiased; }
  header { display: flex; align-items: center; gap: 22px; margin-bottom: 44px; }
  header img { width: 104px; height: 104px; margin: -10px; }
  header b { display: block; font: italic 760 40px/1.1 Archivo; font-stretch: 116%; letter-spacing: -0.01em; }
  header span { color: #5c6370; }
  h2 { font: 600 20px/1.3 Archivo; margin: 34px 0 16px; color: #2b2f37; }
  .row { display: grid; grid-template-columns: repeat(3, ${TILE}px); gap: 36px; margin-top: 36px; }
  h2 + .row { margin-top: 0; }
  figure { margin: 0; }
  figure img { display: block; width: ${TILE}px; border-radius: 16px; box-shadow: 0 0 0 1px rgb(20 22 27 / .12), 0 18px 40px -22px rgb(20 22 27 / .45); }
  figcaption { margin-top: 14px; color: #5c6370; }
</style>
<header><img src="${url(root, "build/icon.png")}"><div><b>${brand.name}</b><span>Checkpoint 1: the design and the key screens, in the real app on sample data</span></div></header>
${ROWS.map(
  ([title, shots]) => `${title ? `<h2>${title}</h2>` : ""}<div class="row">${shots
    .map(([file, caption]) => `<figure><img src="${url(out, file + ".png")}"><figcaption>${caption}</figcaption></figure>`)
    .join("")}</div>`,
).join("")}`;

app.whenReady().then(async () => {
  const page = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spurt-sheet-")), "sheet.html");
  fs.writeFileSync(page, html);
  const win = hiddenWindow(800, 600);
  await win.loadFile(page);
  const size = await win.webContents.executeJavaScript(
    `document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode()))).then(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])`,
  );
  win.setContentSize(size[0], size[1]);
  await sleep(700);
  fs.writeFileSync(path.join(out, "checkpoint-1.png"), await capture(win));
  console.log("wrote checkpoint-1.png", size.join("x"));
  app.quit();
});

// Developer check: reads a PDF the way the app does and prints what it found.
//   node_modules/.bin/electron scripts/try-pdf.js <file.pdf>
const { app, utilityProcess } = require("electron");
const path = require("path");
app.dock?.hide();
app.whenReady().then(() => {
  const started = Date.now();
  const child = utilityProcess.fork(path.join(__dirname, "..", "src", "pdf-worker.js"));
  child.on("message", (m) => {
    if (m.type === "progress") return;
    if (m.type === "error") console.log("ERROR", m.message);
    else {
      const chars = m.pages.map((p) => p.length);
      console.log("pages", m.pages.length, "chars", chars.reduce((a, b) => a + b, 0), "outline", m.outline.length, "ms", Date.now() - started);
      console.log("empty pages", chars.filter((c) => c < 40).length);
      console.log(JSON.stringify(m.outline.slice(0, 6)));
      const n = Number(process.argv[process.argv.length - 1]) || 0;
      if (n) console.log("--- page", n, "\n" + m.pages[n - 1].slice(0, 1500));
    }
    app.quit();
  });
  const file = process.argv.find((a) => a.endsWith(".pdf"));
  child.postMessage({ file: path.resolve(file) });
});

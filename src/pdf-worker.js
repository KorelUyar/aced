// Runs in its own process (Electron utilityProcess): reads the text of a PDF, page by page.
// A PDF is untrusted input, and a big book takes a while, so none of this happens in the
// main process. Nothing here touches the network.
const fs = require("fs");
const { pathToFileURL } = require("url");

const port = process.parentPort;

/** The text items of one page as lines, top to bottom. */
function pageText(content) {
  const lines = [];
  let line = "";
  let lastY = null;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform ? item.transform[5] : lastY;
    if (lastY !== null && Math.abs(y - lastY) > 2 && line.trim()) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += item.str;
    if (item.hasEOL) {
      lines.push(line.trimEnd());
      line = "";
    }
    lastY = y;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function outlineOf(doc) {
  const out = [];
  const walk = async (items, depth) => {
    for (const item of items || []) {
      let page = null;
      try {
        const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
        if (dest && dest[0]) page = (await doc.getPageIndex(dest[0])) + 1;
      } catch {
        // an outline entry that points nowhere
      }
      if (page && item.title) out.push({ title: item.title.replace(/\s+/g, " ").trim().slice(0, 160), page, depth });
      if (depth < 3) await walk(item.items, depth + 1);
    }
  };
  try {
    await walk(await doc.getOutline(), 0);
  } catch {
    // no outline
  }
  return out;
}

async function read(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // In Node, pdf.js loads its "worker" into this same process; it still wants to be told where it is.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push(pageText(await page.getTextContent()));
    page.cleanup();
    if (n % 5 === 0 || n === doc.numPages) port.postMessage({ type: "progress", done: n, total: doc.numPages });
  }
  const outline = await outlineOf(doc);
  await task.destroy();
  return { pages, outline };
}

port.on("message", async ({ data }) => {
  try {
    port.postMessage({ type: "done", ...(await read(data.file)) });
  } catch (err) {
    port.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
});

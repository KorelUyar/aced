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

/** How many pages, and the sizes of the pages asked for: nothing is read. */
async function factsOf(pdfjs, doc, pages) {
  const sizes = [];
  for (const n of pages.slice(0, 8)) {
    if (!Number.isInteger(n) || n < 1 || n > doc.numPages) {
      sizes.push(null);
      continue;
    }
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    sizes.push(page.rotate % 180 ? [y1 - y0, x1 - x0] : [x1 - x0, y1 - y0]);
    page.cleanup();
  }
  return { count: doc.numPages, sizes };
}

/**
 * The lines of one page, top to bottom: where each starts (a share of the page height, from the
 * top) and how it begins. For finding where an exercise is printed.
 */
async function linesOf(doc, n) {
  if (!Number.isInteger(n) || n < 1 || n > doc.numPages) return [];
  const page = await doc.getPage(n);
  const [, y0, , y1] = page.view;
  const height = y1 - y0 || 1;
  const rows = new Map();
  for (const item of (await page.getTextContent()).items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5] / 2) * 2;
    const size = Math.abs(item.transform[3]) || 10;
    const row = rows.get(y) || { y, size, items: [] };
    row.items.push({ x: item.transform[4], str: item.str });
    rows.set(y, row);
  }
  page.cleanup();
  return [...rows.values()]
    .sort((a, b) => b.y - a.y)
    .map((r) => ({ top: Math.max(0, Math.min(1, (y1 - r.y - r.size) / height)), text: r.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ").trim().slice(0, 40) }));
}

async function read(file, facts, lines) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // In Node, pdf.js loads its "worker" into this same process; it still wants to be told where it is.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  if (Number.isInteger(lines)) {
    const out = { lines: await linesOf(doc, lines) };
    await task.destroy();
    return out;
  }
  if (Array.isArray(facts)) {
    const out = await factsOf(pdfjs, doc, facts);
    await task.destroy();
    return out;
  }
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
    port.postMessage({ type: "done", ...(await read(data.file, data.facts, data.lines)) });
  } catch (err) {
    port.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
});

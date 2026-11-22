// Prints a converted page (src/convert-worker.js) to a PDF, in a hidden page that is locked
// down: JavaScript is off, the page has its own session in memory, every request it makes is
// refused except for the one page it shows, and that page comes with a content policy that
// allows nothing but pictures, styles and fonts inside the page itself. So a web page, a
// drawing or a Word file can neither run anything nor load anything from anywhere.
const { BrowserWindow, session } = require("electron");
const crypto = require("crypto");
const fs = require("fs");

const SCHEME = "aced-print";
const POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const pages = new Map(); // id -> file of the page to show

let printer = null;
function printerSession() {
  if (printer) return printer;
  printer = session.fromPartition("aced-print"); // no "persist:": nothing of it is kept on disk
  printer.setPermissionRequestHandler((_c, _p, answer) => answer(false));
  printer.setPermissionCheckHandler(() => false);
  printer.webRequest.onBeforeRequest((details, answer) => {
    const url = details.url;
    answer({ cancel: !(url.startsWith(`${SCHEME}://page/`) || url.startsWith("data:")) });
  });
  printer.protocol.handle(SCHEME, (request) => {
    const id = new URL(request.url).pathname.replace(/^\/+/, "");
    const file = pages.get(id);
    if (!file) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(file), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": POLICY, "X-Content-Type-Options": "nosniff" },
    });
  });
  return printer;
}

const cancelled = () => Object.assign(new Error("cancelled"), { code: "cancelled" });

let queue = Promise.resolve();

/**
 * Prints the page in `file` (an HTML file) to `out` (a PDF). Pages are printed one at a time.
 * Resolves when the PDF is written. A page that has not printed after `limit` ms is given up.
 */
function print(file, out, { signal, limit = 180000, footer = "" } = {}) {
  const job = queue.then(() => printOne(file, out, signal, limit, footer));
  queue = job.catch(() => {});
  return job;
}

async function printOne(file, out, signal, limit, footer) {
  if (signal?.aborted) throw cancelled();
  const id = crypto.randomUUID();
  pages.set(id, file);
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: {
      session: printerSession(),
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webgl: false,
      plugins: false,
      spellcheck: false,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      autoplayPolicy: "document-user-activation-required",
    },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("will-redirect", (e) => e.preventDefault());
  contents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame || e.url !== `${SCHEME}://page/${id}`) e.preventDefault();
  });
  let timer;
  const onAbort = () => contents.stop();
  signal?.addEventListener("abort", onAbort);
  try {
    const giveUp = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("print: too slow"), { code: "tooLarge" })), limit);
    });
    await Promise.race([contents.loadURL(`${SCHEME}://page/${id}`), giveUp]);
    if (signal?.aborted) throw cancelled();
    const pdf = await Promise.race([
      contents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        generateDocumentOutline: true,
        generateTaggedPDF: false,
        // A line at the foot of every page (an exam shared as a PDF says where it was made).
        ...(footer
          ? {
              displayHeaderFooter: true,
              headerTemplate: "<span></span>",
              footerTemplate: `<div style="width:100%;text-align:center;font:7.5px -apple-system,Helvetica,sans-serif;color:#5c6370">${footer.replace(/[&<>]/g, "")}</div>`,
            }
          : {}),
      }),
      giveUp,
    ]);
    if (signal?.aborted) throw cancelled();
    fs.writeFileSync(out, pdf);
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    pages.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { print, SCHEME, POLICY };

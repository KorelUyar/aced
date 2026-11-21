// The book, drawn inside the app with pdf.js: one page at a time, as wide as its panel.
// Only the page's picture is drawn. Links in the PDF are not live, scripts in it never run,
// and nothing in it can open a window or leave the page.
import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
import { html, useState, useEffect, useRef, Icon, printed } from "./bits.js";
import { t } from "./i18n.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
const FONTS = new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href;

const open = new Map(); // hash -> the opened document (kept while the app runs)
function documentOf(hash) {
  if (!open.has(hash)) {
    const task = pdfjs.getDocument({ url: `spurt-book://book/${hash}`, disableRange: true, isEvalSupported: false, standardFontDataUrl: FONTS, verbosity: 0 });
    open.set(hash, task.promise.catch((err) => (open.delete(hash), Promise.reject(err))));
  }
  return open.get(hash);
}

export function Book({ material, page, onPage }) {
  const box = useRef(null);
  const canvas = useRef(null);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState("loading"); // loading | shown | failed
  const last = material.pages;
  const at = Math.max(1, Math.min(last, page || 1));

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!width) return;
    let task;
    let stale = false;
    setState((s) => (s === "shown" ? s : "loading"));
    documentOf(material.hash)
      .then((doc) => doc.getPage(at))
      .then((pdfPage) => {
        if (stale) return;
        const ratio = window.devicePixelRatio || 1;
        const scale = width / pdfPage.getViewport({ scale: 1 }).width;
        const viewport = pdfPage.getViewport({ scale: scale * ratio });
        const c = canvas.current;
        c.width = viewport.width;
        c.height = viewport.height;
        c.style.height = `${viewport.height / ratio}px`;
        task = pdfPage.render({ canvasContext: c.getContext("2d"), viewport });
        return task.promise.then(() => !stale && setState("shown"));
      })
      .catch((err) => err && err.name !== "RenderingCancelledException" && !stale && setState("failed"));
    return () => {
      stale = true;
      task && task.cancel();
    };
  }, [material.hash, at, width]);

  const label = printed(material, at);
  return html`<section class="book">
    <header class="side-head">
      <strong>${material.title}</strong>
      <span class="pager">
        <button class="mini" aria-label=${t("bookBack")} disabled=${at <= 1} onClick=${() => onPage(at - 1)}><${Icon} name="back" /></button>
        <span class="num">${t("page", label)}${label !== at ? html` <small>${at}/${last}</small>` : html` <small>/ ${last}</small>`}</span>
        <button class="mini flip" aria-label=${t("bookOn")} disabled=${at >= last} onClick=${() => onPage(at + 1)}><${Icon} name="back" /></button>
      </span>
    </header>
    <div class="book-page" ref=${box} data-state=${state}>
      <canvas ref=${canvas}></canvas>
      ${state === "failed" && html`<p class="muted">${t("bookFailed")}</p>`}
    </div>
  </section>`;
}

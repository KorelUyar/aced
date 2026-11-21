// The book, drawn inside the app with pdf.js: all its pages one below the other, as wide as
// the panel or larger. Only the pages near the part in view are drawn and kept, so a book of
// a thousand pages costs no more than a short one.
// Only the page's picture is drawn. Links in the PDF are not live, scripts in it never run,
// and nothing in it can open a window or leave the page.
import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
import { html, useState, useEffect, useRef, Icon, printed } from "./bits.js";
import { t, lang } from "./i18n.js";

const VENDOR = new URL("./vendor/pdfjs/", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.mjs";

const PAD = 14; // field around the pages
const GAP = 12; // field between two pages
const ZOOMS = [1, 1.25, 1.5, 2]; // times the width of the panel
const AROUND = 2; // pages kept ready above and below the ones in view
const LARGE = 6e6; // pixels of one page's picture from which only one page each way is kept ready
const MAX_PIXELS = 16e6; // of one page's picture; a larger page is drawn a little less sharp
const PAPER = Math.SQRT2; // height by width of a page, until the book tells
const WHOLE = 1 << 27; // bytes: a larger book is read in parts where the app hands out parts
const PART = 1 << 16; // bytes of such a part

// Words this panel needs that the app's list may not have yet.
const WORDS = {
  bookZoomIn: { en: "Zoom in", de: "Vergrössern" },
  bookZoomOut: { en: "Zoom out", de: "Verkleinern" },
  bookLocked: { en: "This PDF is protected with a password, so it cannot be shown here.", de: "Dieses PDF ist mit einem Passwort geschützt und lässt sich hier nicht anzeigen." },
  bookDamaged: { en: "This PDF could not be opened. The file seems to be damaged.", de: "Dieses PDF liess sich nicht öffnen. Die Datei scheint beschädigt zu sein." },
};
const say = (key) => {
  const text = t(key);
  return text !== key || !WORDS[key] ? text : WORDS[key][lang()] || WORDS[key].en;
};

let open = null; // the book opened last (see bookOf): it stays open, so coming back to it is instant
const zooms = new Map(); // hash -> the zoom the person chose for that book

/**
 * A book read part by part instead of whole. pdf.js only does that by itself over http, so
 * for the app's own address the parts are fetched here.
 */
class Parts extends pdfjs.PDFDataRangeTransport {
  constructor(url, length, start, onLost) {
    super(length, start);
    this.url = url;
    this.onLost = onLost;
    this.stopped = new AbortController();
  }
  requestDataRange(begin, end) {
    fetch(this.url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: this.stopped.signal })
      .then((answer) => (answer.status === 206 ? answer.arrayBuffer() : Promise.reject(new Error("no part"))))
      .then((part) => this.onDataRange(begin, new Uint8Array(part)))
      .catch(() => !this.stopped.signal.aborted && this.onLost());
  }
  abort() {
    this.stopped.abort();
  }
}

/**
 * Where pdf.js reads the book from. A book of ordinary size is read whole: that is the fastest
 * way to any page. A very large one (scans run to hundreds of megabytes) is read in parts, so
 * it never sits in memory whole. That needs an app that hands out parts: asked for the first
 * one, it answers 206 and tells how long the file is. Any other answer: the file is read whole.
 */
async function sourceOf(url, onLost) {
  try {
    const answer = await fetch(url, { headers: { Range: `bytes=0-${PART - 1}` } });
    const length = Number((/\/(\d+)$/.exec(answer.headers.get("Content-Range") || "") || [])[1]);
    if (answer.status === 206 && length > 0) {
      const start = new Uint8Array(await answer.arrayBuffer());
      if (start.length >= length) return { data: start };
      if (length > WHOLE) return { range: new Parts(url, length, start, onLost) };
    } else if (answer.body) answer.body.cancel().catch(() => {});
  } catch {
    // reading it whole, below, tells what is wrong
  }
  return { url };
}

/** An open book: `promise` resolves to pdf.js's document, `lost` when its file goes away under it. */
function bookOf(hash) {
  if (open && open.hash === hash) return open;
  if (open) open.close();
  let task = null;
  let closed = false;
  let tellLost;
  const entry = {
    hash,
    lost: new Promise((resolve) => (tellLost = resolve)),
    close() {
      closed = true;
      if (open === entry) open = null;
      if (task) task.destroy().catch(() => {});
    },
  };
  // A part that can no longer be read: the file is gone. The panel says so (pdf.js would wait
  // for that part for ever), the book is closed, and the next visit opens it afresh.
  const onLost = () => {
    tellLost();
    entry.close();
  };
  entry.promise = sourceOf(`spurt-book://book/${hash}`, onLost)
    .then((source) => {
      if (closed) throw new Error("closed");
      task = pdfjs.getDocument({
        ...source,
        // of a book read in parts, no more than the pages in view need
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: PART,
        isEvalSupported: false,
        enableXfa: false,
        standardFontDataUrl: VENDOR + "standard_fonts/",
        // for scanned books and books whose letters are shapes: picture decoders, colour profiles, character maps
        wasmUrl: VENDOR + "wasm/",
        iccUrl: VENDOR + "iccs/",
        cMapUrl: VENDOR + "cmaps/",
        cMapPacked: true,
        verbosity: 0,
      });
      return task.promise;
    })
    .catch((err) => {
      if (open === entry) open = null;
      throw err;
    });
  open = entry;
  return entry;
}

/**
 * Lays the pages of one book out in `run`, inside the scrolling `box`, and draws the ones in
 * view. `tell.page(n)` is called when another page comes to the top, `tell.count(n)` when the
 * file has another number of pages than expected, `tell.problem(kind)` when it cannot be opened;
 * `tell.name(n)` is what a page is called ("p. 405").
 */
function showPages(box, run, hash, pageCount, tell) {
  let count = 0;
  let ratios = new Float64Array(0); // height by width of every page
  let known = new Uint8Array(0); // 1 where that was read from the book
  let tops = new Float64Array(1); // where every page starts in the run
  let measured = false;
  let doc = null;
  let problem = null;
  let dead = false;
  let zoom = zooms.get(hash) || 1;
  let width = 0; // of a page at zoom 1, in CSS pixels
  let sheetWidth = 0;
  let view = null; // { first, last }: the pages in view, counted from 0
  let current = 1; // the page the person is on
  let pin = 1; // the page asked for, held at the top until the person scrolls
  let lastY = 0;
  let down = true;
  let drawing = null; // { n, px, task, stopped }
  let wait = 0;
  let tidy = 0;
  let unwatch = () => {};
  const sheets = new Map(); // page number -> { n, el, canvas, px, failed }

  function size(n) {
    count = n > 0 ? n : 0;
    ratios = new Float64Array(count).fill(PAPER);
    known = new Uint8Array(count);
    tops = new Float64Array(count + 1);
  }

  const heightOf = (i) => Math.round(sheetWidth * ratios[i]);
  /** The scroll position that puts page n at the top (as far as the end of the book allows). */
  const topOf = (n) => Math.max(0, Math.min(n <= 1 ? 0 : tops[n - 1] - GAP, box.scrollHeight - box.clientHeight));
  /** The last page that starts at or above y. */
  function startingBefore(y) {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  /** The first page that reaches below y. */
  function firstAt(y) {
    const i = startingBefore(y);
    return tops[i] + heightOf(i) <= y && i < count - 1 ? i + 1 : i;
  }
  /** The width in device pixels a page's picture should have now. */
  function pixels(i) {
    let w = Math.round(sheetWidth * (window.devicePixelRatio || 1));
    const area = w * w * ratios[i];
    if (area > MAX_PIXELS) w = Math.floor(w * Math.sqrt(MAX_PIXELS / area));
    return w;
  }
  /** How many pages are kept ready above and below the view: fewer when zoomed in far, for the memory. */
  const around = () => (view && pixels(view.first) ** 2 * ratios[view.first] > LARGE ? 1 : AROUND);

  function put(sheet) {
    const i = sheet.n - 1;
    sheet.el.style.top = `${tops[i]}px`;
    sheet.el.style.width = `${sheetWidth}px`;
    sheet.el.style.height = `${heightOf(i)}px`;
  }
  function mount(n) {
    const el = document.createElement("div");
    el.className = "leaf";
    el.dataset.page = n;
    el.dataset.state = "blank";
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", tell.name(n));
    const sheet = { n, el, canvas: null, px: 0, failed: false };
    put(sheet);
    run.append(el);
    sheets.set(n, sheet);
  }
  function drop(sheet) {
    if (drawing && drawing.n === sheet.n) stop();
    if (sheet.canvas) sheet.canvas.width = 0; // gives the picture's memory back at once
    sheet.el.remove();
    sheets.delete(sheet.n);
  }

  /** What is at the top of the view now, to find it again after the pages change size. */
  function anchor() {
    const x = box.scrollWidth > box.clientWidth ? (box.scrollLeft + box.clientWidth / 2) / box.scrollWidth : 0.5;
    if (pin || !view) return { pin: pin || current, x };
    const i = firstAt(box.scrollTop);
    const over = box.scrollTop - tops[i];
    return { i, part: over > 0 ? over / heightOf(i) : 0, before: Math.min(0, over), x };
  }
  /** Works out where every page goes. `keep` is the place to stay at, taken before anything changed. */
  function layout(keep = anchor()) {
    if (problem || !count || width <= 0) return;
    sheetWidth = Math.max(80, Math.round(width * zoom));
    let y = PAD;
    for (let i = 0; i < count; i++) {
      tops[i] = y;
      y += heightOf(i) + GAP;
    }
    tops[count] = y;
    run.style.width = `${sheetWidth + 2 * PAD}px`;
    run.style.height = `${y - GAP + PAD}px`;
    for (const sheet of sheets.values()) put(sheet);
    box.scrollTop = keep.pin ? topOf(keep.pin) : tops[keep.i] + keep.before + keep.part * heightOf(keep.i);
    box.scrollLeft = keep.x * box.scrollWidth - box.clientWidth / 2;
    lastY = box.scrollTop;
    place();
  }

  /** The page that fills most of the view. */
  function mostInView(y0, y1) {
    const seen = (i) => Math.max(0, Math.min(y1, tops[i] + heightOf(i)) - Math.max(y0, tops[i]));
    // A page that is whole in view keeps its place: after a jump to a short page the next one shows as well.
    const c = current - 1;
    if (c >= view.first && c <= view.last && seen(c) >= heightOf(c) - 1) return current;
    let best = view.first;
    for (let i = view.first + 1; i <= view.last; i++) if (seen(i) > seen(best) + 1) best = i;
    return best + 1;
  }

  /** Puts sheets where the view is, takes away the ones far from it, and notes the page the person is on. */
  function place() {
    if (problem || !count || !sheetWidth) return;
    const y0 = box.scrollTop;
    const y1 = y0 + Math.max(1, box.clientHeight);
    const first = firstAt(y0);
    view = { first, last: Math.max(first, startingBefore(y1 - 1)) };
    const from = Math.max(0, view.first - around());
    const to = Math.min(count - 1, view.last + around());
    for (const sheet of [...sheets.values()]) if (sheet.n - 1 < from || sheet.n - 1 > to) drop(sheet);
    for (let i = from; i <= to; i++) if (!sheets.has(i + 1)) mount(i + 1);
    const now = pin || mostInView(y0, y1);
    if (now !== current) {
      current = now;
      tell.page(now);
    }
    state();
  }

  /** "shown" when everything in view is drawn as sharp as it should be. */
  function state() {
    let value = "shown";
    if (problem) value = "failed";
    else if (!doc || !view) value = "loading";
    else {
      for (let i = view.first; i <= view.last && value === "shown"; i++) {
        const sheet = sheets.get(i + 1);
        if (!sheet || (!sheet.failed && sheet.px !== pixels(i))) value = "loading";
      }
      if (value === "shown" && sheets.get(current)?.failed) value = "failed";
    }
    if (box.dataset.state !== value) box.dataset.state = value;
    if (box.dataset.page !== String(current)) box.dataset.page = current;
  }

  /** The next page to draw: what is in view first, then what the person is scrolling towards. */
  function next() {
    if (!view) return 0;
    const order = [];
    for (let i = view.first; i <= view.last; i++) order.push(i + 1);
    for (let k = 1; k <= around(); k++) order.push(...(down ? [view.last + 1 + k, view.first + 1 - k] : [view.first + 1 - k, view.last + 1 + k]));
    return order.find((n) => sheets.has(n) && !sheets.get(n).failed && sheets.get(n).px !== pixels(n - 1)) || 0;
  }
  const inView = (n) => view && n - 1 >= view.first && n - 1 <= view.last;

  function stop() {
    if (!drawing) return;
    drawing.stopped = true;
    if (drawing.task) drawing.task.cancel();
  }
  /** Draws one page at a time. */
  function pump() {
    if (dead || problem || !doc || wait) return;
    const n = next();
    if (drawing) {
      // A page in view does not wait behind one that is only kept ready, nor behind a picture of the wrong size.
      const wrongSize = drawing.px && drawing.px !== pixels(drawing.n - 1);
      if (n && inView(n) && (wrongSize || (n !== drawing.n && !inView(drawing.n)))) stop();
      return;
    }
    clearTimeout(tidy);
    if (n) draw(n);
    // After a while without drawing, pdf.js lets go of what it kept for the pages passed.
    else tidy = setTimeout(() => !dead && !drawing && doc.cleanup(true).catch(() => {}), 10000);
  }
  /** Pictures wait until the scrolling or resizing has settled. */
  function pumpIn(ms) {
    clearTimeout(wait);
    wait = setTimeout(() => {
      wait = 0;
      pump();
    }, ms);
  }

  function measure(i, page) {
    if (known[i]) return;
    const { width: w, height: h } = page.getViewport({ scale: 1 });
    const ratio = h / w > 0 ? h / w : PAPER;
    const keep = anchor();
    let moved = Math.abs(ratios[i] - ratio) > 1e-4;
    known[i] = 1;
    ratios[i] = ratio;
    if (!measured) {
      // Until a page has been read, it is taken to be as large as the first one that was.
      measured = true;
      for (let k = 0; k < count; k++) {
        if (known[k] || ratios[k] === ratio) continue;
        ratios[k] = ratio;
        moved = true;
      }
    }
    if (moved) layout(keep);
  }

  async function draw(n) {
    const job = (drawing = { n, px: 0, task: null, stopped: false });
    let canvas = null;
    try {
      const page = await doc.getPage(n);
      if (job.stopped || dead) return;
      measure(n - 1, page);
      if (job.stopped || !sheets.has(n)) return;
      job.px = pixels(n - 1);
      const viewport = page.getViewport({ scale: job.px / page.getViewport({ scale: 1 }).width });
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      // Notes and marks someone made in the PDF are part of the picture. Nothing in it can be clicked.
      job.task = page.render({ canvas, viewport });
      await job.task.promise;
      const sheet = sheets.get(n);
      if (job.stopped || dead || !sheet) return;
      if (sheet.canvas) sheet.canvas.width = 0;
      sheet.el.replaceChildren(canvas);
      Object.assign(sheet, { canvas, px: job.px, failed: false });
      sheet.el.dataset.state = "drawn";
      canvas = null;
      page.cleanup();
    } catch (err) {
      const sheet = sheets.get(n);
      if (!job.stopped && !dead && sheet && !(err && err.name === "RenderingCancelledException")) {
        // One page that cannot be drawn says so on its sheet; the rest of the book stays.
        const note = document.createElement("p");
        note.textContent = t("bookFailed");
        sheet.el.replaceChildren(note);
        Object.assign(sheet, { canvas: null, failed: true });
        sheet.el.dataset.state = "failed";
      }
    } finally {
      if (canvas) canvas.width = 0;
      if (drawing === job) drawing = null;
      if (!dead) {
        state();
        pump();
      }
    }
  }

  function scrolled() {
    const y = box.scrollTop;
    // Moved away from where the app put it: the person scrolls.
    if (pin && Math.abs(y - topOf(pin)) > 1.5) pin = 0;
    const far = Math.abs(y - lastY) > box.clientHeight * 0.75;
    if (y !== lastY) down = y > lastY;
    lastY = y;
    place();
    // Flying through the book (the scroll bar pulled, a hard flick), pages on the way are not drawn.
    if (far) pumpIn(90);
    else pump();
  }

  function resized(inner) {
    const first = !sheetWidth;
    if (inner - 2 * PAD === width) return;
    width = inner - 2 * PAD;
    layout();
    // While the panel is dragged wider, the pictures stretch; they are drawn anew when it stops.
    if (first) pump();
    else pumpIn(140);
  }

  /** The book cannot be shown (any more): the pages go, and the panel says why. */
  function fail(kind) {
    if (dead || problem) return;
    problem = kind;
    stop();
    clearTimeout(wait);
    clearTimeout(tidy);
    for (const sheet of [...sheets.values()]) drop(sheet);
    run.style.width = run.style.height = "0";
    state();
    tell.problem(kind);
  }

  /** A sharper or coarser screen (the window moved to another display) needs new pictures. */
  function watchDensity() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const changed = () => {
      unwatch();
      if (dead) return;
      watchDensity();
      state();
      pumpIn(140);
    };
    query.addEventListener("change", changed);
    unwatch = () => query.removeEventListener("change", changed);
  }

  size(pageCount);
  box.addEventListener("scroll", scrolled, { passive: true });
  const observer = new ResizeObserver(([entry]) => !dead && resized(Math.floor(entry.contentRect.width)));
  observer.observe(box);
  watchDensity();
  state();
  const book = bookOf(hash);
  book.promise.then(
    (opened) => {
      if (dead || problem) return;
      doc = opened;
      if (doc.numPages !== count) {
        const keep = { pin: Math.min(pin || current, doc.numPages), x: 0.5 };
        size(doc.numPages);
        pin = keep.pin;
        tell.count(count);
        layout(keep);
      }
      place();
      pump();
    },
    (err) => fail(err && err.name === "PasswordException" ? "locked" : err && err.name === "InvalidPDFException" ? "damaged" : "failed"),
  );
  book.lost.then(() => fail("failed"));

  return {
    /** Scrolls to the top of page n. */
    go(n) {
      pin = Math.max(1, Math.min(count || Infinity, Math.round(n) || 1));
      current = pin;
      if (sheetWidth && !problem) {
        box.scrollTop = topOf(pin);
        lastY = box.scrollTop;
        place();
        pump();
      }
      state();
      return pin;
    },
    zoom(value) {
      if (value === zoom) return;
      zoom = value;
      stop();
      layout();
      pump();
    },
    destroy() {
      dead = true;
      box.removeEventListener("scroll", scrolled);
      observer.disconnect();
      unwatch();
      clearTimeout(wait);
      clearTimeout(tidy);
      stop();
      for (const sheet of [...sheets.values()]) drop(sheet);
    },
  };
}

/**
 * `page` is where the book should be open: when it changes, or when `jump` does (asking for
 * the same page again), the panel scrolls to the top of that page. `onPage(n)` tells which
 * page the person has scrolled to.
 */
export function Book({ material, page, onPage, jump }) {
  // Another book starts from scratch.
  return html`<${Pages} key=${material.hash} material=${material} page=${page} onPage=${onPage} jump=${jump} />`;
}

function Pages({ material, page, onPage, jump }) {
  const box = useRef(null);
  const run = useRef(null);
  const pages = useRef(null);
  const [last, setLast] = useState(material.pages);
  const want = Math.max(1, Math.min(last || 1, Math.round(page) || 1));
  const [at, setAt] = useState(want);
  const [zoom, setZoom] = useState(() => zooms.get(material.hash) || 1);
  const [problem, setProblem] = useState(null);

  // The page this panel reported last comes back as `page`: that is no request to jump there.
  const told = useRef(null);
  const asked = useRef(null);
  const todo = useRef(null);
  if (!asked.current || asked.current.jump !== jump || (asked.current.page !== want && want !== told.current)) todo.current = want;
  asked.current = { page: want, jump };
  const report = useRef(null);
  report.current = (n) => {
    told.current = n;
    setAt(n);
    if (onPage) onPage(n);
  };

  useEffect(() => {
    pages.current = showPages(box.current, run.current, material.hash, material.pages, {
      page: (n) => report.current(n),
      count: setLast,
      problem: setProblem,
      name: (n) => t("page", printed(material, n)),
    });
    return () => pages.current.destroy();
  }, []);
  useEffect(() => {
    if (todo.current === null) return;
    const n = pages.current.go(todo.current);
    todo.current = null;
    told.current = n;
    setAt(n);
  });

  const turn = (n) => report.current(pages.current.go(n));
  const step = (by) => {
    // (from what was set last, not from what was drawn last: two quick clicks are two steps)
    const value = ZOOMS[ZOOMS.indexOf(zooms.get(material.hash) || 1) + by];
    if (!value) return;
    zooms.set(material.hash, value);
    setZoom(value);
    pages.current.zoom(value);
  };
  const label = printed(material, at);
  return html`<section class="book">
    <header class="side-head">
      <strong>${material.title}</strong>
      ${!problem &&
      html`<span class="zoom">
          <button class="mini" aria-label=${say("bookZoomOut")} disabled=${zoom <= ZOOMS[0]} onClick=${() => step(-1)}><${Icon} name="minus" /></button>
          <small class="num">${Math.round(zoom * 100)}%</small>
          <button class="mini" aria-label=${say("bookZoomIn")} disabled=${zoom >= ZOOMS[ZOOMS.length - 1]} onClick=${() => step(1)}><${Icon} name="plus" /></button>
        </span>
        <span class="pager">
          <button class="mini" aria-label=${t("bookBack")} disabled=${at <= 1} onClick=${() => turn(at - 1)}><${Icon} name="back" /></button>
          <span class="num">${t("page", label)}${label !== at ? html` <small>${at}/${last}</small>` : html` <small>/ ${last}</small>`}</span>
          <button class="mini flip" aria-label=${t("bookOn")} disabled=${at >= last} onClick=${() => turn(at + 1)}><${Icon} name="back" /></button>
        </span>`}
    </header>
    <div class="book-page" ref=${box} data-state="loading" role="region" tabindex="0" aria-label=${material.title}>
      <div class="book-run" ref=${run}></div>
      ${problem && html`<p class="muted">${problem === "locked" ? say("bookLocked") : problem === "damaged" ? say("bookDamaged") : t("bookFailed")}</p>`}
    </div>
  </section>`;
}

// Writing in the book: pen, highlighter, text notes, eraser, undo and redo, on top of the pages
// ui/book.js draws. What is written is kept per page of the book (by the book's SHA-256) on this
// Mac only (src/ink.js): never in the PDF, never in a shared file.
//
// Each page has a layer of its own over its picture. It is as wide as the page and measured in
// the page's own units (10000 = the width of the page), so what is written stays where it was
// put at every zoom. The page is white paper in both themes, so the colours are the same in both.
//
// ui/book.js needs four things from here: `useInk` in its panel, `ink.mount(leaf, n)` for every
// page it puts on the screen, the toggle in its head and the tool bar under the pages.
import { html, useState, useEffect, useRef } from "./bits.js";
import { t } from "./i18n.js";

const api = window.aced;
const UNIT = 10000;
const SVG = "http://www.w3.org/2000/svg";
export const COLOURS = { pen: ["#1c1f26", "#1f5bd1", "#cf2f2a"], hl: ["#ffd43b", "#74de86", "#ff94c9"] };
const NAMES = { pen: [0, 1, 2], hl: [3, 4, 5] }; // inkColour(n)
const WIDTH = { pen: 20, hl: 150 }; // in units: about 1 and 8 points on an A4 page
const ERASE = 90; // how near the eraser has to come, in units
const TOOLS = ["pen", "hl", "text", "eraser"];

const books = new Map(); // hash -> the book's ink (see inkOf), while a panel shows the book
let writing = null; // ends the text note being written: writing(true) keeps it, writing(false) drops the change

/** One book's ink: loaded once, kept page by page; the history of changes for undo. */
function inkOf(hash) {
  if (books.has(hash)) return books.get(hash);
  const book = { hash, pages: new Map(), layers: new Map(), undo: [], redo: [], waiting: new Map(), listeners: new Set() };
  book.ready = api.inkLoad(hash).then(
    (all) => {
      for (const [key, page] of Object.entries(all || {})) {
        // (what was written before this came in goes on top of it)
        const n = Number(key);
        const now = book.pages.get(n);
        book.pages.set(n, now ? { s: [...page.s, ...now.s], n: [...page.n, ...now.n] } : page);
      }
      for (const layer of book.layers.values()) layer.draw();
    },
    () => {},
  );
  books.set(hash, book);
  return book;
}

const copyOf = (page) => (page ? structuredClone(page) : null);
const emptyPage = () => ({ s: [], n: [] });

/** Keeps a page soon (several strokes in a row are one write). */
function keep(book, n) {
  clearTimeout(book.waiting.get(n));
  book.waiting.set(
    n,
    setTimeout(() => {
      book.waiting.delete(n);
      api.inkSave(book.hash, n, book.pages.get(n) || null).catch(() => {});
    }, 350),
  );
}
function keepNow(book) {
  for (const [n, timer] of book.waiting) {
    clearTimeout(timer);
    api.inkSave(book.hash, n, book.pages.get(n) || null).catch(() => {});
  }
  book.waiting.clear();
}

/** Changes page n: `fn(page)` edits a copy; the change can be undone. */
function change(book, n, fn) {
  const before = copyOf(book.pages.get(n));
  const page = copyOf(book.pages.get(n)) || emptyPage();
  if (fn(page) === false) return;
  const after = page.s.length || page.n.length ? page : null;
  set(book, n, after);
  book.undo.push({ n, before, after: copyOf(after) });
  if (book.undo.length > 200) book.undo.shift();
  book.redo = [];
  tellAll(book);
}
function set(book, n, page) {
  if (page) book.pages.set(n, page);
  else book.pages.delete(n);
  keep(book, n);
  const layer = book.layers.get(n);
  if (layer) layer.draw();
}
function undo(book) {
  const step = book.undo.pop();
  if (!step) return;
  set(book, step.n, copyOf(step.before));
  book.redo.push(step);
  tellAll(book);
}
function redo(book) {
  const step = book.redo.pop();
  if (!step) return;
  set(book, step.n, copyOf(step.after));
  book.undo.push(step);
  tellAll(book);
}
const tellAll = (book) => book.listeners.forEach((fn) => fn());

// ------------------------------------------------------------ drawing

const round = (v) => Math.round(v);
/** A smooth line through the points (x, y, x, y …): curves through the middles between them. */
export function pathOf(p) {
  if (p.length <= 2) return `M${p[0]} ${p[1]}h0.1`;
  if (p.length <= 4) return `M${p[0]} ${p[1]}L${p[2]} ${p[3]}`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) d += `Q${p[i]} ${p[i + 1]} ${round((p[i] + p[i + 2]) / 2)} ${round((p[i + 1] + p[i + 3]) / 2)}`;
  return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
}

function strokeEl(s) {
  const el = document.createElementNS(SVG, "path");
  el.setAttribute("d", pathOf(s.p));
  el.setAttribute("stroke", COLOURS[s.t][s.c] || COLOURS[s.t][0]);
  el.setAttribute("stroke-width", s.w);
  return el;
}

/** How near a point comes to a stroke, in units. */
function near(s, x, y) {
  let best = Infinity;
  const p = s.p;
  for (let i = 0; i < p.length; i += 2) {
    const [ax, ay] = [p[i], p[i + 1]];
    const [bx, by] = i + 3 < p.length ? [p[i + 2], p[i + 3]] : [ax, ay];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const k = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + k * dx), y - (ay + k * dy)));
  }
  return best - s.w / 2;
}

/**
 * The ink layer of one page, inside its sheet (`leaf`). `ctl` says which tool is in the hand
 * (none: the layer lets everything through to the page).
 */
function layerOf(book, leaf, n, ctl) {
  const box = document.createElement("div");
  box.className = "ink";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${UNIT} ${UNIT}`);
  svg.setAttribute("aria-hidden", "true");
  const marks = document.createElementNS(SVG, "g");
  marks.setAttribute("class", "ink-hl");
  const lines = document.createElementNS(SVG, "g");
  lines.setAttribute("class", "ink-pen");
  svg.append(marks, lines);
  const notes = document.createElement("div");
  notes.className = "ink-notes";
  box.append(svg, notes);
  leaf.append(box);

  let editing = null; // { index, el } of the note being written

  const draw = () => {
    const page = book.pages.get(n) || emptyPage();
    marks.replaceChildren(...page.s.filter((s) => s.t === "hl").map(strokeEl));
    lines.replaceChildren(...page.s.filter((s) => s.t === "pen").map(strokeEl));
    notes.replaceChildren(
      ...page.n.map((note, i) => {
        if (editing && editing.index === i) return editing.el;
        const el = document.createElement("div");
        el.className = "ink-note";
        el.dataset.index = i;
        el.dataset.at = `${note.x},${note.y}`;
        el.style.left = `${note.x / 100}%`;
        el.style.top = `${note.y / 100}%`;
        el.textContent = note.text;
        return el;
      }),
    );
    if (editing && editing.index === -1) notes.append(editing.el);
  };

  /** The point under the pointer, in the page's units. */
  const at = (e) => {
    const r = box.getBoundingClientRect();
    return [round(((e.clientX - r.left) / r.width) * UNIT), round(((e.clientY - r.top) / r.width) * UNIT)];
  };

  /** A text note: a new one at (x, y), or the one at `spot` ("x,y") written anew. */
  function write(spot, x, y) {
    if (writing) writing(true);
    const page = book.pages.get(n) || emptyPage();
    // (found by its place, after the note before was kept: that may have taken one away)
    const index = spot ? page.n.findIndex((note) => `${note.x},${note.y}` === spot) : -1;
    const old = index >= 0 ? page.n[index] : { x, y, text: "" };
    const el = document.createElement("textarea");
    el.className = "ink-note editing";
    el.style.left = `${old.x / 100}%`;
    el.style.top = `${old.y / 100}%`;
    el.value = old.text;
    el.placeholder = t("inkNotePlaceholder");
    el.setAttribute("aria-label", t("inkText"));
    el.rows = 1;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    let done = false;
    const finish = (keepIt) => {
      if (done) return;
      done = true;
      editing = null;
      if (writing === finish) writing = null;
      const text = el.value.replace(/\u0000/g, "").trim().slice(0, 2000);
      if (keepIt && text !== old.text) {
        change(book, n, (p) => {
          if (index >= 0 && !p.n[index]) return false;
          if (index >= 0 && text) p.n[index] = { ...p.n[index], text };
          else if (index >= 0) p.n.splice(index, 1);
          else if (text) p.n.push({ x: old.x, y: old.y, text });
          else return false;
        });
      }
      draw();
    };
    el.addEventListener("input", fit);
    el.addEventListener("blur", () => finish(true));
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) {
        e.preventDefault();
        el.blur();
      }
    });
    editing = { index, el };
    writing = finish;
    draw();
    fit();
    el.focus();
  }

  let stroke = null; // the line being drawn: { s, el }
  let erased = null; // what one sweep of the eraser took: a copy of the page before, or null
  let last = null; // where the eraser was at the event before, in units
  const each = (e) => (e.getCoalescedEvents && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e]);

  function down(e) {
    const tool = ctl.tool;
    if (!tool || e.button !== 0) return;
    const target = e.target;
    if (target.closest && target.closest(".ink-note.editing")) return;
    e.preventDefault();
    const [x, y] = at(e);
    if (tool === "text") {
      const note = target.closest && target.closest(".ink-note");
      // (after the click that ended another note's writing)
      setTimeout(() => write(note ? note.dataset.at : null, x, y), 0);
      return;
    }
    leaf.setPointerCapture(e.pointerId);
    if (tool === "eraser") {
      erased = copyOf(book.pages.get(n));
      last = null;
      rub(e);
      return;
    }
    const s = { t: tool, c: ctl.colour[tool], w: WIDTH[tool], p: [x, y] };
    const el = strokeEl(s);
    (tool === "hl" ? marks : lines).append(el);
    stroke = { s, el };
  }
  /** A point of the line being drawn (points closer together than a bit of its width add nothing). */
  function extend(ev) {
    const p = stroke.s.p;
    const [x, y] = at(ev);
    if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < (stroke.s.t === "hl" ? 18 : 6)) return;
    if (p.length < 8000) p.push(x, y);
  }
  function move(e) {
    if (stroke) {
      for (const ev of each(e)) extend(ev);
      stroke.el.setAttribute("d", pathOf(stroke.s.p));
    } else if (erased !== null) for (const ev of each(e)) rub(ev);
  }
  /** The end of a line or of a sweep of the eraser (`letGo`: the pointer was let go there, not taken away). */
  function up(e, letGo) {
    if (stroke) {
      if (letGo) extend(e);
      const { s } = stroke;
      stroke = null;
      change(book, n, (p) => void p.s.push(s));
    } else if (erased !== null) {
      if (letGo) rub(e);
      const before = erased;
      erased = null;
      const after = copyOf(book.pages.get(n));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        book.undo.push({ n, before, after });
        book.redo = [];
        keep(book, n);
        tellAll(book);
      }
    }
  }
  /**
   * The eraser takes whole strokes and notes it touches: along the way from where it was at the
   * event before, so a quick sweep also takes a line it crossed between two events.
   */
  function rub(e) {
    if (erased === null) return;
    const [x, y] = at(e);
    const [fx, fy] = last || [x, y];
    last = [x, y];
    const page = book.pages.get(n);
    if (!page) return;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - fx, y - fy) / (ERASE / 2)));
    const hit = (st) => {
      for (let i = 0; i <= steps; i++) if (near(st, fx + ((x - fx) * i) / steps, fy + ((y - fy) * i) / steps) <= ERASE) return true;
      return false;
    };
    const s = page.s.filter((st) => !hit(st));
    // (what is under the pointer: while it is held, every event goes to the sheet)
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const note = under && leaf.contains(under) && under.closest(".ink-note:not(.editing)");
    const notesLeft = note ? page.n.filter((_, i) => i !== Number(note.dataset.index)) : page.n;
    if (s.length === page.s.length && notesLeft.length === page.n.length) return;
    const next = { s, n: notesLeft };
    if (next.s.length || next.n.length) book.pages.set(n, next);
    else book.pages.delete(n);
    draw();
  }

  leaf.addEventListener("pointerdown", down);
  leaf.addEventListener("pointermove", move);
  leaf.addEventListener("pointerup", (e) => up(e, true));
  leaf.addEventListener("pointercancel", (e) => up(e, false));
  draw();
  return { draw, box };
}

/**
 * The ink of the book in a panel. `box` is the panel's scrolling field (its data-ink says which
 * tool is in the hand, for the pointer's shape). Returns what ui/book.js puts in its place.
 */
export function useInk(hash, box) {
  const ctl = useRef(null);
  if (!ctl.current) ctl.current = { tool: null, colour: { pen: 0, hl: 0 } };
  const [, redraw] = useState(0);
  const [tool, setTool] = useState(null);
  // The same book's ink for as long as this panel shows it (the pages drawn hold on to it).
  const held = useRef(null);
  if (!held.current || held.current.hash !== hash) held.current = inkOf(hash);
  const book = held.current;

  useEffect(() => {
    // (a panel closing just now may have let go of it)
    books.set(hash, book);
    const listener = () => redraw((x) => x + 1);
    book.listeners.add(listener);
    return () => {
      book.listeners.delete(listener);
      keepNow(book);
      // The book closed: it is read anew next time (its ink may have gone with an exam meanwhile).
      if (!book.listeners.size && books.get(hash) === book) books.delete(hash);
    };
  }, [hash]);
  useEffect(() => {
    ctl.current.tool = tool;
    if (box.current) box.current.dataset.ink = tool || "";
    // Another tool, or done: a note being written is kept as it is.
    if (writing) writing(true);
    if (!tool) return;
    const key = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
      e.preventDefault();
      if (e.shiftKey) redo(book);
      else undo(book);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tool, hash]);

  const mount = (leaf, n) => {
    const layer = layerOf(book, leaf, n, ctl.current);
    book.layers.set(n, layer);
    // When ui/book.js takes the sheet away, the layer goes with it.
    new MutationObserver((_, watch) => {
      if (leaf.isConnected) return;
      watch.disconnect();
      if (book.layers.get(n) === layer) book.layers.delete(n);
    }).observe(leaf.parentNode || leaf, { childList: true });
  };

  const choose = (next) => setTool(next === tool ? null : next);
  const colour = (c) => {
    const kind = tool === "hl" ? "hl" : "pen";
    ctl.current.colour = { ...ctl.current.colour, [kind]: c };
    if (tool !== "pen" && tool !== "hl") setTool(kind);
    redraw((x) => x + 1);
  };
  const kind = tool === "hl" ? "hl" : "pen";

  const toggle = html`<button class=${"mini ink-toggle" + (tool ? " on" : "")} id="inkToggle" aria-pressed=${String(Boolean(tool))} title=${t("inkWrite")} aria-label=${t("inkWrite")} onClick=${() => setTool(tool ? null : "pen")}>
    <${Glyph} name="pen" size=${16} />
  </button>`;

  const bar = tool
    ? html`<div class="ink-bar view" role="toolbar" aria-label=${t("inkWrite")}>
        ${TOOLS.map(
          (id) => html`<button class="ink-tool" id=${"ink-" + id} aria-pressed=${String(tool === id)} title=${t(id === "hl" ? "inkMarker" : id === "pen" ? "inkPen" : id === "text" ? "inkText" : "inkEraser")} aria-label=${t(id === "hl" ? "inkMarker" : id === "pen" ? "inkPen" : id === "text" ? "inkText" : "inkEraser")} onClick=${() => choose(id)}>
            <${Glyph} name=${id} />
          </button>`,
        )}
        <span class="ink-sep" aria-hidden="true"></span>
        ${COLOURS[kind].map(
          (c, i) => html`<button class="ink-colour" aria-pressed=${String((tool === "pen" || tool === "hl") && ctl.current.colour[kind] === i)} title=${t("inkColour", NAMES[kind][i])} aria-label=${t("inkColour", NAMES[kind][i])} style=${{ "--c": c }} onClick=${() => colour(i)}><i></i></button>`,
        )}
        <span class="ink-sep" aria-hidden="true"></span>
        <button class="ink-tool" id="ink-undo" disabled=${!book.undo.length} title=${t("inkUndo")} aria-label=${t("inkUndo")} onClick=${() => undo(book)}><${Glyph} name="undo" /></button>
        <button class="ink-tool" id="ink-redo" disabled=${!book.redo.length} title=${t("inkRedo")} aria-label=${t("inkRedo")} onClick=${() => redo(book)}><${Glyph} name="redo" /></button>
        <button class="ink-done" id="ink-done" title=${t("inkPrivate")} onClick=${() => setTool(null)}>${t("inkDone")}</button>
      </div>`
    : null;

  return { mount, toggle, bar };
}

const GLYPHS = {
  pen: html`<path d="M5 19l1-4.3 9.7-9.7a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L9.3 18z" /><path d="M14.3 6.4l3.3 3.3" />`,
  hl: html`<path d="M8.6 14.4l-3.1 3.1V20h4.4l1.6-1.6" /><path d="M8.6 14.4l7.5-7.5a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8l-7.5 7.5z" /><path d="M13.5 21h6" />`,
  text: html`<path d="M6 6.5h12M12 6.5V18.5M9.3 18.5h5.4" />`,
  eraser: html`<path d="M9.5 19.5h10" /><path d="M4.7 15l8.6-8.6a2 2 0 0 1 2.8 0l3 3a2 2 0 0 1 0 2.8l-6.7 6.7a2.6 2.6 0 0 1-1.8.6H9.5a2.6 2.6 0 0 1-1.8-.8l-3-3a2 2 0 0 1 0-2.7z" /><path d="M9.6 10.1l5.3 5.3" />`,
  undo: html`<path d="M9 7.5L5 11.5l4 4" /><path d="M5.5 11.5H14a4.5 4.5 0 0 1 0 9h-2" />`,
  redo: html`<path d="M15 7.5l4 4-4 4" /><path d="M18.5 11.5H10a4.5 4.5 0 0 0 0 9h2" />`,
};
const Glyph = ({ name, size = 22 }) => html`<svg class="glyph" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name]}</svg>`;

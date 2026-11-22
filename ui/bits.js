// Small shared pieces: the lane, icons, and how numbers are written.
import { html, useState, useEffect } from "./vendor/htm-preact.js";
import { t, lang } from "./i18n.js";

export { html, render, useState, useEffect, useRef } from "./vendor/htm-preact.js";

const ICONS = {
  back: html`<path d="M10 3.5L5.5 8l4.5 4.5" />`,
  down: html`<path d="M3.5 6l4.5 4.5L12.5 6" />`,
  plus: html`<path d="M8 3.5v9M3.5 8h9" />`,
  open: html`<path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5L7.5 8.5" />`,
  drop: html`<path d="M8 2.5v8M4.8 7.3L8 10.5l3.2-3.2M3 13.5h10" />`,
  minus: html`<path d="M3.5 8h9" />`,
  check: html`<path d="M3.5 8.5l3 3 6-7" />`,
  x: html`<path d="M4 4l8 8M12 4l-8 8" />`,
  ask: html`<path d="M3 3.5h10v7H8l-3 2.5v-2.5H3z" />`,
  pencil: html`<path d="M3 13l.6-2.8L10.9 3l2.1 2.1-7.3 7.3L3 13z" />`,
  partly: html`<circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" />`,
  sliders: html`<path d="M2.5 5h5.5M12.5 5h1M2.5 11h1M8 11h5.5" /><circle cx="10.2" cy="5" r="1.8" /><circle cx="5.8" cy="11" r="1.8" />`,
  book: html`<path d="M8 4.6C6.6 3.6 4.7 3.3 2.5 3.5v8.6c2.2-.2 4.1.1 5.5 1.1 1.4-1 3.3-1.3 5.5-1.1V3.5C11.3 3.3 9.4 3.6 8 4.6zM8 4.6v8.6" />`,
};

export function Icon({ name, size = 16 }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** The lane: a track filled up to `p` (0..1) that ends in a finish post. */
export function Lane({ p, label }) {
  const clamped = Math.max(0, Math.min(1, p));
  return html`<div class="lane" role="img" aria-label=${label} style=${{ "--p": clamped }}>
    ${clamped > 0 && html`<span class="lane-fill"></span>`}
  </div>`;
}

/** A lane in pieces (days, steps, questions). `done` pieces are run, piece `now` is under way. */
export function Segs({ total, done, now = -1, post = true, label }) {
  return html`<div class="segs" role="img" aria-label=${label}>
    ${Array.from({ length: total }, (_, i) => html`<i class=${i < done ? "done" : i === now ? "now" : ""}></i>`)}
    ${post && html`<b class="post"></b>`}
  </div>`;
}

/**
 * What is running for an exam, said the same way wherever it shows: what it is doing, for how
 * long already, how long such a thing usually takes, and a way to stop it.
 */
export function RunNote({ run, onCancel, brief }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const text =
    run.stage === "summaries" || run.stage === "tasks" || run.stage === "confirm"
      ? t("stage_" + run.stage, (run.done || 0) + 1, run.total || 1)
      : run.stage !== "read"
      ? t("stage_" + run.stage)
      : run.phase === "recognise" && run.state === "preparing"
        ? t("preparing", run.title || "")
        : run.phase === "convert"
          ? t("converting", run.title || "")
          : t(run.phase === "recognise" ? "recognising" : "reading", run.title || "", run.done || 0, run.total || 0);
  if (brief) return html`<span class="run-brief"><span class="spinner" aria-hidden="true"></span>${text}</span>`;
  return html`<div class="running" role="status" data-kind=${run.kind}>
    <span class="spinner" aria-hidden="true"></span>
    <span class="run-text">
      <strong>${text}</strong>
      <small><span class="num">${clock}</span> · ${t("expect_" + run.kind)}</small>
    </span>
    ${onCancel && html`<button class="btn plain" id="cancelRun" onClick=${onCancel}>${t("cancel")}</button>`}
  </div>`;
}

export function Segmented({ value, options, onChange, label }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>
    ${options.map(
      ([id, text]) =>
        html`<button role="radio" aria-checked=${String(id === value)} onClick=${() => onChange(id)}>${text}</button>`,
    )}
  </div>`;
}

export function daysUntil(iso) {
  const day = new Date(iso + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((day - now) / 86400000);
}

export function isoInDays(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function minutes(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function grade(scale, value) {
  return scale === "pct" ? `${Math.round(value)}%` : Number(value).toFixed(1);
}

export const materialOf = (exam, id) => exam.materials.find((m) => m.id === id);

/** The number printed on a page of the book, which may differ from its position in the file. */
export function printed(material, page) {
  const n = page - ((material && material.offset) || 0);
  return n > 0 ? n : page;
}

/** Where a step sends the person: "4.2 Scheitelpunktform, p. 88–91" or "p. 92, exercises 4, 5 and 7". */
export function where(step, exam) {
  const m = materialOf(exam, step.material);
  if (step.kind === "read") return `${step.chapter ? step.chapter + ", " : ""}${t("pages", printed(m, step.from), printed(m, step.to))}`;
  if (step.kind === "solve") return `${t("page", printed(m, step.page))}, ${t("exercises", step.labels)}`;
  return step.questions ? t("questions", step.questions) : "";
}

/** The page of the file to open for a step, or null when there is nothing to open. */
export const firstPage = (step) => (step.kind === "read" ? step.from : step.kind === "solve" ? step.page : null);

const MODEL_NAMES = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-fable-5-2": "Claude Fable 5.2",
};
export const modelName = (id) => MODEL_NAMES[id] || id;

/** A token count, rounded so it reads as the estimate it is: 31,000 or 4,300 (31’000 in German). */
export const thousands = (n) => new Intl.NumberFormat(lang() === "de" ? "de-CH" : "en-US").format(n >= 10000 ? Math.round(n / 1000) * 1000 : Math.round(n / 100) * 100);
export const money = (usd) => (usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

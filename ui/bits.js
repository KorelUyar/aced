// Small shared pieces: the lane, icons, and how numbers are written.
import { html } from "./vendor/htm-preact.js";
import { t } from "./i18n.js";

export { html, render, useState, useEffect, useRef } from "./vendor/htm-preact.js";

const ICONS = {
  back: html`<path d="M10 3.5L5.5 8l4.5 4.5" />`,
  down: html`<path d="M3.5 6l4.5 4.5L12.5 6" />`,
  plus: html`<path d="M8 3.5v9M3.5 8h9" />`,
  minus: html`<path d="M3.5 8h9" />`,
  check: html`<path d="M3.5 8.5l3 3 6-7" />`,
  x: html`<path d="M4 4l8 8M12 4l-8 8" />`,
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

/** Where a step sends the person: "chapter 4.2, p. 88–91" or "p. 92, exercises 4, 5 and 7". */
export function where(step) {
  if (step.kind === "read") return `${t("chapter", step.chapter)}, ${t("pages", step.from, step.to)}`;
  if (step.kind === "solve") return `${t("page", step.page)}, ${t("exercises", step.numbers)}`;
  return t("questions", step.questions);
}

export const firstPage = (step) => (step.kind === "read" ? step.from : step.kind === "solve" ? step.page : null);

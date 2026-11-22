// An exam as one page to share: the plan with its pages and exercises, the learning objectives
// and the formula sheet. The same page is printed to the PDF (A4) and saved as the web page.
// It is self-contained (its typeface and formulas are inside it; it loads nothing), works on a
// phone, follows light and dark, and carries nothing of the person: no ticks, no results, no
// settings, no file paths. Every text in it is the text it is, never HTML.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const planner = require("./planner");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const WORDS = {
  en: {
    kind: "Exam plan",
    meta: (date, perDay, target) => [date, perDay, target].filter(Boolean).join(" · "),
    perDay: (m) => `${m} min a day`,
    total: (m) => `${Math.round(m / 60)} h in total`,
    target: (g) => `target ${g}`,
    objectives: "Learning objectives",
    plan: "Plan",
    planNote: "In the order to work through. Page numbers are those printed in the book.",
    pagesIn: (titles) => `Pages refer to ${titles}.`,
    share: (p) => `${Math.round(p * 100)}% of the points`,
    read: "Read",
    solve: "Solve",
    pages: (a, b) => (a === b ? `p. ${a}` : `p. ${a}–${b}`),
    page: (a) => `p. ${a}`,
    questions: (n) => `${n} questions, in Aced`,
    summary: "Summary",
    example: "Example",
    result: "Result:",
    todo: "What to do",
    details: (pages) => `Details in the book: ${pages}`,
    min: (m) => `${m} min`,
    formulas: "Formula sheet",
    footer: "Made with Aced · uyarid.com",
    dateLocale: "en-GB",
  },
  de: {
    kind: "Prüfungsplan",
    meta: (date, perDay, target) => [date, perDay, target].filter(Boolean).join(" · "),
    perDay: (m) => `${m} Min. pro Tag`,
    total: (m) => `${Math.round(m / 60)} Std. insgesamt`,
    target: (g) => `Ziel ${g}`,
    objectives: "Lernziele",
    plan: "Plan",
    planNote: "In der Reihenfolge zum Durcharbeiten. Seitenzahlen wie im Buch gedruckt.",
    pagesIn: (titles) => `Die Seiten beziehen sich auf ${titles}.`,
    share: (p) => `${Math.round(p * 100)} % der Punkte`,
    read: "Lesen",
    solve: "Lösen",
    pages: (a, b) => (a === b ? `S. ${a}` : `S. ${a}–${b}`),
    page: (a) => `S. ${a}`,
    questions: (n) => `${n} Fragen, in Aced`,
    summary: "Zusammenfassung",
    example: "Beispiel",
    result: "Ergebnis:",
    todo: "Was du tun musst",
    details: (pages) => `Details im Buch: ${pages}`,
    min: (m) => `${m} Min.`,
    formulas: "Formelblatt",
    footer: "Gemacht mit Aced · uyarid.com",
    dateLocale: "de-CH",
  },
};

let katex = null;
async function tex() {
  if (!katex) katex = (await import(pathToFileURL(path.join(__dirname, "..", "ui", "vendor", "katex", "katex.mjs")).href)).default;
  return katex;
}

const MATH = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^\n$]+?)(?<!\s)\$/g;

/** Text with its formulas: the formulas as MathML (KaTeX, nothing trusted), the rest escaped. */
function rich(k, text) {
  let out = "";
  let last = 0;
  const source = String(text ?? "");
  for (const m of source.matchAll(MATH)) {
    out += esc(source.slice(last, m.index));
    out += formula(k, m[1] ?? m[2], m[1] !== undefined) ?? esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(source.slice(last));
}

function formula(k, latex, display) {
  try {
    return k.renderToString(latex, { displayMode: display, output: "mathml", throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 200 });
  } catch {
    return null;
  }
}

const grade = (scale, value) => (scale === "pct" ? `${Math.round(value)}%` : Number(value).toFixed(1));
const printedPage = (m, page) => {
  const n = page - ((m && m.offset) || 0);
  return n > 0 ? n : page;
};

const STYLE = (font) => `
@font-face { font-family: Archivo; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
:root { --paper: #f4f5f7; --sheet: #fff; --ink: #14161b; --text: #2b2f37; --muted: #5c6370; --rule: #dfe2e8; --track: #e94b12; --glow: #fdebe3; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --paper: #15171c; --sheet: #1d2027; --ink: #f3f4f7; --text: #d3d6dd; --muted: #9aa1ad; --rule: #2c3039; --track: #ff6a33; --glow: #2b1a13; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--text); font: 400 16px/1.5 Archivo, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 760px; margin: 0 auto; padding: 28px 16px 72px; }
.kind { font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--track); margin: 0 0 6px; }
h1 { font: italic 760 30px/1.12 Archivo, sans-serif; font-stretch: 112%; color: var(--ink); margin: 0 0 8px; letter-spacing: -.01em; }
.meta { color: var(--muted); margin: 0 0 14px; }
.approach { margin: 0 0 6px; color: var(--text); }
.books { color: var(--muted); font-size: 14px; margin: 0; }
section { margin-top: 30px; }
h2 { font: 650 19px/1.25 Archivo, sans-serif; color: var(--ink); margin: 0 0 10px; }
.note { color: var(--muted); font-size: 14px; margin: -4px 0 12px; }
ol.objectives { margin: 0; padding-left: 22px; }
ol.objectives li { margin: 0 0 4px; }
.topic { background: var(--sheet); border: 1px solid var(--rule); border-radius: 14px; padding: 14px 16px 10px; margin: 0 0 12px; }
.topic h3, .topic .why { break-after: avoid; }
ul.steps li { break-inside: avoid; }
.topic h3 { font: 650 17px/1.3 Archivo, sans-serif; color: var(--ink); margin: 0; display: flex; gap: 10px; align-items: baseline; }
.topic h3 .n { color: var(--track); font-variant-numeric: tabular-nums; }
.topic .weight { margin-left: auto; font: 500 13px/1 Archivo, sans-serif; color: var(--muted); white-space: nowrap; }
.topic .why { color: var(--muted); font-size: 14px; margin: 4px 0 8px; }
ul.steps { list-style: none; margin: 0; padding: 0; }
.summary { margin: 6px 0 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--rule); font-size: 14px; }
.summary .label { margin: 8px 0 4px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
.summary .label:first-child { margin-top: 0; }
.summary ul, .summary ol { margin: 0; padding-left: 20px; }
.summary li { margin: 3px 0; }
.summary .example p { margin: 4px 0; }
.summary .details { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
ul.steps li { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--rule); }
ul.steps li:first-child { border-top: 0; }
.box { flex: none; width: 15px; height: 15px; border: 1.6px solid var(--muted); border-radius: 4px; transform: translateY(2px); }
.what { flex: 1; min-width: 0; }
.what b { color: var(--ink); font-weight: 600; }
.what small { color: var(--muted); font-size: 13px; }
.min { color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.formulas .group { margin: 0 0 18px; break-inside: avoid; }
.formulas h3 { font: 600 15px/1.3 Archivo, sans-serif; color: var(--muted); margin: 0 0 8px; }
.formula { background: var(--sheet); border: 1px solid var(--rule); border-radius: 12px; padding: 12px 14px; margin: 0 0 8px; break-inside: avoid; }
.formula .name { display: flex; align-items: baseline; gap: 8px; font-weight: 600; color: var(--ink); }
.formula .name .ref { margin-left: auto; font: 500 13px Archivo, sans-serif; color: var(--track); }
.formula .tex { font-size: 20px; margin: 8px 0 4px; overflow-x: auto; color: var(--ink); }
.formula p { margin: 0; color: var(--muted); font-size: 14px; }
math { font-size: 1.05em; }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; text-align: center; }
@media (min-width: 700px) { main { padding: 44px 32px 80px; } h1 { font-size: 36px; } }
@page { size: A4; margin: 16mm 15mm 18mm; }
@media print {
  :root { --paper: #fff; --sheet: #fff; --ink: #14161b; --text: #2b2f37; --muted: #5c6370; --rule: #dfe2e8; --track: #e94b12; }
  body { font-size: 10.5pt; background: #fff; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 24pt; }
  .topic { border-radius: 8px; padding: 9px 12px 6px; break-inside: avoid; }
  .formulas { break-before: page; }
  footer { display: none; }
}
`;

/**
 * The page. `exam` as the store keeps it; `lang` "en" or "de". Resolves to the HTML. Only what
 * the plan needs is taken from the exam: its name, date, time and target, the strategy (topics,
 * steps, objectives) and the formula sheet. Ticks, results, answers and settings never are.
 */
async function examPage(exam, { lang = "en" } = {}) {
  const w = WORDS[lang] || WORDS.en;
  const k = await tex();
  const font = fs.readFileSync(path.join(__dirname, "..", "ui", "vendor", "archivo.woff2")).toString("base64");
  const s = exam.strategy || { topics: [], objectives: [] };
  const material = (id) => exam.materials.find((m) => m.id === id);
  const date = new Intl.DateTimeFormat(w.dateLocale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(exam.date + "T12:00:00"));
  const time = exam.time && exam.time.mode === "total" ? w.total(exam.time.minutes) : w.perDay((exam.time && exam.time.minutes) || 0);
  const books = [...new Set(s.topics.flatMap((t) => t.steps.map((st) => st.material)).filter(Boolean))].map(material).filter((m) => m && m.type === "pdf");

  const step = (st) => {
    const m = material(st.material);
    if (st.kind === "read") return `<li><span class="box"></span><span class="what"><b>${esc(w.read)} ${esc(w.pages(printedPage(m, st.from), printedPage(m, st.to)))}</b>${st.chapter ? ` <small>${esc(st.chapter)}</small>` : ""}</span><span class="min">${esc(w.min(st.minutes))}</span></li>`;
    if (st.kind === "solve") return `<li><span class="box"></span><span class="what"><b>${esc(w.solve)} ${esc(w.page(printedPage(m, st.page)))}: ${esc(st.labels.join(", "))}</b></span><span class="min">${esc(w.min(st.minutes))}</span></li>`;
    return `<li><span class="box"></span><span class="what">${esc(w.questions(st.questions || 4))}</span><span class="min">${esc(w.min(st.minutes || 10))}</span></li>`;
  };
  // A topic's summary, as in the app: the core of its pages, an example, what to do, where the details are.
  const summaryOf = (t) => {
    const sm = t.summary;
    if (!sm || !sm.core || !sm.core.length) return "";
    const ex = sm.example && sm.example.task ? `<div class="example"><p class="label">${esc(w.example)}</p><p>${rich(k, sm.example.task)}</p><ol>${(sm.example.steps || []).map((x) => `<li>${rich(k, x)}</li>`).join("")}</ol><p><b>${esc(w.result)}</b> ${rich(k, sm.example.result)}</p></div>` : "";
    const todo = sm.todo && sm.todo.length ? `<p class="label">${esc(w.todo)}</p><ol>${sm.todo.map((x) => `<li>${rich(k, x)}</li>`).join("")}</ol>` : "";
    const pages = (sm.pages || []).map((p) => w.pages(printedPage(material(p.material), p.from), printedPage(material(p.material), p.to)) + (p.what ? ` (${p.what})` : "")).join(", ");
    return `<div class="summary"><p class="label">${esc(w.summary)}</p><ul>${sm.core.map((x) => `<li>${rich(k, x)}</li>`).join("")}</ul>${ex}${todo}${pages ? `<p class="details">${esc(w.details(pages))}</p>` : ""}</div>`;
  };
  // The steps by the exam's pace, as a friend starts them (nothing ticked): the summary is shown
  // above them, so it is not a step of its own here.
  const stepsOf = (t) => planner.workOf(t, exam.pace, {}, {}).filter((st) => st.kind !== "summary");
  const topics = s.topics
    .map((t, i) => `<div class="topic"><h3><span class="n">${i + 1}</span><span>${esc(t.title)}</span>${t.share ? `<span class="weight">${esc(w.share(t.share))}</span>` : ""}</h3>${t.why ? `<p class="why">${rich(k, t.why)}</p>` : ""}${summaryOf(t)}<ul class="steps">${stepsOf(t).map(step).join("")}</ul></div>`)
    .join("");
  const sheet = (exam.formulas || [])
    .filter((g) => g.formulas && g.formulas.length)
    .map((g) => {
      const topic = s.topics.find((t) => t.id === g.topicId);
      const items = g.formulas
        .map((f) => {
          const m = material(f.material);
          return `<div class="formula"><div class="name"><span>${esc(f.name)}</span>${f.page ? `<span class="ref">${esc(w.page(printedPage(m, f.page)))}</span>` : ""}</div><div class="tex">${formula(k, f.latex, true) ?? esc(f.latex)}</div>${f.note ? `<p>${rich(k, f.note)}</p>` : ""}</div>`;
        })
        .join("");
      return `<div class="group">${topic ? `<h3>${esc(topic.title)}</h3>` : ""}${items}</div>`;
    })
    .join("");
  const body = `<main>
<p class="kind">${esc(w.kind)}</p>
<h1>${esc(exam.name)}</h1>
<p class="meta">${esc(w.meta(date, time, w.target(grade(exam.scale, exam.target))))}</p>
${s.approach ? `<p class="approach">${rich(k, s.approach)}</p>` : ""}
${books.length ? `<p class="books">${esc(w.pagesIn(books.map((b) => `«${b.title}»`).join(", ")))}</p>` : ""}
${s.objectives && s.objectives.length ? `<section><h2>${esc(w.objectives)}</h2><ol class="objectives">${s.objectives.map((o) => `<li>${rich(k, o)}</li>`).join("")}</ol></section>` : ""}
<section><h2>${esc(w.plan)}</h2><p class="note">${esc(w.planNote)}</p>${topics}</section>
${sheet ? `<section class="formulas"><h2>${esc(w.formulas)}</h2>${sheet}</section>` : ""}
<footer>${esc(w.footer)}</footer>
</main>`;
  return `<!doctype html><html lang="${lang === "de" ? "de" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><title>${esc(exam.name)}</title><style>${STYLE(font)}</style></head><body>${body}</body></html>`;
}

/** The line at the foot of every page of the PDF. */
const footerOf = (lang) => (WORDS[lang] || WORDS.en).footer;

module.exports = { examPage, footerOf };

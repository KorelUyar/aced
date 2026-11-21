// One exam on one screen: the way to the grade as a checklist (what to read, which exercises
// to solve, with pages and numbers), how much of it is done, and beside it the book, the
// formula sheet or the helper.
import { html, useState, useEffect, useRef, Icon, Lane, daysUntil, minutes, grade, materialOf, printed, firstPage } from "./bits.js";
import { t, longDate, errorText } from "./i18n.js";
import { Rich } from "./rich.js";
import { Book } from "./book.js";
import { Problem } from "./claude.js";

const api = window.spurt;
export const PANELS = ["book", "formulas", "helper"];

const work = (topic) => topic.steps.filter((s) => s.kind !== "quiz");

/** "Read p. 392–396" or "Solve p. 405: 7, 9, 13 and 27": what a step asks for, with its place in the book. */
function stepText(step, exam) {
  const m = materialOf(exam, step.material);
  if (step.kind === "read") return [t("doRead"), t("pages", printed(m, step.from), printed(m, step.to)), step.chapter];
  return [t("doSolve"), `${t("page", printed(m, step.page))}: ${step.labels.join(", ")}`, ""];
}

export function Path({ exam, panel, setPanel, app }) {
  const s = exam.strategy;
  // What the time does not allow is left out (and named at the end). What stays is done in the
  // book's own order, because a later chapter leans on the earlier one.
  const out = new Set(exam.plan.dropped.map((d) => d.topicId));
  const topics = s.topics.filter((x) => !out.has(x.id)).sort((a, b) => a.order - b.order);
  const all = topics.flatMap((topic) => work(topic).map((step) => ({ topic, step })));
  const done = (step) => Boolean(exam.done[step.id]);
  const total = all.reduce((sum, x) => sum + x.step.minutes, 0) || 1;
  const percent = Math.round((all.filter((x) => done(x.step)).reduce((sum, x) => sum + x.step.minutes, 0) / total) * 100);
  const next = all.find((x) => !done(x.step));
  // Today's share: the next steps, as far as the minutes the plan gives today reach.
  const today = new Set();
  let left = exam.plan.days[0].tasks.filter((task) => !task.done).reduce((sum, task) => sum + task.minutes, 0);
  for (const x of all) {
    if (done(x.step)) continue;
    if (left <= 0 || (today.size && x.step.minutes > left)) break;
    today.add(x.step.id);
    left -= x.step.minutes;
  }
  const todayOpen = all.filter((x) => today.has(x.step.id));
  const todayEnd = todayOpen.length && todayOpen.length < all.filter((x) => !done(x.step)).length ? todayOpen[todayOpen.length - 1].step.id : null;
  const [pre, n, post] = t("days", daysUntil(exam.date));
  const [opened, setOpened] = useState(() => new Set()); // finished topics the person has unfolded again

  const first = next ? next.step : all[0] && all[0].step;
  const [at, setAt] = useState({ material: first && first.material, page: first ? firstPage(first) : 1 });
  const [split, setSplit] = useState(0.44);
  const [busy, setBusy] = useState(null);
  // What was asked stays while the panel shows the book or the formulas in between.
  const [talk, setTalk] = useState([]); // { question, answer?, pages?, error? }
  const [asking, setAsking] = useState(false);
  const grid = useRef(null);
  const show = (materialId, page) => {
    setAt({ material: materialId, page });
    setPanel("book");
  };
  const tick = (step) => {
    setBusy(step.id);
    api.taskDone(exam.id, step.id).then(app.putExam, app.fail).finally(() => setBusy(null));
  };
  const drag = (e) => {
    e.preventDefault();
    const box = grid.current.getBoundingClientRect();
    const move = (m) => setSplit(Math.max(0.3, Math.min(0.7, (m.clientX - box.left) / box.width)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const book = materialOf(exam, at.material) || exam.materials.find((m) => m.type === "pdf");
  // The step that is up is in view when the exam opens.
  useEffect(() => {
    const now = grid.current.querySelector(".step.now");
    if (now) now.scrollIntoView({ block: "nearest" });
  }, []);
  let chapter = null; // a chapter is named where it starts, not on every line

  return html`<main class=${"path" + (panel ? "" : " alone")} ref=${grid} style=${{ "--split": split }}>
    <div class="plan">
      <header class="path-head">
        <div class="percent" role="img" aria-label=${t("planDone", percent)}>
          <b>${percent}</b>
          <span><i>%</i><small>${t("doneWord")}</small></span>
        </div>
        <div class="path-title">
          <h1>${exam.name}</h1>
          <p>${longDate(exam.date, "short")}, ${[pre, n, post].filter((x) => x !== "").join(" ")}, ${t("target", grade(exam.scale, exam.target))}</p>
        </div>
        <${Lane} p=${percent / 100} label=${t("planDone", percent)} />
        <p class="path-now">
          ${todayOpen.length ? t("todayLeft", todayOpen.length, minutes(todayOpen.reduce((sum, x) => sum + x.step.minutes, 0))) : t(next ? "todayDone" : "pathDone")}
        </p>
      </header>

      <ol class="route">
        ${topics.map((topic) => {
          const steps = work(topic);
          const finished = steps.filter(done).length;
          const over = finished === steps.length;
          const folded = over && !opened.has(topic.id);
          const current = next && next.topic.id === topic.id;
          const must = topic.objectives.map((i) => s.objectives[i]).filter(Boolean);
          const toggle = () =>
            setOpened((old) => {
              const set = new Set(old);
              set.has(topic.id) ? set.delete(topic.id) : set.add(topic.id);
              return set;
            });
          return html`<li class=${"stage" + (over ? " done" : "") + (current ? " current" : "") + (folded ? " folded" : "")} key=${topic.id}>
            <header>
              <h2>${over ? html`<button aria-expanded=${String(!folded)} onClick=${toggle}>${topic.title}</button>` : topic.title}</h2>
              <span class="count num">${over && html`<${Icon} name="check" size=${14} />`}${finished}/${steps.length}</span>
            </header>
            ${!folded &&
            must.length > 0 &&
            (current
              ? html`<div class="can">
                  <span class="can-label">${t("mustCan")}</span>
                  <ul>
                    ${must.map((x) => html`<li><${Rich} text=${x} /></li>`)}
                  </ul>
                </div>`
              : html`<p class="can short"><${Rich} text=${must.join(" ")} /></p>`)}
            ${!folded &&
            html`<ul class="worklist">
              ${steps.map((step) => {
                const [verb, place, inChapter] = stepText(step, exam);
                const named = inChapter && inChapter !== chapter ? inChapter : "";
                if (inChapter) chapter = inChapter;
                const isNext = next && next.step.id === step.id;
                const later = !done(step) && !isNext && !today.has(step.id);
                const row = html`<li class=${"step" + (done(step) ? " done" : "") + (isNext ? " now" : "") + (later ? " later" : "")} key=${step.id}>
                  <button class="mark" role="checkbox" aria-checked=${String(done(step))} aria-label=${`${verb} ${place}`} disabled=${done(step) || busy === step.id} onClick=${() => tick(step)}>
                    ${done(step) && html`<${Icon} name="check" size=${14} />`}
                  </button>
                  <button class="jump" onClick=${() => show(step.material, firstPage(step))}>
                    <span><b>${verb}</b> ${place}</span>
                    ${named && html`<small>${named}</small>`}
                  </button>
                  <span class="min num">${minutes(step.minutes)}</span>
                </li>`;
                // Where today's share ends: one line across the list, like the finish of a lap.
                return step.id === todayEnd ? [row, html`<li class="day-end" key="day-end"><span>${t("todayEnd")}</span></li>`] : row;
              })}
            </ul>`}
          </li>`;
        })}
        <li class="stage final">
          <header><h2>${t("finalExam")}</h2></header>
          <p class="can">${t("finalText")}</p>
        </li>
      </ol>
      ${exam.plan.dropped.length > 0 && html`<p class="left-out">${t("leftOut", exam.plan.dropped.length)}: ${exam.plan.dropped.map((d) => d.title).join(", ")}.</p>`}
    </div>

    ${panel &&
    html`<div class="divider" role="separator" aria-orientation="vertical" onPointerDown=${drag}></div>
      <aside class="side">
        ${panel === "book" && book && html`<${Book} material=${book} page=${at.page} onPage=${(page) => setAt({ material: book.id, page })} />`}
        ${panel === "formulas" && html`<${Formulas} exam=${exam} topics=${topics} app=${app} />`}
        ${panel === "helper" && html`<${Helper} exam=${exam} next=${next} show=${show} talk=${talk} setTalk=${setTalk} busy=${asking} setBusy=${setAsking} />`}
      </aside>`}
  </main>`;
}

function Formulas({ exam, topics, app }) {
  const [groups, setGroups] = useState(exam.formulas || null);
  const [error, setError] = useState(null);
  const load = () => {
    setError(null);
    api.formulas(exam.id).then(setGroups, setError);
  };
  // With Claude Code the sheet is simply written. With a key it costs money, so the person starts it.
  const paid = app.ai.provider !== "claudeCode";
  const [asked, setAsked] = useState(!paid);
  useEffect(() => {
    if (!groups && asked) load();
  }, [asked]);
  const title = (id) => (exam.strategy.topics.find((x) => x.id === id) || {}).title;
  return html`<section class="sheet-panel">
    <header class="side-head"><strong>${t("formulaSheet")}</strong></header>
    <div class="side-body">
      ${error && html`<${Problem} error=${error} onRetry=${load} toSettings=${() => app.nav({ name: "settings", id: exam.id, from: { name: "exam", id: exam.id } })} />`}
      ${!groups &&
      !asked &&
      html`<div class="ideas">
        <p class="muted">${t("formulasPaid")}</p>
        <button class="btn primary" onClick=${() => setAsked(true)}>${t("formulasWrite")}</button>
      </div>`}
      ${!groups && asked && !error && html`<div class="running"><span class="spinner" aria-hidden="true"></span><span>${t("formulasWriting")}</span></div>`}
      ${groups && !groups.length && html`<p class="muted">${t("formulasNone")}</p>`}
      ${groups &&
      groups.map(
        (group) =>
          html`<section class="formulas" key=${group.topicId}>
            <h3>${title(group.topicId)}</h3>
            ${group.formulas.map(
              (f) =>
                html`<div class="formula">
                  <span class="formula-name">${f.name}</span>
                  <div class="formula-tex"><${Rich} text=${"$$" + f.latex + "$$"} /></div>
                  ${f.note && html`<p><${Rich} text=${f.note} /></p>`}
                </div>`,
            )}
          </section>`,
      )}
      ${groups && groups.length > 0 && html`<p class="sheet-note">${t("formulasNote")}</p>`}
    </div>
  </section>`;
}

function Helper({ exam, next, show, talk, setTalk, busy, setBusy }) {
  const [text, setText] = useState("");
  const end = useRef(null);
  const ask = (question) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setText("");
    setTalk((old) => [...old, { question }]);
    api
      .help(exam.id, question)
      .then(
        (reply) => setTalk((old) => old.map((x, i) => (i === old.length - 1 ? { ...x, ...reply } : x))),
        (error) => setTalk((old) => old.map((x, i) => (i === old.length - 1 ? { ...x, error } : x))),
      )
      .finally(() => setBusy(false));
  };
  useEffect(() => end.current && end.current.scrollIntoView({ block: "end" }), [talk, busy]);
  const ideas = [next ? t("askExercises", next.topic.title) : null, t("askStart")].filter(Boolean);
  return html`<section class="helper">
    <header class="side-head"><strong>${t("helper")}</strong></header>
    <div class="side-body talk">
      ${!talk.length &&
      html`<div class="ideas">
        <p class="muted">${t("helperLead")}</p>
        ${ideas.map((idea) => html`<button class="idea" onClick=${() => ask(idea)}>${idea}</button>`)}
      </div>`}
      ${talk.map(
        (x) =>
          html`<div class="turn">
            <p class="asked">${x.question}</p>
            ${x.error && html`<${Problem} error=${x.error} onRetry=${() => ask(x.question)} />`}
            ${x.answer &&
            html`<div class="answered">
              <p><${Rich} text=${x.answer} /></p>
              ${x.pages.length > 0 &&
              html`<div class="page-links">
                ${x.pages.map(
                  (p) =>
                    html`<button class="page-link" onClick=${() => show(p.material, p.page)}>
                      <b>${t("page", printed(materialOf(exam, p.material), p.page))}</b> ${p.what}
                    </button>`,
                )}
              </div>`}
            </div>`}
            ${!x.answer && !x.error && html`<div class="running"><span class="spinner" aria-hidden="true"></span><span>${t("helperThinking")}</span></div>`}
          </div>`,
      )}
      <div ref=${end}></div>
    </div>
    <form
      class="ask"
      onSubmit=${(e) => {
        e.preventDefault();
        ask(text);
      }}
    >
      <input class="field" value=${text} placeholder=${t("helperPlaceholder")} aria-label=${t("helperPlaceholder")} onInput=${(e) => setText(e.target.value)} />
      <button class="btn primary" disabled=${busy || !text.trim()}>${t("helperAsk")}</button>
    </form>
  </section>`;
}

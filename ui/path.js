// One exam on one screen: how much of the plan is done, then the plan as one checklist (what
// to read, which exercises to solve, with pages and numbers), and beside it the book or the
// formula sheet. The helper opens over the plan, so the book stays where it is.
import { html, useState, useEffect, useRef, Icon, Lane, RunNote, daysUntil, minutes, grade, materialOf, printed, firstPage } from "./bits.js";
import { t, longDate, errorCode } from "./i18n.js";
import { Rich } from "./rich.js";
import { Book } from "./book.js";
import { Problem } from "./claude.js";

const api = window.spurt;
export const PANELS = ["book", "formulas"];

/** "Read p. 392–396" or "Solve p. 405: 7, 9, 13": what a step asks for, with its place in the book. */
function stepText(step, exam) {
  const m = materialOf(exam, step.material);
  if (step.kind === "read") return [t("doRead"), step.from === step.to ? t("page", printed(m, step.from)) : t("pages", printed(m, step.from), printed(m, step.to)), step.chapter];
  if (step.kind === "solve") return [t(step.repeat ? "doSolveAgain" : "doSolve"), `${t("page", printed(m, step.page))}: ${step.labels.join(", ")}`, ""];
  return [t("doAnswer"), t("questionsCount", step.questions || 4), ""];
}

export function Path({ exam, run, panel, setPanel, helper, setHelper, talk, ask, app }) {
  const s = exam.strategy;
  const plan = exam.plan;
  const tasks = plan.stages.flatMap((stage) => stage.tasks);
  const next = tasks.find((task) => task.id === plan.next) || null;
  const [pre, n, post] = t("days", daysUntil(exam.date));

  const first = (next && firstPage(next.step) ? next : tasks.find((task) => firstPage(task.step))) || null;
  // Where the book is open. `jump` counts up so that asking for the same page again scrolls back to it.
  const [at, setAt] = useState({ material: first && first.step.material, page: first ? firstPage(first.step) : 1, jump: 0 });
  const [split, setSplit] = useState(0.44);
  const [busy, setBusy] = useState(null);
  const [opened, setOpened] = useState(() => new Set()); // finished topics the person has unfolded again
  const [sheetError, setSheetError] = useState(null);
  const grid = useRef(null);
  const asked = useRef(false);

  const show = (materialId, page) => {
    if (!materialOf(exam, materialId) || materialOf(exam, materialId).type !== "pdf") return app.notify(t("noBookHere"));
    setAt((old) => ({ material: materialId, page, jump: old.jump + 1 }));
    setPanel("book");
  };
  // A tick is a switch: a step ticked by mistake is unticked the same way.
  const tick = (task) => {
    setBusy(task.id);
    (task.done ? api.taskUndo(exam.id, task.id) : api.taskDone(exam.id, task.id)).then(app.putExam, app.fail).finally(() => setBusy(null));
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
  const writeSheet = () => {
    setSheetError(null);
    api.formulas(exam.id).then(app.putExam, (err) => errorCode(err) !== "cancelled" && setSheetError(err));
  };
  const toSettings = () => app.nav({ name: "settings", id: exam.id, from: { name: "exam", id: exam.id } });

  useEffect(() => {
    // The step that is up is in view when the exam opens.
    const now = grid.current.querySelector(".step.now");
    if (now) now.scrollIntoView({ block: "nearest" });
    // An exam from an earlier version has no formula sheet yet. With Claude Code it is written
    // now, once; with a key it costs money, so the person starts it.
    if (!exam.formulas && !run && !asked.current && !api.sample && app.ai.provider === "claudeCode") {
      asked.current = true;
      writeSheet();
    }
  }, []);

  const book = materialOf(exam, at.material) || exam.materials.find((m) => m.type === "pdf");
  const formulasOf = (topicId) => ((exam.formulas || []).find((g) => g.topicId === topicId) || { formulas: [] }).formulas;
  const todayLine = plan.over
    ? t("examOver", longDate(exam.date))
    : plan.today.steps
      ? t("todayLeft", plan.today.steps, minutes(plan.today.minutes))
      : t(next ? "todayDone" : "pathDone");
  let chapter = null; // a chapter is named where it starts, not on every line

  return html`<main class=${"path" + (panel ? "" : " alone")} ref=${grid} style=${{ "--split": split }}>
    <div class="plan-box">
      <div class="plan" inert=${helper}>
        <header class="path-head">
          <div class="percent" role="img" aria-label=${t("planDone", plan.percent)}>
            <b>${plan.percent}</b>
            <span><i>%</i><small>${t("doneWord")}</small></span>
          </div>
          <div class="path-title">
            <h1>${exam.name}</h1>
            <p>${longDate(exam.date, "short")}, ${[pre, n, post].filter((x) => x !== "").join(" ")}, ${t("target", grade(exam.scale, exam.target))}</p>
          </div>
          <${Lane} p=${plan.percent / 100} label=${t("planDone", plan.percent)} />
          <p class="path-now">
            ${todayLine}${" "}${plan.over && html`<button class="link" onClick=${() => app.nav({ name: "edit", id: exam.id, step: 2 })}>${t("changeDate")}</button>`}
          </p>
        </header>

        ${(exam.missing || s.stale) &&
        html`<p class="plan-note" role="note">
          ${t(exam.missing ? "planMissing" : "planStale")}${" "}
          <button class="link" onClick=${() => app.nav({ name: "setup", id: exam.id })}>${t("setup")}</button>
        </p>`}
        ${exam.undo &&
        exam.undo.lost > 0 &&
        html`<p class="plan-note" role="note">
          ${t("undoNote", exam.undo.kept, exam.undo.lost)}${" "}
          <button class="link" id="undoPlan" onClick=${() => api.undoStrategy(exam.id).then(app.putExam, app.fail)}>${t("undoPlan")}</button>
        </p>`}
        ${run && run.kind !== "formulas" && html`<${RunNote} run=${run} onCancel=${() => api.cancel(exam.id)} />`}

        <ol class="route">
          ${plan.stages.map((stage) => {
            const topic = s.topics.find((x) => x.id === stage.topicId);
            const finished = stage.tasks.filter((task) => task.done).length;
            const over = finished === stage.tasks.length;
            const folded = over && !opened.has(stage.id);
            const current = next && stage.tasks.some((task) => task.id === next.id);
            // A topic the model itself named as outside the objectives gets none listed under it.
            const outside = /not in (the|your) (learning )?objectives|nicht in den lernzielen/i.test(stage.title);
            const must = stage.again || outside ? [] : topic.objectives.map((i) => s.objectives[i]).filter(Boolean);
            const own = current ? formulasOf(stage.topicId) : [];
            const toggle = () =>
              setOpened((old) => {
                const set = new Set(old);
                set.has(stage.id) ? set.delete(stage.id) : set.add(stage.id);
                return set;
              });
            const title = stage.again ? t("againTitle", stage.title) : stage.title;
            return html`<li class=${"stage" + (over ? " done" : "") + (current ? " current" : "") + (folded ? " folded" : "") + (stage.again ? " again" : "")} key=${stage.id}>
              <header>
                <h2>${over ? html`<button aria-expanded=${String(!folded)} onClick=${toggle}>${title}</button>` : title}</h2>
                <span class="count num">${over && html`<${Icon} name="check" size=${14} />`}${finished}/${stage.tasks.length}</span>
              </header>
              ${!folded && stage.again && html`<p class="can short">${t("againWhy", Math.round((stage.score || 0) * 100))}</p>`}
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
              own.length > 0 &&
              html`<div class="own-formulas">
                <span class="can-label">${t("ownFormulas")}</span>
                <ul>
                  ${own.map(
                    (f) =>
                      html`<li>
                        <span class="own-name">${f.name}</span>
                        <span class="own-tex"><${Rich} text=${"$" + f.latex + "$"} /></span>
                      </li>`,
                  )}
                </ul>
              </div>`}
              ${!folded &&
              html`<ul class="worklist">
                ${stage.tasks.map((task) => {
                  const step = task.step;
                  const [verb, place, inChapter] = stepText(step, exam);
                  const named = inChapter && inChapter !== chapter ? inChapter : "";
                  if (inChapter) chapter = inChapter;
                  const isNext = next && next.id === task.id;
                  const later = !task.done && !isNext && !task.today;
                  const questions = task.kind === "quiz";
                  const points = questions && exam.topicSets["topic:" + task.id + "#0"];
                  const gone = step.material && !materialOf(exam, step.material);
                  const go = () => (questions ? app.nav({ name: "set", id: exam.id, what: { kind: "topic", stepId: task.id } }) : show(step.material, firstPage(step)));
                  const row = html`<li class=${"step" + (task.done ? " done" : "") + (isNext ? " now" : "") + (later ? " later" : "") + (questions ? " asks" : "")} key=${task.id}>
                    ${questions
                      ? html`<span class="mark" aria-hidden="true">${task.done && html`<${Icon} name="check" size=${14} />`}</span>`
                      : html`<button class="mark" role="checkbox" aria-checked=${String(task.done)} aria-label=${`${verb} ${place}`} disabled=${busy === task.id} onClick=${() => tick(task)}>
                          ${task.done && html`<${Icon} name="check" size=${14} />`}
                        </button>`}
                    <button class="jump" onClick=${go} disabled=${Boolean(gone)}>
                      <span><b>${verb}</b> ${place}</span>
                      ${named && html`<small>${named}</small>`}
                      ${questions && html`<small>${points ? t("pointsOf", points.points, points.max) : t("fromAi")}</small>`}
                      ${gone && html`<small>${t("bookGone")}</small>`}
                    </button>
                    <span class="min num">${minutes(task.minutes)}</span>
                  </li>`;
                  const notes = [row];
                  if (step.kind === "solve" && step.solved && step.solved.length && !task.done) {
                    notes.push(html`<li class="step-note" key=${task.id + "-solved"}>${t("solvedBefore", step.solved)}</li>`);
                  }
                  if (step.kind === "solve" && step.unconfirmed && step.unconfirmed.length && !task.done) {
                    notes.push(html`<li class="step-note" key=${task.id + "-note"}>${t("unconfirmed", step.unconfirmed)}</li>`);
                  }
                  // Where today's share ends: one line across the list, like the finish of a lap.
                  if (task.id === plan.today.end) notes.push(html`<li class="day-end" key="day-end"><span>${t("todayEnd")}</span></li>`);
                  return notes;
                })}
              </ul>`}
            </li>`;
          })}
          <${Final} exam=${exam} ready=${!next} app=${app} />
        </ol>
        ${plan.dropped.length > 0 &&
        html`<p class="left-out">
          ${t("leftOutWhy", plan.dropped.map((d) => d.title), plan.dropped.some((d) => d.reason === "time") ? minutes(plan.short) : "")}
        </p>`}
      </div>
      ${helper && html`<${Helper} exam=${exam} next=${next} show=${show} talk=${talk} ask=${ask} close=${() => setHelper(false)} toSettings=${toSettings} />`}
    </div>

    ${panel &&
    html`<div class="divider" role="separator" aria-orientation="vertical" onPointerDown=${drag}></div>
      <aside class="side">
        ${panel === "book" &&
        (book
          ? html`<${Book} material=${book} page=${at.page} jump=${at.jump} onPage=${(page) => setAt((old) => (old.page === page && old.material === book.id ? old : { ...old, material: book.id, page }))} />`
          : html`<section><header class="side-head"><strong>${t("panel_book")}</strong></header><div class="side-body"><p class="muted">${t("noBook")}</p></div></section>`)}
        ${panel === "formulas" && html`<${Formulas} exam=${exam} run=${run} error=${sheetError} write=${writeSheet} show=${show} toSettings=${toSettings} app=${app} />`}
      </aside>`}
  </main>`;
}

/** The last stage: the final exam. It can be taken at any time; it is the way out once everything is ticked. */
function Final({ exam, ready, app }) {
  const f = exam.final;
  const open = (another) => app.nav({ name: "set", id: exam.id, what: { kind: "final", another } });
  if (f.state === "done") {
    const r = f.result;
    const reached = exam.scale === "de" ? r.grade <= exam.target : r.grade >= exam.target;
    return html`<li class="stage final done-exam">
      <header><h2>${t("finalExam")}</h2></header>
      <div class="final-result">
        <b class="num">${grade(exam.scale, r.grade)}</b>
        <p>
          ${t("finalPoints", r.points, r.max, longDate(r.date, "short"))}${" "}${t(reached ? "finalReached" : "finalBelow", grade(exam.scale, exam.target))}
          ${r.weak.length > 0 && html`${" "}${t("finalWeak", r.weak.length)}`}
        </p>
      </div>
      <div class="row-start">
        <button class="btn second" id="finalSee" onClick=${() => open(false)}>${t("finalSee")}</button>
        <button class="btn plain" id="finalAnother" onClick=${() => open(true)}>${t("finalAnother")}</button>
      </div>
    </li>`;
  }
  return html`<li class=${"stage final" + (ready ? " current" : "")}>
    <header><h2>${t("finalExam")}</h2></header>
    <p class="can">${t(ready ? "finalReady" : "finalText")}</p>
    <div class="row-start">
      <button class=${"btn " + (ready ? "primary" : "second")} id="finalStart" onClick=${() => open(false)}>${t(f.started ? "finalContinue" : "finalStart")}</button>
    </div>
  </li>`;
}

function Formulas({ exam, run, error, write, show, toSettings, app }) {
  const groups = exam.formulas || null;
  const writing = run && run.kind === "formulas";
  const title = (id) => (exam.strategy.topics.find((x) => x.id === id) || {}).title;
  return html`<section class="sheet-panel">
    <header class="side-head"><strong>${t("formulaSheet")}</strong></header>
    <div class="side-body">
      ${error && !writing && html`<${Problem} error=${error} onRetry=${write} toSettings=${toSettings} />`}
      ${writing && html`<${RunNote} run=${run} onCancel=${() => api.cancel(exam.id)} />`}
      ${!groups &&
      !writing &&
      !error &&
      html`<div class="ideas">
        <p class="muted">${t(app.ai.provider === "claudeCode" ? "formulasMissing" : "formulasPaid")}</p>
        <button class="btn primary" id="writeSheet" disabled=${Boolean(run)} onClick=${write}>${t("formulasWrite")}</button>
      </div>`}
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
                  <p>
                    ${f.note && html`<${Rich} text=${f.note} />`}${" "}
                    ${f.page && materialOf(exam, f.material) && html`<button class="link page-ref" onClick=${() => show(f.material, f.page)}>${t("page", printed(materialOf(exam, f.material), f.page))}</button>`}
                  </p>
                </div>`,
            )}
          </section>`,
      )}
      ${groups && groups.length > 0 && html`<p class="sheet-note">${t("formulasNote")}</p>`}
    </div>
  </section>`;
}

/** The helper, over the plan. A page in an answer moves the book beside it; the conversation stays. */
function Helper({ exam, next, show, talk, ask, close, toSettings }) {
  const [text, setText] = useState("");
  const end = useRef(null);
  const field = useRef(null);
  const now = next ? `${next.step.kind === "quiz" ? "questions" : next.step.kind} step of the topic "${(exam.strategy.topics.find((x) => x.id === next.topicId) || {}).title || ""}"` : "everything in the plan is done";
  const send = (question) => {
    setText("");
    ask(question, now);
  };
  useEffect(() => {
    field.current && field.current.focus();
    const onKey = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => end.current && end.current.scrollIntoView({ block: "end" }), [talk]);
  const title = next ? (exam.strategy.topics.find((x) => x.id === next.topicId) || {}).title : null;
  const ideas = [title ? t("askExercises", title) : null, title ? t("askExplain", title) : null, t("askStart")].filter(Boolean);
  return html`<section class="drawer helper view" aria-label=${t("helper")}>
    <header class="side-head">
      <strong>${t("helper")}</strong>
      <button class="mini" aria-label=${t("close")} title=${t("close")} onClick=${close}><${Icon} name="x" size=${14} /></button>
    </header>
    <div class="side-body talk">
      ${!talk.turns.length &&
      html`<div class="ideas">
        <p class="muted">${t("helperLead")}</p>
        ${ideas.map((idea) => html`<button class="idea" onClick=${() => send(idea)}>${idea}</button>`)}
      </div>`}
      ${talk.turns.map(
        (x) =>
          html`<div class="turn">
            <p class="asked">${x.question}</p>
            ${x.error && html`<${Problem} error=${x.error} onRetry=${() => send(x.question)} toSettings=${toSettings} />`}
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
        send(text);
      }}
    >
      <input ref=${field} class="field" value=${text} maxlength="1000" placeholder=${t("helperPlaceholder")} aria-label=${t("helperPlaceholder")} onInput=${(e) => setText(e.target.value)} />
      <button class="btn primary" disabled=${talk.busy || !text.trim()}>${t("helperAsk")}</button>
    </form>
  </section>`;
}

// An exam being taken: the final exam over everything, or questions on one topic whose book
// has no exercises. The person types results only. Numbers are compared on this Mac; nothing
// here asks for the way to a result. Afterwards: what was right, the worked solutions, a grade
// estimate, and which topics go back on the list.
import { html, useState, useEffect, useRef, Icon, RunNote, grade } from "./bits.js";
import { t, errorCode } from "./i18n.js";
import { Rich } from "./rich.js";
import { Problem } from "./claude.js";

const api = window.aced;

export function Questions({ exam, what, run, app, toSettings }) {
  const [set, setSet] = useState(null);
  const [typed, setTyped] = useState({});
  const [error, setError] = useState(null); // while opening
  const [problem, setProblem] = useState(null); // while handing in: stays on screen with what was typed
  const [sure, setSure] = useState(false);
  const [sending, setSending] = useState(false);
  const here = useRef(true);
  const saver = useRef(null);
  const latest = useRef({}); // what is typed, also between two redraws
  const top = useRef(null);
  const toPlan = () => app.nav({ name: "exam", id: exam.id });

  const open = (options) => {
    setError(null);
    setSet(null);
    api.openSet(exam.id, { ...what, ...options }).then(
      (next) => {
        if (!here.current) return;
        setSet(next);
        latest.current = next.draft || {};
        setTyped(latest.current);
      },
      (err) => here.current && (errorCode(err) === "cancelled" ? toPlan() : setError(err)),
    );
  };
  useEffect(() => {
    open();
    return () => {
      here.current = false;
      clearTimeout(saver.current);
    };
  }, []);
  // After handing in, the result is what the keyboard is on.
  useEffect(() => {
    if (set && set.result && top.current) top.current.focus();
  }, [set && set.result]);

  const answer = (id, value) => {
    latest.current = { ...latest.current, [id]: value };
    setTyped(latest.current);
    setSure(false);
    // Kept as it is typed: leaving this screen, or quitting, loses nothing.
    clearTimeout(saver.current);
    saver.current = setTimeout(() => api.saveDraft(exam.id, set.key, latest.current).catch(() => {}), 500);
  };
  const filled = (q) => (q.type === "choice" ? Number.isInteger(typed[q.id]) : String(typed[q.id] || "").trim() !== "");
  const handIn = () => {
    const empty = set.questions.filter((q) => !filled(q)).length;
    if (empty && !sure) return setSure(true);
    clearTimeout(saver.current);
    setProblem(null);
    setSending(true);
    api
      .submitSet(exam.id, set.key, latest.current)
      .then(
        (out) => {
          app.putExam(out.exam);
          if (here.current) setSet(out.set);
        },
        (err) => here.current && errorCode(err) !== "cancelled" && setProblem(err),
      )
      .finally(() => here.current && setSending(false));
  };

  const head = (title, note) => html`<header class="set-head">
    <button class="bar-btn" onClick=${toPlan}><${Icon} name="back" /><span>${exam.name}</span></button>
    <h1 ref=${top} tabindex="-1">${title}</h1>
    ${note && html`<p class="muted">${note}</p>`}
  </header>`;

  if (error) {
    return html`<main class="page set view">
      ${head(t(what.kind === "final" ? "finalExam" : "questionsTitle"))}
      ${errorCode(error) === "sampleOnly" ? html`<p class="lead">${t("sampleOnly")}</p>` : html`<${Problem} error=${error} onRetry=${() => open()} toSettings=${toSettings} />`}
      <div class="row-start"><button class="btn plain" onClick=${toPlan}>${t("backToPlan")}</button></div>
    </main>`;
  }
  if (!set) {
    return html`<main class="page set view">
      ${head(t(what.kind === "final" ? "finalExam" : "questionsTitle"))}
      ${run ? html`<${RunNote} run=${run} onCancel=${() => api.cancel(exam.id)} />` : html`<div class="running"><span class="spinner" aria-hidden="true"></span></div>`}
    </main>`;
  }

  const title = set.final ? t("finalExam") : t("questionsOn", set.title);
  // "My result was right": one click puts a mark right, and the points and the list follow.
  const overrule = (questionId) =>
    api.overrule(exam.id, set.key, questionId).then((out) => {
      app.putExam(out.exam);
      setSet(out.set);
    }, app.fail);
  if (set.result) return html`<${Result} exam=${exam} set=${set} head=${head(title)} toPlan=${toPlan} another=${set.final ? () => open({ another: true }) : null} overrule=${overrule} />`;

  const count = set.questions.length;
  const done = set.questions.filter(filled).length;
  return html`<main class="page set view">
    ${head(title, t(set.final ? "finalLead" : "questionsLead"))}
    <ol class="questions">
      ${set.questions.map(
        (q, i) =>
          html`<li class="question-card" key=${q.id} data-question=${q.id} data-type=${q.type}>
            <div class="q-head"><span class="q-n num">${i + 1}</span><span class="q-points">${t("points", q.points)}</span></div>
            <p class="q-prompt"><${Rich} text=${q.prompt} /></p>
            ${q.type === "choice"
              ? html`<div class="choices" role="radiogroup" aria-label=${t("answerLabel", i + 1)}>
                  ${q.choices.map(
                    (c, k) =>
                      html`<button class="choice" role="radio" aria-checked=${String(typed[q.id] === k)} onClick=${() => answer(q.id, k)}>
                        <i class="dot"></i><span><${Rich} text=${c} /></span>
                      </button>`,
                  )}
                </div>`
              : html`<label class="result-field">
                  <span>${t(q.type === "numbers" ? "resultsLabel" : "resultLabel")}</span>
                  <input
                    class="field"
                    value=${typed[q.id] || ""}
                    inputmode=${q.type === "text" ? "text" : "decimal"}
                    spellcheck=${false}
                    autocomplete="off"
                    maxlength="400"
                    aria-label=${t("answerLabel", i + 1)}
                    onInput=${(e) => answer(q.id, e.target.value)}
                  />
                  ${q.unit && html`<span class="unit">${q.unit}</span>`}
                </label>`}
          </li>`,
      )}
    </ol>
    <footer class="set-foot">
      ${problem && html`<${Problem} error=${problem} onRetry=${handIn} toSettings=${toSettings} />`}
      ${sending && run && html`<${RunNote} run=${run} onCancel=${() => api.cancel(exam.id)} />`}
      ${sure && !sending && html`<p class="hint" role="status">${t("handInSure", count - done)}</p>`}
      <div class="row-end">
        <span class="muted">${t("answered", done, count)}</span>
        <button class="btn primary big" id="handIn" disabled=${sending} onClick=${handIn}>${t(sure ? "handInAnyway" : "handIn")}</button>
      </div>
    </footer>
  </main>`;
}

/** What was typed, shown the way the question asked for it. */
function typedText(q, value) {
  if (q.type === "choice") return Number.isInteger(value) ? q.choices[value] : "";
  return String(value || "").trim();
}

function Result({ exam, set, head, toPlan, another, overrule }) {
  const r = set.result;
  const reached = exam.scale === "de" ? r.grade <= exam.target : r.grade >= exam.target;
  const topics = Object.entries(r.topics || {});
  return html`<main class="page set view">
    ${head}
    <section class="result-head">
      <div class="percent" role="img" aria-label=${t("gradeEstimate", grade(exam.scale, r.grade))}>
        <b>${grade(exam.scale, r.grade)}</b>
      </div>
      <div>
        <p class="result-line">${t("resultPoints", r.points, r.max)}</p>
        <p class="muted">${set.final ? t(reached ? "resultReached" : "resultBelow", grade(exam.scale, exam.target)) : t("resultTopic")}</p>
      </div>
    </section>
    ${set.final && html`<p class="hint">${t("resultEstimate")}</p>`}
    ${topics.length > 1 &&
    html`<ul class="result-topics">
      ${topics.map(
        ([id, x]) =>
          html`<li class=${r.weak.includes(id) ? "weak" : ""}>
            <span>${set.topics[id]}</span>
            <span class="num">${x.points}/${x.max}</span>
            ${r.weak.includes(id) && html`<small>${t("backOnList")}</small>`}
          </li>`,
      )}
    </ul>`}
    <ol class="questions">
      ${set.questions.map((q, i) => {
        const m = r.marks[q.id];
        const verdict = m.points >= m.max ? "right" : m.points > 0 ? "partly" : "wrong";
        const mine = typedText(q, r.typed[q.id]);
        return html`<li class=${"question-card marked " + verdict} key=${q.id} data-question=${q.id}>
          <div class="q-head">
            <span class="q-n num">${i + 1}</span>
            <span class=${"verdict " + verdict}><${Icon} name=${verdict === "right" ? "check" : verdict === "partly" ? "partly" : "x"} size=${14} />${t("verdict_" + verdict)}</span>
            <span class="q-points num">${m.points}/${m.max}</span>
          </div>
          <p class="q-prompt"><${Rich} text=${q.prompt} /></p>
          <dl class="q-answers">
            <dt>${t("yourResult")}</dt>
            <dd>${mine ? html`<${Rich} text=${mine} />` : html`<span class="muted">${t("noAnswer")}</span>`}</dd>
            ${verdict !== "right" && html`<dt>${t("expected")}</dt><dd><${Rich} text=${q.answer} /></dd>`}
          </dl>
          ${m.note && html`<p class="q-note"><${Rich} text=${m.note} /></p>`}
          ${m.by === "you" && html`<p class="q-note muted">${t("overruled")}</p>`}
          ${verdict !== "right" && mine && html`<button class="link overrule" onClick=${() => overrule(q.id)}>${t("wasRight")}</button>`}
          ${q.solution &&
          html`<details class="solution" open=${verdict !== "right"}>
            <summary>${t("solution")}</summary>
            <p><${Rich} text=${q.solution} /></p>
          </details>`}
        </li>`;
      })}
    </ol>
    <footer class="set-foot">
      <div class="row-end">
        ${another && html`<button class="btn plain" id="another" onClick=${another}>${t("finalAnother")}</button>`}
        <button class="btn primary big" id="toPlan" onClick=${toPlan}>${t("backToPlan")}</button>
      </div>
    </footer>
  </main>`;
}

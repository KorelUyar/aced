// A quiz, a review or a mock exam: one question at a time, corrected with a short reason and
// the page in the book. The questions are written and the written answers corrected by the AI.
import { html, useState, useEffect, Icon, Segs, materialOf, printed } from "./bits.js";
import { t, errorText } from "./i18n.js";
import { Rich } from "./rich.js";

const api = window.spurt;
const VERDICT_ICON = { right: "check", partly: "partly", wrong: "x" };

export function Quiz({ exam, what, app }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { points, max } once finished

  const toToday = () => app.nav({ name: "exam", id: exam.id, tab: "today" });
  const open = () => {
    setError(null);
    api.openQuiz(exam.id, what).then(setSession, (err) => (err.code === "cancelled" ? toToday() : setError(errorText(err))));
  };
  useEffect(open, []);

  const top = (bar) => html`<div class="quiz-top">
    <button
      class="bar-btn square"
      title=${t("close")}
      aria-label=${t("close")}
      onClick=${() => {
        if (!session) api.cancel();
        // Leaving in the middle still counts what was answered.
        if (session && !done && i + (result ? 1 : 0) > 0) api.finishQuiz(session.sessionId).then((r) => app.putExam(r.exam), () => {});
        toToday();
      }}
    >
      <${Icon} name="x" />
    </button>
    ${bar}
  </div>`;

  if (error) {
    return html`<main class="page focus view">
      ${top(html`<span></span>`)}
      <p class="problem" role="alert">${error}</p>
      <div class="quiz-foot"><span></span><button class="btn primary" onClick=${open}>${t("retry")}</button></div>
    </main>`;
  }
  if (!session) {
    return html`<main class="page focus view">
      ${top(html`<span></span>`)}
      <div class="running" role="status"><span class="spinner" aria-hidden="true"></span><span>${t("writing")}</span></div>
    </main>`;
  }
  if (done) {
    return html`<main class="page focus view">
      <div class="result">
        <h1>${t("resultTitle")}</h1>
        <div class="grade">${done.points}/${done.max}</div>
        <p>${t("resultText", done.points, done.max)}</p>
        <button class="btn primary big" onClick=${toToday}>${t("backToToday")}</button>
      </div>
    </main>`;
  }

  const questions = session.questions;
  const total = questions.length;
  const q = questions[i];
  const material = materialOf(exam, q.material);
  const hasAnswer = q.type === "choice" ? answer !== null : (answer || "").trim().length > 0;
  const check = () => {
    setBusy(true);
    setError(null);
    api
      .answer(session.sessionId, q.id, answer)
      .then(setResult, (err) => app.fail(err))
      .finally(() => setBusy(false));
  };
  const next = () => {
    if (i + 1 === total) {
      return api.finishQuiz(session.sessionId).then((r) => {
        app.putExam(r.exam);
        setDone({ points: r.points, max: r.max });
      }, app.fail);
    }
    setI(i + 1);
    setAnswer(null);
    setResult(null);
  };
  const title = session.kind === "topic" ? `${t("quiz")}: ${session.title}` : t("kind_" + session.kind);

  return html`<main class="page focus view">
    ${top(html`<${Segs} total=${total} done=${result ? i + 1 : i} now=${i} label=${t("questionOf", i + 1, total)} />
      <span class="muted">${t("questionOf", i + 1, total)}</span>`)}
    <section class="view" key=${q.id}>
      <p class="q-meta">${title}, ${t("points", q.points)}</p>
      <p class="q-prompt"><${Rich} text=${q.prompt} /></p>
      ${q.type === "choice"
        ? html`<div class="choices" role="radiogroup">
            ${q.choices.map((text, c) => {
              const mark = result && (c === q.correct ? "is-right" : c === answer ? "is-wrong" : "");
              return html`<button
                class=${"choice " + (mark || "")}
                role="radio"
                aria-checked=${String(c === answer)}
                disabled=${!!result}
                onClick=${() => setAnswer(c)}
              >
                <${Rich} text=${text} />${mark && html`<${Icon} name=${mark === "is-right" ? "check" : "x"} />`}
              </button>`;
            })}
          </div>`
        : html`<textarea
            class="answer"
            rows=${result ? 1 : q.type === "open" ? 5 : 3}
            placeholder=${t("answerPlaceholder")}
            aria-label=${t("answerPlaceholder")}
            readonly=${!!result || busy}
            spellcheck=${false}
            value=${answer || ""}
            onInput=${(e) => setAnswer(e.target.value)}
          ></textarea>`}
      ${result &&
      html`<div class=${"feedback view " + result.verdict} role="status">
        <div class="verdict">
          <${Icon} name=${VERDICT_ICON[result.verdict]} size=${18} />${t("v_" + result.verdict)}
          <span class="score">${t("score", result.points, result.max)}</span>
        </div>
        <p><${Rich} text=${result.feedback} /></p>
        ${result.correct && html`<p class="solution"><span>${t("correctAnswer")}</span><${Rich} text=${result.correct} /></p>`}
      </div>`}
      <div class="quiz-foot">
        ${result
          ? html`${material && material.type === "pdf" && q.page
                ? html`<button class="btn second" onClick=${() => app.openBook(q.material, q.page)}>
                    <${Icon} name="book" />${t("openBook", printed(material, q.page))}
                  </button>`
                : html`<span></span>`}
              <button class="btn primary big" id="next" onClick=${next}>${i + 1 === total ? t("finishQuiz") : t("nextQuestion")}</button>`
          : html`<span class="muted" role="status">${busy && q.type !== "choice" ? t("correcting") : ""}</span>
              <button class="btn primary big" id="check" disabled=${!hasAnswer || busy} onClick=${check}>${t("check")}</button>`}
      </div>
      ${result?.backInDays && html`<p class="later-note">${t("comesBack", result.backInDays)}</p>`}
    </section>
  </main>`;
}

// A quiz: one question at a time, corrected with a short reason and the page in the book.
import { html, useState, Icon, Segs } from "./bits.js";
import { t } from "./i18n.js";

const VERDICT_ICON = { right: "check", partly: "partly", wrong: "x" };

// Multiple choice is corrected here. A written answer is corrected by the AI; until the engine
// exists, the sample question carries its correction with it.
function correct(q, answer) {
  if (q.type === "choice") {
    const right = answer === q.correct;
    return { verdict: right ? "right" : "wrong", points: right ? q.points : 0, text: q.explain, backInDays: right ? null : 1 };
  }
  return q.sampleFeedback;
}

export function Quiz({ exam, nav, save, notify }) {
  const { quiz } = exam;
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState(null);
  const [result, setResult] = useState(null);
  const [earned, setEarned] = useState(0);
  const [finished, setFinished] = useState(false);

  const total = quiz.questions.length;
  const maxPoints = quiz.questions.reduce((sum, q) => sum + q.points, 0);
  const toToday = () => nav({ name: "exam", id: exam.id, tab: "today" });

  if (finished) {
    const done = async () => {
      const today = exam.today;
      if (today) await save(exam.id, { today: { ...today, tasks: today.tasks.map((x) => (x.kind === "quiz" ? { ...x, done: true } : x)) } });
      toToday();
    };
    return html`<main class="page focus view">
      <div class="result">
        <h1>${t("resultTitle")}</h1>
        <div class="grade">${earned}/${maxPoints}</div>
        <p>${t("resultText", earned, maxPoints)}</p>
        <button class="btn primary big" onClick=${done}>${t("backToToday")}</button>
      </div>
    </main>`;
  }

  const q = quiz.questions[i];
  const hasAnswer = q.type === "choice" ? answer !== null : (answer || "").trim().length > 0;
  const check = () => {
    const r = correct(q, answer);
    setResult(r);
    setEarned(earned + r.points);
  };
  const next = () => {
    if (i + 1 === total) return setFinished(true);
    setI(i + 1);
    setAnswer(null);
    setResult(null);
  };

  return html`<main class="page focus view">
    <div class="quiz-top">
      <button class="bar-btn square" title=${t("close")} aria-label=${t("close")} onClick=${toToday}><${Icon} name="x" /></button>
      <${Segs} total=${total} done=${result ? i + 1 : i} now=${i} label=${t("questionOf", i + 1, total)} />
      <span class="muted">${t("questionOf", i + 1, total)}</span>
    </div>
    <section class="view" key=${q.id}>
      <p class="q-meta">${t("quiz")}: ${quiz.title}, ${t("points", q.points)}</p>
      <p class="q-prompt">${q.prompt}</p>
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
                ${text}${mark && html`<${Icon} name=${mark === "is-right" ? "check" : "x"} />`}
              </button>`;
            })}
          </div>`
        : html`<textarea
            class="answer"
            rows=${result ? 1 : 3}
            placeholder=${t("answerPlaceholder")}
            aria-label=${t("answerPlaceholder")}
            readonly=${!!result}
            spellcheck=${false}
            value=${answer || ""}
            onInput=${(e) => setAnswer(e.target.value)}
          ></textarea>`}
      ${result &&
      html`<div class=${"feedback view " + result.verdict} role="status">
        <div class="verdict">
          <${Icon} name=${VERDICT_ICON[result.verdict]} size=${18} />${t("v_" + result.verdict)}
          <span class="score">${t("score", result.points, q.points)}</span>
        </div>
        <p>${result.text}</p>
        ${result.correct && html`<p class="solution"><span>${t("correctAnswer")}</span>${result.correct}</p>`}
      </div>`}
      <div class="quiz-foot">
        ${result
          ? html`<button class="btn second" onClick=${() => notify(t("sampleBook"))}><${Icon} name="book" />${t("openBook", q.page)}</button>
              <button class="btn primary big" id="next" onClick=${next}>${i + 1 === total ? t("finishQuiz") : t("nextQuestion")}</button>`
          : html`<span></span>
              <button class="btn primary big" id="check" disabled=${!hasAnswer} onClick=${check}>${t("check")}</button>`}
      </div>
      ${result?.backInDays && html`<p class="later-note">${t("comesBack", result.backInDays)}</p>`}
    </section>
  </main>`;
}

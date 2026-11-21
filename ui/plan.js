// Plan: what is on which day. Practice: quiz a topic, review what is due, sit a mock exam.
import { html, Icon, Lane, minutes, where } from "./bits.js";
import { t, longDate } from "./i18n.js";
import { NoPlan, taskLabel, quizRoute } from "./exam.js";

export function Plan({ exam, go }) {
  const plan = exam.plan;
  if (!plan) return html`<${NoPlan} go=${go} />`;
  return html`
    <p class="lead small">
      ${t("planLead", plan.daysLeft, minutes(plan.perDay))} ${t("planTotal", minutes(plan.planned))}
      ${plan.dropped.length > 0 && html` <button class="link" onClick=${() => go("strategy")}>${t("leftOut", plan.dropped.length)}</button>`}
    </p>
    <ol class="days">
      ${plan.days.map(
        (day, i) =>
          html`<li class=${"day" + (i === 0 ? " now" : "")} key=${day.date}>
            <h3>${i === 0 ? t("today") : i === 1 ? t("tomorrow") : longDate(day.date)}</h3>
            ${day.tasks.length
              ? html`<ul>
                  ${day.tasks.map(
                    (task) =>
                      html`<li class=${task.done ? "done" : ""}>
                        <span class="tick">${task.done && html`<${Icon} name="check" size=${14} />`}</span>
                        <span>
                          ${taskLabel(task)}
                          ${(task.kind === "read" || task.kind === "solve") && html`<small>${where(task.step, exam)}</small>`}
                        </span>
                        <span class="muted num">${minutes(task.minutes)}</span>
                      </li>`,
                  )}
                </ul>`
              : html`<p class="muted">${t("freeDay")}</p>`}
          </li>`,
      )}
      <li class="day exam-day"><h3>${longDate(exam.date)}</h3><p>${t("examDay")}</p></li>
    </ol>
  `;
}

export function Practice({ exam, app, go }) {
  if (!exam.strategy) return html`<${NoPlan} go=${go} />`;
  const quiz = (what) => app.nav({ name: "quiz", id: exam.id, what });
  const out = new Set(exam.plan.dropped.map((d) => d.topicId));
  const topics = exam.strategy.topics.filter((x) => !out.has(x.id));
  const titles = Object.fromEntries(exam.strategy.topics.map((x) => [x.id, x.title]));
  const recent = [...exam.history].reverse().slice(0, 5);
  return html`
    ${exam.due > 0 &&
    html`<section class="next">
      <h2>${t("practiceDue", exam.due)}</h2>
      <p class="why">${t("whyReview")}</p>
      <div class="actions">
        <button class="btn primary big" onClick=${() => quiz({ kind: "review" })}>${t("startReview")}</button>
      </div>
    </section>`}
    <section class="practice">
      <h3>${t("practiceTopics")}</h3>
      <ul>
        ${topics.map((topic) => {
          const quizzed = typeof exam.mastery[topic.id] === "number";
          return html`<li key=${topic.id}>
            <div>
              <strong>${topic.title}</strong>
              <${Lane} p=${quizzed ? exam.mastery[topic.id] : 0} label=${topic.title} />
              <span>${quizzed ? t("lastQuiz", Math.round(exam.mastery[topic.id] * 100)) : t("notQuizzed")}</span>
            </div>
            <button class="btn second" onClick=${() => quiz({ kind: "topic", topicId: topic.id })}>${t("quizButton")}</button>
          </li>`;
        })}
        ${topics.length > 1 &&
        html`<li>
          <div>
            <strong>${t("kind_mock")}</strong>
            <span>${t("practiceMockText")}</span>
          </div>
          <button class="btn second" onClick=${() => quiz({ kind: "mock" })}>${t("startMock")}</button>
        </li>`}
      </ul>
    </section>
    ${recent.length > 0 &&
    html`<section class="practice history">
      <h3>${t("historyTitle")}</h3>
      <ul>
        ${recent.map(
          (h) =>
            html`<li>
              <span>${longDate(h.date, "short")}: ${h.kind === "topic" ? `${t("quiz")}, ${titles[h.topicId] || ""}` : t("kind_" + h.kind)}</span>
              <span class="muted num">${t("score", h.points, h.max)}</span>
            </li>`,
        )}
      </ul>
    </section>`}
  `;
}

// One exam: Today (the one next thing to do) and Strategy (what matters most, what is left out).
import { html, useState, Icon, Lane, daysUntil, minutes, grade, where, firstPage, canOpen, materialOf, printed } from "./bits.js";
import { t, longDate } from "./i18n.js";
import { Rich } from "./rich.js";
import { Material } from "./material.js";
import { Plan, Practice } from "./plan.js";

export const TABS = ["today", "strategy", "plan", "practice", "material"];

const api = window.spurt;

export function Exam({ exam, tab, app }) {
  const n = daysUntil(exam.date);
  const [pre, num, post] = t("days", n);
  const go = (next) => app.nav({ name: "exam", id: exam.id, tab: next });
  const props = { exam, app, go };
  const panel = {
    today: () => html`<${Today} ...${props} />`,
    strategy: () => html`<${Strategy} ...${props} days=${n} />`,
    plan: () => html`<${Plan} ...${props} />`,
    practice: () => html`<${Practice} ...${props} />`,
    material: () => html`<${Material} ...${props} />`,
  }[tab];

  return html`<main class="page column view">
    <header class="exam-head">
      <h1>${exam.name}</h1>
      <p>${longDate(exam.date, "short")}, ${[pre, num, post].filter((x) => x !== "").join(" ")}</p>
    </header>
    <div class="view" key=${tab} role="tabpanel">${panel()}</div>
  </main>`;
}

export function NoPlan({ go }) {
  return html`<section class="next">
    <h2>${t("noPlanTitle")}</h2>
    <p class="why">${t("noPlanText")}</p>
    <div class="actions">
      <button class="btn primary" onClick=${() => go("material")}><${Icon} name="plus" />${t("addMaterial")}</button>
    </div>
  </section>`;
}

export const taskLabel = (task) =>
  task.kind === "review" ? t("kind_review") : task.kind === "mock" ? t("kind_mock") : `${t("kind_" + task.kind)}: ${task.title}`;

/** Starting a quiz, a review or a mock exam from a task. */
export const quizRoute = (exam, task) => ({
  name: "quiz",
  id: exam.id,
  what: { kind: task.kind === "quiz" ? "topic" : task.kind, taskId: task.kind === "quiz" ? task.id : null, topicId: task.topicId },
});

function Today({ exam, app, go }) {
  const [busy, setBusy] = useState(false);
  if (!exam.plan) return html`<${NoPlan} go=${go} />`;
  const plan = exam.plan;
  const tasks = plan.days[0].tasks;
  const next = tasks.find((x) => !x.done);
  const later = tasks.filter((x) => !x.done && x !== next);
  const ahead = plan.days.slice(1).flatMap((d) => d.tasks).find((x) => !x.done);
  const topic = next && exam.strategy.topics.find((x) => x.id === next.topicId);
  const run = (promise) => {
    setBusy(true);
    promise.then(app.putExam, app.fail).finally(() => setBusy(false));
  };

  let card;
  if (next) {
    const isQuiz = ["quiz", "review", "mock"].includes(next.kind);
    const why =
      next.kind === "quiz"
        ? t(next.step.again ? "whyAgain" : "whyQuiz")
        : next.kind === "review"
          ? t("whyReview")
          : next.kind === "mock"
            ? t("whyMock")
            : next.kind === "read" || !topic.steps.some((s) => s.kind === "read")
              ? topic.why
              : null;
    const page = firstPage(next.step);
    const material = materialOf(exam, next.step.material);
    card = html`<section class="next view" key=${next.id}>
      <p class="kicker">${next.kind === "mock" ? "" : t("kind_" + next.kind) + ", "}${t("about", minutes(next.minutes))}</p>
      <h2>${next.kind === "review" ? t("reviewTitle", next.step.questions) : next.kind === "mock" ? t("kind_mock") : next.title}</h2>
      ${next.kind !== "review" && next.kind !== "mock" && html`<p class="where">${where(next.step, exam)}</p>`}
      ${why && html`<p class="why"><${Rich} text=${why} /></p>`}
      <div class="actions">
        ${isQuiz
          ? html`<button class="btn primary big" onClick=${() => app.nav(quizRoute(exam, next))}>
              ${t(next.kind === "review" ? "startReview" : next.kind === "mock" ? "startMock" : "startQuiz")}
            </button>`
          : html`${canOpen(exam, next.step) &&
              html`<button class="btn primary big" onClick=${() => app.openBook(next.step.material, page)}>
                <${Icon} name="book" />${t("openBook", printed(material, page))}
              </button>`}
              <button class=${canOpen(exam, next.step) ? "btn plain" : "btn primary big"} disabled=${busy} onClick=${() => run(api.taskDone(exam.id, next.id))}>
                ${t("markDone")}
              </button>`}
      </div>
    </section>`;
  } else {
    card = html`<section class="next view">
      <h2>${t(ahead ? "allDoneTitle" : daysUntil(exam.date) < 0 ? "examPassed" : "nothingLeft")}</h2>
      ${ahead && html`<p class="why">${t("allDoneText", taskLabel(ahead))}</p>`}
      ${ahead &&
      html`<div class="actions">
        <button class="btn second" disabled=${busy} onClick=${() => run(api.doMore(exam.id))}>${t("keepGoing")}</button>
      </div>`}
    </section>`;
  }

  return html`
    ${card}
    ${later.length > 0 &&
    html`<section class="after">
      <h3>${t("afterThat")}</h3>
      <ul>
        ${later.map((x) => html`<li><span>${taskLabel(x)}</span><span class="muted num">${minutes(x.minutes)}</span></li>`)}
      </ul>
    </section>`}
    <section class="standing">
      <div class="row">
        <strong>${t("onTrack", grade(exam.scale, exam.projected))}</strong>
        <span class="muted">${t("target", grade(exam.scale, exam.target))}</span>
      </div>
      <${Lane} p=${exam.readiness} label=${t("ready", Math.round(exam.readiness * 100))} />
      <small>${t("ready", Math.round(exam.readiness * 100))}. ${t(exam.quizzed ? "estimateQuizzed" : "estimatePlain")}</small>
    </section>
  `;
}

const stepMinutes = (topic) => topic.steps.reduce((sum, s) => sum + s.minutes, 0);

function Strategy({ exam, days, app, go }) {
  const s = exam.strategy;
  const plan = exam.plan;
  const out = new Set(plan ? plan.dropped.map((d) => d.topicId) : []);
  // Same order as the plan: most points per minute first.
  const topics = s ? s.topics.filter((x) => !out.has(x.id)).sort((a, b) => b.share / stepMinutes(b) - a.share / stepMinutes(a)) : [];
  const [open, setOpen] = useState(topics[0]?.id);
  const [showDropped, setShowDropped] = useState(false);
  if (!s) return html`<${NoPlan} go=${go} />`;
  const target = grade(exam.scale, exam.target);

  return html`
    <header class="strategy-head">
      <h2>${t("strategyTitle", target, Math.max(days, 0))}</h2>
      <p><${Rich} text=${s.approach} /></p>
      <p class="budget">
        ${t("budget2", minutes(plan.available), minutes(plan.planned), Math.round(plan.coverage * 100))}
        ${!plan.reachable && html` <strong>${t("honest", grade(exam.scale, plan.reach), target, minutes(plan.short))}</strong>`}
      </p>
      ${s.stale &&
      html`<p class="budget">${t("staleNote")} <button class="link" onClick=${() => go("material")}>${t("workOutAgain")}</button></p>`}
    </header>
    <ol class="topics">
      ${topics.map((topic, i) => {
        const expanded = open === topic.id;
        const quizzed = typeof exam.mastery[topic.id] === "number";
        return html`<li class="topic" key=${topic.id}>
          <button class="topic-head" aria-expanded=${String(expanded)} onClick=${() => setOpen(expanded ? null : topic.id)}>
            <span class="rank">${i + 1}</span>
            <span>
              <strong>${topic.title}</strong>
              <span class="tag">
                ${i === 0 && html`<mark>${t("topTag")}</mark>`}${t("share", Math.round(topic.share * 100))}${quizzed
                  ? ", " + t("lastQuiz", Math.round(exam.mastery[topic.id] * 100))
                  : ""}
              </span>
            </span>
            <span class="time">${minutes(stepMinutes(topic))}</span>
            <${Icon} name="down" />
          </button>
          ${expanded &&
          html`<div class="topic-body view">
            <p class="why"><${Rich} text=${topic.why} /></p>
            <dl class="steps">
              ${topic.steps.map(
                (step) =>
                  html`<dt>${t("step_" + step.kind)}</dt>
                    <dd>
                      ${where(step, exam)}
                      ${canOpen(exam, step) &&
                      html`<button
                        class="mini"
                        title=${t("openBook", printed(materialOf(exam, step.material), firstPage(step)))}
                        aria-label=${t("openBook", printed(materialOf(exam, step.material), firstPage(step)))}
                        onClick=${() => app.openBook(step.material, firstPage(step))}
                      >
                        <${Icon} name="open" size=${14} />
                      </button>`}
                      ${step.unconfirmed?.length > 0 && html`<small>${t("unconfirmed", step.unconfirmed.join(", "))}</small>`}
                    </dd>
                    <dd class="time">${minutes(step.minutes)}</dd>`,
              )}
            </dl>
            ${topic.objectives.length > 0 &&
            html`<div class="covers">
              <p>${t("covers", topic.objectives.length, s.objectives.length)}</p>
              <ul>
                ${topic.objectives.map((n) => html`<li><${Rich} text=${s.objectives[n]} /></li>`)}
              </ul>
            </div>`}
          </div>`}
        </li>`;
      })}
    </ol>
    ${plan.dropped.length > 0 &&
    html`<section class="dropped">
      <button aria-expanded=${String(showDropped)} onClick=${() => setShowDropped(!showDropped)}>
        ${t("leftOut", plan.dropped.length)}<${Icon} name="down" />
      </button>
      ${showDropped &&
      html`<ul class="view">
        ${plan.dropped.map(
          (x) =>
            html`<li>
              <strong>${x.title}</strong>
              <span>
                ${x.reason === "time" ? t("droppedTime", minutes(x.minutes), Math.round(x.share * 100)) : t("droppedNotNeeded", Math.round(x.share * 100))}${" "}
                <${Rich} text=${x.note} />
              </span>
            </li>`,
        )}
      </ul>`}
    </section>`}
    <footer class="fineprint">
      ${s.objectivesGuessed && html`<p>${t("objectivesGuessed")}</p>`}
      ${s.checks.exercises > 0 && html`<p>${t("checked", s.checks.confirmed + s.checks.moved, s.checks.exercises)}</p>`}
      ${s.checks.rangesDropped > 0 && html`<p>${t("refsDropped", s.checks.rangesDropped)}</p>`}
    </footer>
  `;
}

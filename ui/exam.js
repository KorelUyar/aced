// One exam: Today (the one next thing to do) and Strategy (what matters most, and what is dropped).
import { html, useState, Icon, Lane, daysUntil, minutes, grade, where, firstPage } from "./bits.js";
import { t, longDate } from "./i18n.js";

export const TABS = ["today", "strategy", "plan", "practice", "material"];

export function Exam({ exam, tab, nav, save, notify }) {
  const n = daysUntil(exam.date);
  const [pre, num, post] = t("days", n);
  const go = (next) => nav({ name: "exam", id: exam.id, tab: next });
  const panel =
    tab === "today"
      ? html`<${Today} exam=${exam} nav=${nav} go=${go} save=${save} notify=${notify} />`
      : tab === "strategy"
        ? html`<${Strategy} exam=${exam} days=${n} go=${go} />`
        : html`<p class="muted">${t("notBuilt")}</p>`;

  return html`<main class="page column view">
    <header class="exam-head">
      <h1>${exam.name}</h1>
      <p>${longDate(exam.date, "short")}, ${[pre, num, post].filter((x) => x !== "").join(" ")}</p>
    </header>
    <div class="view" key=${tab} role="tabpanel">${panel}</div>
  </main>`;
}

function NoPlan({ go }) {
  return html`<section class="next">
    <h2>${t("noPlanTitle")}</h2>
    <p class="why">${t("noPlanText")}</p>
    <div class="actions">
      <button class="btn primary" onClick=${() => go("material")}><${Icon} name="plus" />${t("addMaterial")}</button>
    </div>
  </section>`;
}

const taskLabel = (task) => `${t("kind_" + task.kind)}: ${task.title}`;

function Today({ exam, nav, go, save, notify }) {
  if (!exam.today) return html`<${NoPlan} go=${go} />`;
  const { tasks } = exam.today;
  const next = tasks.find((x) => !x.done);
  const later = tasks.filter((x) => !x.done && x !== next);
  const page = next && firstPage(next.step);
  const finish = (task) => save(exam.id, { today: { ...exam.today, tasks: tasks.map((x) => (x.id === task.id ? { ...x, done: true } : x)) } });

  return html`
    ${next
      ? html`<section class="next view" key=${next.id}>
          <p class="kicker">${t("kind_" + next.kind)}, ${t("about", minutes(next.minutes))}</p>
          <h2>${next.title}</h2>
          <p class="where">${next.kind === "quiz" ? where(next.step) : `${t("book")}: ${where(next.step)}`}</p>
          ${next.why && html`<p class="why">${next.why}</p>`}
          <div class="actions">
            ${next.kind === "quiz"
              ? html`<button class="btn primary big" onClick=${() => nav({ name: "quiz", id: exam.id })}>${t("startQuiz")}</button>`
              : html`<button class="btn primary big" onClick=${() => notify(t("sampleBook"))}><${Icon} name="book" />${t("openBook", page)}</button>
                  <button class="btn plain" onClick=${() => finish(next)}>${t("markDone")}</button>`}
          </div>
        </section>`
      : html`<section class="next view">
          <h2>${t("allDoneTitle")}</h2>
          <p class="why">${t("allDoneText", exam.today.tomorrow)}</p>
        </section>`}
    ${later.length > 0 &&
    html`<section class="after">
      <h3>${t("afterThat")}</h3>
      <ul>
        ${later.map((x) => html`<li><span>${taskLabel(x)}</span><span class="muted num">${minutes(x.minutes)}</span></li>`)}
      </ul>
    </section>`}
    ${exam.projected != null &&
    html`<section class="standing">
      <div class="row">
        <strong>${t("onTrack", grade(exam.scale, exam.projected))}</strong>
        <span class="muted">${t("target", grade(exam.scale, exam.target))}</span>
      </div>
      <${Lane} p=${exam.readiness} label=${t("ready", Math.round(exam.readiness * 100))} />
      <small>${t("estimate")}</small>
    </section>`}
  `;
}

function Strategy({ exam, days, go }) {
  const s = exam.strategy;
  const [open, setOpen] = useState(s?.topics[0]?.id);
  const [showDropped, setShowDropped] = useState(false);
  if (!s) return html`<${NoPlan} go=${go} />`;

  return html`
    <header class="strategy-head">
      <h2>${t("strategyTitle", grade(exam.scale, exam.target), Math.max(days, 0))}</h2>
      <p>${s.summary}</p>
      <p class="budget">${t("budget", minutes(s.availableMinutes), minutes(s.plannedMinutes))}</p>
    </header>
    <ol class="topics">
      ${s.topics.map((topic, i) => {
        const expanded = open === topic.id;
        return html`<li class="topic" key=${topic.id}>
          <button class="topic-head" aria-expanded=${String(expanded)} onClick=${() => setOpen(expanded ? null : topic.id)}>
            <span class="rank">${i + 1}</span>
            <span>
              <strong>${topic.title}</strong>
              <span class="tag">${i === 0 && html`<mark>${t("topTag")}</mark>`}${t("share", Math.round(topic.share * 100))}</span>
            </span>
            <span class="time">${minutes(topic.minutes)}</span>
            <${Icon} name="down" />
          </button>
          ${expanded &&
          html`<div class="topic-body view">
            <p class="why">${topic.why}</p>
            <dl class="steps">
              ${topic.steps.map(
                (step) =>
                  html`<dt>${t("step_" + step.kind)}</dt>
                    <dd>${where(step)}</dd>
                    <dd class="time">${minutes(step.minutes)}</dd>`,
              )}
            </dl>
            <p class="covers">${t("covers", topic.objectives, s.objectives)}</p>
          </div>`}
        </li>`;
      })}
    </ol>
    ${s.dropped.length > 0 &&
    html`<section class="dropped">
      <button aria-expanded=${String(showDropped)} onClick=${() => setShowDropped(!showDropped)}>
        ${t("dropped", s.dropped.length)}<${Icon} name="down" />
      </button>
      ${showDropped &&
      html`<ul class="view">
        ${s.dropped.map((x) => html`<li><strong>${x.title}</strong><span>${x.why}</span></li>`)}
      </ul>`}
    </section>`}
  `;
}

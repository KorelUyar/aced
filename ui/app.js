// The window: a title bar, and one view at a time (home, new exam, one exam, a quiz, settings).
import { html, render, useState, useEffect, Icon, Lane, daysUntil } from "./bits.js";
import { t, setLang, lang, errorText } from "./i18n.js";
import { Wizard } from "./wizard.js";
import { Exam, TABS } from "./exam.js";
import { Path, PANELS } from "./path.js";
import { Quiz } from "./quiz.js";
import { Settings } from "./settings.js";

const api = window.spurt;
document.title = api.name;

function App() {
  const [state, setState] = useState(null); // { settings, exams, ai }
  const [route, setRoute] = useState({ name: "home" });
  const [toast, setToast] = useState(null);
  const [panel, setPanel] = useState("book"); // what stands beside the plan: book, formulas, helper, or nothing

  const reload = () =>
    api.state().then((s) => {
      setLang(s.settings.lang);
      setState(s);
    });

  useEffect(() => {
    reload();
    // Coming back to the window on another day: the plan has moved on.
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  if (!state) return null;

  const nav = (next) => setRoute(next);
  // Lets the screenshot and test scripts open a view directly.
  window.__nav = nav;

  const exam = route.id && state.exams.find((e) => e.id === route.id);
  const putExam = (next) =>
    setState((s) => ({ ...s, exams: s.exams.some((e) => e.id === next.id) ? s.exams.map((e) => (e.id === next.id ? next : e)) : [next, ...s.exams] }));
  const app = {
    nav,
    putExam,
    reload,
    notify: setToast,
    fail: (err) => setToast(errorText(err)),
    ai: state.ai,
    openBook: (materialId, page) => api.openBook(exam.id, materialId, page).catch((err) => setToast(api.sample ? t("sampleBook") : errorText(err))),
  };

  const home = { name: "home" };
  const look = state.settings.look || null;
  document.documentElement.dataset.look = look || "";
  let onPath = false;
  let view;
  let back = null; // [label, route]
  if (route.name === "new" || (route.name === "edit" && exam)) {
    const editing = route.name === "edit";
    view = html`<${Wizard}
      draft=${editing ? draftOf(exam) : route.draft}
      step=${route.step}
      editing=${editing}
      onCancel=${() => nav(editing ? { name: "exam", id: exam.id, tab: "material" } : home)}
      onDone=${async (draft) => {
        try {
          const saved = editing ? await api.editExam(exam.id, draft) : await api.createExam(draft);
          putExam(saved);
          // A new exam goes straight to adding the book and the objectives.
          nav({ name: "exam", id: saved.id, tab: editing ? "today" : "material" });
        } catch (err) {
          app.fail(err);
        }
      }}
    />`;
  } else if (route.name === "exam" && exam && look && exam.plan && route.tab !== "material") {
    // The exam on one screen (two looks are being tried: Settings holds which one).
    back = [t("exams"), home];
    onPath = true;
    view = html`<${Path} key=${exam.id} exam=${exam} panel=${panel} setPanel=${setPanel} app=${app} />`;
  } else if (route.name === "exam" && exam) {
    back = look && exam.plan ? [exam.name, { name: "exam", id: exam.id }] : [t("exams"), home];
    view = html`<${Exam} key=${exam.id} exam=${exam} tab=${route.tab || "today"} app=${app} />`;
  } else if (route.name === "quiz" && exam) {
    view = html`<${Quiz} key=${exam.id} exam=${exam} what=${route.what} app=${app} />`;
  } else if (route.name === "settings") {
    back = [route.from?.name === "exam" && exam ? exam.name : t("exams"), route.from || home];
    view = html`<${Settings}
      settings=${state.settings}
      ai=${state.ai}
      onChange=${(next) => {
        if (next.settings) setLang(next.settings.lang);
        setState((s) => ({ ...s, ...next }));
      }}
      app=${app}
    />`;
  } else {
    view = html`<${Home} exams=${state.exams} nav=${nav} />`;
  }

  const focus = ["new", "edit", "quiz"].includes(route.name);
  const tab = route.tab || "today";
  return html`
    <header class="bar">
      ${back
        ? html`<button class="bar-btn" onClick=${() => nav(back[1])}><${Icon} name="back" /><span>${back[0]}</span></button>`
        : html`<span class="wordmark">${focus ? "" : api.name}</span>`}
      ${onPath &&
      html`<nav class="tabs panels" aria-label=${t("panel_book")}>
        ${PANELS.map(
          (id) => html`<button aria-pressed=${String(panel === id)} onClick=${() => setPanel(panel === id ? null : id)}>${t("panel_" + id)}</button>`,
        )}
      </nav>`}
      ${route.name === "exam" &&
      exam &&
      !onPath &&
      !look &&
      html`<nav class="tabs" role="tablist">
        ${TABS.map(
          (id) =>
            html`<button role="tab" aria-selected=${String(id === tab)} onClick=${() => nav({ ...route, tab: id })}>${t("tab_" + id)}</button>`,
        )}
      </nav>`}
      ${onPath &&
      html`<button class="bar-btn setup" onClick=${() => nav({ name: "exam", id: exam.id, tab: "material" })}>${t("setup")}</button>`}
      ${!focus &&
      route.name !== "settings" &&
      !onPath &&
      html`<button
        class="bar-btn square"
        title=${t("settings")}
        aria-label=${t("settings")}
        onClick=${() => nav({ name: "settings", id: route.id, from: route })}
      >
        <${Icon} name="sliders" />
      </button>`}
    </header>
    <div class=${"scroll" + (onPath ? " fill" : "")} key=${route.name + (route.id || "") + lang() + (onPath ? "path" : "")}>${view}</div>
    ${toast && html`<div class="toast" role="status">${toast}</div>`}
  `;
}

const draftOf = (exam) => ({
  name: exam.name,
  dateMode: "date",
  date: exam.date,
  timeMode: exam.time.mode,
  perDay: exam.time.mode === "perDay" ? exam.time.minutes : 45,
  totalHours: exam.time.mode === "total" ? Math.round(exam.time.minutes / 60) : 10,
  scale: exam.scale,
  target: exam.target,
  pace: exam.pace,
});

function Home({ exams, nav }) {
  if (!exams.length) {
    return html`<main class="page view">
      <div class="empty">
        <h1>${t("emptyTitle")}</h1>
        <p>${t("emptyText")}</p>
        <button class="btn primary big" onClick=${() => nav({ name: "new" })}><${Icon} name="plus" />${t("newExam")}</button>
      </div>
    </main>`;
  }
  const sorted = [...exams].sort((a, b) => a.date.localeCompare(b.date));
  return html`<main class="page view">
    <div class="page-head">
      <h1>${t("homeTitle")}</h1>
      <button class="btn primary" onClick=${() => nav({ name: "new" })}><${Icon} name="plus" />${t("newExam")}</button>
    </div>
    <div class="cards">
      ${sorted.map(
        (e) => html`<${ExamCard} key=${e.id} exam=${e} open=${() => nav({ name: "exam", id: e.id, tab: e.strategy ? "today" : "material" })} />`,
      )}
    </div>
  </main>`;
}

function ExamCard({ exam, open }) {
  const [pre, n, post] = t("days", daysUntil(exam.date));
  const percent = Math.round(exam.readiness * 100);
  return html`<button class="exam-card" onClick=${open}>
    <span class="exam-name">${exam.name}</span>
    <span class="exam-foot">
      <span class="exam-line">
        <span class="days">${pre && html`<span class="pre">${pre}</span>`}${n !== "" && html`<b>${n}</b>`}${post}</span>
        <span>${exam.strategy ? t("ready", percent) : t("noMaterial")}</span>
      </span>
      <${Lane} p=${exam.readiness} label=${t("ready", percent)} />
    </span>
  </button>`;
}

render(html`<${App} />`, document.getElementById("root"));

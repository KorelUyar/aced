// The window: a title bar, and one view at a time (home, new exam, one exam, a quiz, settings).
import { html, render, useState, useEffect, Icon, Lane, Segmented, daysUntil } from "./bits.js";
import { t, setLang, lang } from "./i18n.js";
import { Wizard } from "./wizard.js";
import { Exam, TABS } from "./exam.js";
import { Quiz } from "./quiz.js";

const api = window.spurt;
document.title = api.name;

function App() {
  const [state, setState] = useState(null); // { settings, exams }
  const [route, setRoute] = useState({ name: "home" });
  const [toast, setToast] = useState(null);

  useEffect(() => {
    api.state().then((s) => {
      setLang(s.settings.lang);
      setState(s);
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  if (!state) return null;

  const nav = (next) => setRoute(next);
  // Lets the screenshot script open a view directly.
  window.__nav = nav;

  const reload = async () => setState(await api.state());
  const exam = route.id && state.exams.find((e) => e.id === route.id);
  const saveExam = async (id, patch) => {
    await api.updateExam(id, patch);
    await reload();
  };
  const setSettings = async (patch) => {
    const settings = await api.setSettings(patch);
    setLang(settings.lang);
    setState({ ...state, settings });
  };

  const home = { name: "home" };
  let view;
  let back = null; // [label, route]
  if (route.name === "new") {
    view = html`<${Wizard}
      draft=${route.draft}
      step=${route.step}
      onCancel=${() => nav(home)}
      onCreate=${async (draft) => {
        const created = await api.createExam(draft);
        await reload();
        nav({ name: "exam", id: created.id, tab: "today" });
      }}
    />`;
  } else if (route.name === "exam" && exam) {
    back = [t("exams"), home];
    view = html`<${Exam} key=${exam.id} exam=${exam} tab=${route.tab || "today"} nav=${nav} save=${saveExam} notify=${setToast} />`;
  } else if (route.name === "quiz" && exam?.quiz) {
    view = html`<${Quiz} key=${exam.id} exam=${exam} nav=${nav} save=${saveExam} notify=${setToast} />`;
  } else if (route.name === "settings") {
    back = [route.from?.name === "exam" && exam ? exam.name : t("exams"), route.from || home];
    view = html`<${Settings} settings=${state.settings} set=${setSettings} />`;
  } else {
    view = html`<${Home} exams=${state.exams} nav=${nav} />`;
  }

  const focus = route.name === "new" || route.name === "quiz";
  const tab = route.tab || "today";
  return html`
    <header class="bar">
      ${back
        ? html`<button class="bar-btn" onClick=${() => nav(back[1])}><${Icon} name="back" />${back[0]}</button>`
        : html`<span class="wordmark">${focus ? "" : api.name}</span>`}
      ${route.name === "exam" &&
      exam &&
      html`<nav class="tabs" role="tablist">
        ${TABS.map(
          (id) =>
            html`<button role="tab" aria-selected=${String(id === tab)} onClick=${() => nav({ ...route, tab: id })}>${t("tab_" + id)}</button>`,
        )}
      </nav>`}
      ${!focus &&
      route.name !== "settings" &&
      html`<button
        class="bar-btn square"
        title=${t("settings")}
        aria-label=${t("settings")}
        onClick=${() => nav({ name: "settings", id: route.id, from: route })}
      >
        <${Icon} name="sliders" />
      </button>`}
    </header>
    <div class="scroll" key=${route.name + (route.id || "") + lang()}>${view}</div>
    ${toast && html`<div class="toast" role="status">${toast}</div>`}
  `;
}

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
      ${sorted.map((e) => html`<${ExamCard} key=${e.id} exam=${e} open=${() => nav({ name: "exam", id: e.id, tab: "today" })} />`)}
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

function Settings({ settings, set }) {
  return html`<main class="page column view settings">
    <h1>${t("settings")}</h1>
    <div class="setting">
      <strong>${t("language")}</strong>
      <${Segmented}
        label=${t("language")}
        value=${settings.lang}
        options=${[
          ["en", "English"],
          ["de", "Deutsch"],
        ]}
        onChange=${(v) => set({ lang: v })}
      />
    </div>
    <div class="setting">
      <strong>${t("appearance")}</strong>
      <${Segmented}
        label=${t("appearance")}
        value=${settings.appearance}
        options=${["system", "light", "dark"].map((id) => [id, t("ap_" + id)])}
        onChange=${(v) => set({ appearance: v })}
      />
    </div>
    ${api.sample && html`<p class="note">${t("sampleNote")}</p>`}
  </main>`;
}

render(html`<${App} />`, document.getElementById("root"));

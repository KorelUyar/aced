// The window: a title bar, and one view at a time (the exams, a new exam, one exam with its
// plan and book, its material and settings, an exam being taken, the app's settings).
import { html, render, useState, useEffect, useRef, Icon, Lane, RunNote, daysUntil } from "./bits.js";
import { t, setLang, lang, errorText, longDate } from "./i18n.js";
import { Wizard } from "./wizard.js";
import { Path, PANELS } from "./path.js";
import { Setup } from "./setup.js";
import { Questions } from "./final.js";
import { Settings } from "./settings.js";

const api = window.aced;
document.title = api.name;

function App() {
  const [state, setState] = useState(null); // { settings, exams, ai, damaged }
  const [runs, setRuns] = useState({}); // what the main process is working on, per exam
  const [route, setRoute] = useState({ name: "home" });
  const [toast, setToast] = useState(null);
  const [panel, setPanel] = useState("book"); // what stands beside the plan: the book, the formula sheet, or nothing
  const [helper, setHelper] = useState(false); // the helper, over the plan
  const [talks, setTalks] = useState({}); // exam id -> { turns: [{ question, answer?, pages?, error? }], busy }
  const routeNow = useRef(route);
  routeNow.current = route;
  const moves = useRef(0);

  const reload = () =>
    api.state().then((s) => {
      setLang(s.settings.lang);
      document.documentElement.lang = s.settings.lang;
      setRuns(s.runs || {});
      setState(s);
    });

  useEffect(() => {
    reload();
    // Coming back to the window on another day: the plan has moved on.
    window.addEventListener("focus", reload);
    const stopRuns = api.onRuns(setRuns);
    // The AI read pictures of an exam's material in the background: the exam as it is now.
    const stopExam = api.onExam((next) => setState((s) => (s ? { ...s, exams: s.exams.map((e) => (e.id === next.id ? next : e)) } : s)));
    const stopMenu = api.onMenu((what) => {
      const from = routeNow.current;
      if (what === "settings" && from.name !== "settings") setRoute({ name: "settings", id: from.id, from, n: (moves.current += 1) });
      if (what === "new") setRoute({ name: "new", n: (moves.current += 1) });
    });
    return () => {
      window.removeEventListener("focus", reload);
      stopRuns();
      stopExam();
      stopMenu();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.action ? 8000 : 3600);
    return () => clearTimeout(id);
  }, [toast]);

  if (!state) return null;

  // Every move to a view opens it anew (a second "new exam" does not inherit the first one's answers).
  const nav = (next) => setRoute({ ...next, n: (moves.current += 1) });
  // Lets the screenshot and test scripts open a view directly.
  window.__nav = nav;

  const exam = route.id && state.exams.find((e) => e.id === route.id);
  const putExam = (next) =>
    setState((s) => ({ ...s, exams: s.exams.some((e) => e.id === next.id) ? s.exams.map((e) => (e.id === next.id ? next : e)) : [next, ...s.exams] }));
  const app = {
    nav,
    putExam,
    reload,
    notify: (text, action) => setToast({ text, action }),
    fail: (err) => setToast({ text: errorText(err) }),
    ai: state.ai,
    // Where the person is right now: something that ends later only moves them if they are still there.
    at: () => routeNow.current,
  };

  // A question to the helper. The conversation is kept here, so it is still there after a
  // look at the book, at the material, or at another exam.
  const ask = (examId, question, now) => {
    const mine = talks[examId] || { turns: [], busy: false };
    if (!question.trim() || mine.busy) return;
    const earlier = mine.turns.filter((x) => x.answer).map((x) => ({ question: x.question, answer: x.answer }));
    const settle = (patch) =>
      setTalks((all) => {
        const turns = [...all[examId].turns];
        turns[turns.length - 1] = { ...turns[turns.length - 1], ...patch };
        return { ...all, [examId]: { turns, busy: false } };
      });
    setTalks((all) => ({ ...all, [examId]: { turns: [...mine.turns.filter((x) => !x.error), { question }], busy: true } }));
    api.help(examId, question, { earlier, now }).then(
      (reply) => settle(reply),
      (error) => settle({ error }),
    );
  };

  const home = { name: "home" };
  const toSettings = (from) => () => nav({ name: "settings", id: from.id, from });
  let onPath = false;
  let view;
  let back = null; // [label, route]
  if (state.damaged) {
    view = html`<${Damaged} info=${state.damaged} reload=${reload} app=${app} />`;
  } else if (route.name === "new" || (route.name === "edit" && exam)) {
    const editing = route.name === "edit";
    const leave = editing ? { name: "setup", id: exam.id } : home;
    view = html`<${Wizard}
      draft=${editing ? draftOf(exam) : route.draft}
      step=${route.step}
      editing=${editing}
      onCancel=${() => nav(leave)}
      onDone=${async (draft) => {
        try {
          const saved = editing ? await api.editExam(exam.id, draft) : await api.createExam(draft);
          putExam(saved);
          // A new exam goes straight to adding the book and the objectives.
          nav(editing ? leave : { name: "exam", id: saved.id });
        } catch (err) {
          app.fail(err);
        }
      }}
    />`;
  } else if (route.name === "exam" && exam && exam.strategy) {
    // The exam on one screen: the plan, with the book or the formula sheet beside it.
    back = [t("exams"), home];
    onPath = true;
    view = html`<${Path}
      key=${exam.id}
      exam=${exam}
      run=${runs[exam.id]}
      panel=${panel}
      setPanel=${setPanel}
      helper=${helper}
      setHelper=${setHelper}
      talk=${talks[exam.id] || { turns: [], busy: false }}
      ask=${(question, now) => ask(exam.id, question, now)}
      app=${app}
    />`;
  } else if ((route.name === "exam" || route.name === "setup") && exam) {
    // Material and settings of an exam. A new exam starts here: without material there is no plan.
    back = exam.strategy ? [exam.name, { name: "exam", id: exam.id }] : [t("exams"), home];
    view = html`<${Setup} key=${exam.id} exam=${exam} run=${runs[exam.id]} app=${app} toSettings=${toSettings({ name: "setup", id: exam.id })} />`;
  } else if (route.name === "set" && exam) {
    view = html`<${Questions} key=${exam.id + JSON.stringify(route.what)} exam=${exam} what=${route.what} run=${runs[exam.id]} app=${app} toSettings=${toSettings(route)} />`;
  } else if (route.name === "settings") {
    back = [route.from && route.from.id && exam ? exam.name : t("exams"), route.from || home];
    view = html`<${Settings}
      settings=${state.settings}
      ai=${state.ai}
      onChange=${(next) => {
        if (next.settings) {
          setLang(next.settings.lang);
          document.documentElement.lang = next.settings.lang;
        }
        setState((s) => ({ ...s, ...next }));
      }}
      app=${app}
    />`;
  } else {
    const read = () => api.setSettings({ moved: null }).then((next) => setState((s) => ({ ...s, ...next })), app.fail);
    view = html`<${Home} exams=${state.exams} runs=${runs} nav=${nav} moved=${state.settings.moved} onRead=${read} toSettings=${() => read().then(() => nav({ name: "settings", from: home }))} />`;
  }

  const focus = ["new", "edit", "set"].includes(route.name) || state.damaged;
  return html`
    <header class="bar">
      ${back
        ? html`<button class="bar-btn" onClick=${() => nav(back[1])}><${Icon} name="back" /><span>${back[0]}</span></button>`
        : html`<span class="wordmark">${focus ? "" : api.name}</span>`}
      ${onPath &&
      html`<nav class="tabs panels" aria-label=${t("panels")}>
        ${PANELS.map(
          (id) => html`<button aria-pressed=${String(panel === id)} onClick=${() => setPanel(panel === id ? null : id)}>${t("panel_" + id)}</button>`,
        )}
      </nav>`}
      ${onPath &&
      html`<span class="bar-end">
        <button class="bar-btn" id="helperToggle" aria-pressed=${String(helper)} onClick=${() => setHelper(!helper)}>${t("helper")}</button>
        <button class="bar-btn" id="toSetup" onClick=${() => nav({ name: "setup", id: exam.id })}>${t("setup")}</button>
      </span>`}
      ${!focus &&
      route.name !== "settings" &&
      !onPath &&
      html`<button class="bar-btn square" title=${t("settings")} aria-label=${t("settings")} onClick=${() => nav({ name: "settings", id: route.id, from: route })}>
        <${Icon} name="sliders" />
      </button>`}
    </header>
    <div class=${"scroll" + (onPath ? " fill" : "")} key=${route.name + (route.id || "") + (route.n || 0) + lang() + (onPath ? "path" : "")}>${view}</div>
    ${toast &&
    html`<div class="toast" role="status">
      <span>${toast.text}</span>
      ${toast.action &&
      html`<button
        class="toast-btn"
        onClick=${() => {
          toast.action.run();
          setToast(null);
        }}
      >
        ${toast.action.label}
      </button>`}
    </div>`}
  `;
}

const draftOf = (exam) => ({
  name: exam.name,
  dateMode: "date",
  date: exam.date,
  timeMode: exam.time.mode,
  perDay: exam.time.mode === "perDay" ? exam.time.minutes : 45,
  totalHours: exam.time.mode === "total" ? Math.max(1, Math.round(exam.time.minutes / 60)) : 10,
  scale: exam.scale,
  target: exam.target,
  pace: exam.pace,
});

/** The data file could not be read. Nothing is written until the person has decided what to do. */
function Damaged({ info, reload, app }) {
  const recover = (how) => api.recoverData(how).then(reload, app.fail);
  return html`<main class="page focus view">
    <section class="question">
      <h1>${t("damagedTitle")}</h1>
      <p class="lead">${t("damagedText")}</p>
      ${info.backup ? html`<p class="lead">${t("damagedBackup", longDate(info.backup.slice(0, 10)))}</p>` : html`<p class="lead">${t("damagedNoBackup")}</p>`}
      <div class="row-start">
        ${info.backup && html`<button class="btn primary" id="useBackup" onClick=${() => recover("backup")}>${t("damagedUseBackup")}</button>`}
        <button class=${"btn " + (info.backup ? "second" : "primary")} id="startEmpty" onClick=${() => recover("empty")}>${t("damagedStartEmpty")}</button>
        <button class="btn plain" onClick=${() => api.revealData()}>${t("damagedShow")}</button>
      </div>
    </section>
  </main>`;
}

/** Said once after the first start under the new name: where the exams came from, and what could not come along. */
function Moved({ moved, onRead, toSettings }) {
  return html`<div class="plan-note moved" role="status">
    <p>${t(moved.failed ? "movedFailed" : "movedText")}${moved.keys ? " " + t("movedKeys") : ""}</p>
    <div class="row-start">
      ${moved.keys && html`<button class="btn second" id="movedSettings" onClick=${toSettings}>${t("openSettings")}</button>`}
      <button class="btn plain" id="movedOk" onClick=${onRead}>${t("movedOk")}</button>
    </div>
  </div>`;
}

function Home({ exams, runs, nav, moved, onRead, toSettings }) {
  if (!exams.length) {
    return html`<main class="page view">
      ${moved && html`<${Moved} moved=${moved} onRead=${onRead} toSettings=${toSettings} />`}
      <div class="empty">
        <p class="what">${t("whatItIs")}</p>
        <h1>${t("emptyTitle")}</h1>
        <p>${t("emptyText")}</p>
        <button class="btn primary big" onClick=${() => nav({ name: "new" })}><${Icon} name="plus" />${t("newExam")}</button>
      </div>
    </main>`;
  }
  const sorted = [...exams].sort((a, b) => a.date.localeCompare(b.date));
  return html`<main class="page view">
    ${moved && html`<${Moved} moved=${moved} onRead=${onRead} toSettings=${toSettings} />`}
    <div class="page-head">
      <h1>${t("homeTitle")}</h1>
      <button class="btn primary" onClick=${() => nav({ name: "new" })}><${Icon} name="plus" />${t("newExam")}</button>
    </div>
    <div class="cards">${sorted.map((e) => html`<${ExamCard} key=${e.id} exam=${e} run=${runs[e.id]} open=${() => nav({ name: "exam", id: e.id })} />`)}</div>
  </main>`;
}

function ExamCard({ exam, run, open }) {
  const [pre, n, post] = t("days", daysUntil(exam.date));
  const next = exam.plan && exam.plan.today.steps ? t("todayShort", exam.plan.today.steps, exam.plan.today.minutes) : "";
  return html`<button class="exam-card" onClick=${open}>
    <span class="exam-top">
      <span class="exam-name">${exam.name}</span>
      ${exam.strategy && html`<span class="exam-percent num"><b>${exam.percent}</b>%</span>`}
    </span>
    <span class="exam-foot">
      <span class="exam-line">
        <span class="days">${pre && html`<span class="pre">${pre}</span>`}${n !== "" && html`<b>${n}</b>`}${post}</span>
        <span>${run ? html`<${RunNote} run=${run} brief=${true} />` : exam.strategy ? next || (exam.percent === 100 ? t("planAllDone") : "") : t("noMaterial")}</span>
      </span>
      <${Lane} p=${exam.percent / 100} label=${t("planDone", exam.percent)} />
    </span>
  </button>`;
}

render(html`<${App} />`, document.getElementById("root"));

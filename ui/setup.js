// Material and settings of one exam: the book, the learning objectives and anything else that
// is exam material go in here, and the strategy is worked out from here. A new exam lands on
// this view; later it sits behind "Material and settings".
import { html, useState, useEffect, useRef, Icon, RunNote, thousands, money, modelName, minutes, grade, daysUntil } from "./bits.js";
import { t, errorCode, longDate } from "./i18n.js";
import { ClaudeState, Problem } from "./claude.js";

const api = window.spurt;
const KINDS = ["book", "objectives", "slides", "notes", "oldExam"];

export function Setup({ exam, run, app, toSettings }) {
  const [over, setOver] = useState(false);
  const [problems, setProblems] = useState([]);
  const [pasting, setPasting] = useState(null); // null, or { id: material being changed or null, text }
  const [estimate, setEstimate] = useState(null);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const here = useRef(true);
  const box = useRef(null);
  useEffect(() => () => (here.current = false), []);
  useEffect(() => {
    if (pasting && box.current) box.current.focus();
  }, [Boolean(pasting)]);

  const added = ({ exam: next, problems: found }) => {
    app.putExam(next);
    setProblems(found);
  };
  const fail = (err) => errorCode(err) !== "cancelled" && app.fail(err);
  const drop = (e) => {
    e.preventDefault();
    setOver(false);
    const paths = Array.from(e.dataTransfer.files || [], (file) => api.pathOf(file)).filter(Boolean);
    if (paths.length) api.addMaterial(exam.id, paths).then(added, fail);
  };
  const remove = (m) =>
    api.removeMaterial(exam.id, m.id).then(({ exam: next, removed }) => {
      app.putExam(next);
      // One click removes it, one click brings it back.
      if (removed) app.notify(t("removed", removed.title), { label: t("undo"), run: () => api.restoreMaterial(exam.id, removed).then(app.putExam, app.fail) });
    }, app.fail);
  const savePaste = () =>
    (pasting.id ? api.changeText(exam.id, pasting.id, pasting.text) : api.addText(exam.id, "objectives", t("objectivesTitle"), pasting.text)).then(
      (next) => {
        app.putExam(next);
        setPasting(null);
      },
      (err) => (errorCode(err) === "duplicate" ? app.notify(t("problem_duplicateText")) : app.fail(err)),
    );
  const openText = (m) => api.readText(exam.id, m.id).then((text) => setPasting({ id: m.id, text }), app.fail);

  const ask = () => {
    setError(null);
    api.estimate(exam.id).then((est) => here.current && setEstimate(est), fail);
  };
  const start = (again) => {
    setError(null);
    setEstimate(null);
    api.analyze(exam.id, { again }).then(
      ({ exam: next, kept, lost }) => {
        app.putExam(next);
        if (lost > 0) app.notify(t("progressLost", lost, kept));
        // Only someone still looking at this exam is taken to its plan.
        const at = app.at();
        if (at.id === exam.id && (at.name === "setup" || at.name === "exam")) app.nav({ name: "exam", id: exam.id });
      },
      (err) => here.current && errorCode(err) !== "cancelled" && setError(err),
    );
  };

  const first = exam.materials.length === 0;
  const tokens = exam.usage ? exam.usage.input + exam.usage.output : 0;
  const s = exam.strategy;
  const n = daysUntil(exam.date);
  const [pre, days, post] = t("days", n);

  return html`<main class="page setup view">
    ${!s && html`<h1 class="setup-title">${exam.name}</h1>`}
    ${first && html`<p class="lead">${t("materialLead")}</p>`}

    ${s &&
    html`<section class="facts">
      <div class="section-head">
        <h2>${t("examFacts")}</h2>
        <button class="link" id="editExam" onClick=${() => app.nav({ name: "edit", id: exam.id })}><${Icon} name="pencil" size=${14} />${t("change")}</button>
      </div>
      <dl>
        <dt>${t("factName")}</dt>
        <dd>${exam.name}</dd>
        <dt>${t("factDate")}</dt>
        <dd>${longDate(exam.date)} <span class="muted">(${[pre, days, post].filter((x) => x !== "").join(" ")})</span></dd>
        <dt>${t("factTime")}</dt>
        <dd>${exam.time.mode === "perDay" ? t("factPerDay", minutes(exam.time.minutes)) : t("factTotal", minutes(exam.time.minutes))}</dd>
        <dt>${t("factTarget")}</dt>
        <dd>${grade(exam.scale, exam.target)} <span class="muted">(${t("scale_" + exam.scale)})</span></dd>
        <dt>${t("factPace")}</dt>
        <dd>${t("pace_" + exam.pace)}</dd>
      </dl>
    </section>`}

    <section class="material">
      ${s && html`<div class="section-head"><h2>${t("materialTitle")}</h2></div>`}
      <div
        class=${"drop" + (over ? " over" : "") + (first ? " first" : "")}
        onDragOver=${(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave=${() => setOver(false)}
        onDrop=${drop}
      >
        ${run && run.kind === "read"
          ? html`<${RunNote} run=${run} onCancel=${() => api.cancel(exam.id)} />`
          : html`<${Icon} name="drop" size=${22} />
              <div>
                <strong>${t("dropHere")}</strong>
                <p>${t("dropHint")}</p>
              </div>
              <button class="btn second" id="chooseFiles" disabled=${Boolean(run)} onClick=${() => api.chooseMaterial(exam.id).then(added, fail)}>${t("chooseFiles")}</button>`}
      </div>
      ${problems.map((p) => html`<p class=${"problem" + (p.code === "duplicate" || p.code === "cut" ? " mild" : "")} role="alert">${t("problem_" + p.code, p.title, p.detail)}</p>`)}

      ${exam.materials.length > 0 &&
      html`<ul class="materials">
        ${exam.materials.map(
          (m) =>
            html`<li key=${m.id} class=${m.scanned ? "scanned" : ""}>
              <div>
                ${m.type === "text" ? html`<button class="link strong" title=${t("viewText")} onClick=${() => openText(m)}>${m.title}</button>` : html`<strong>${m.title}</strong>`}
                <span>${m.scanned ? t("scannedNote") : m.type === "pdf" ? t("pagesCount", m.pages) + (m.recognised ? ", " + t("recognisedNote") : "") : t("pastedText")}</span>
              </div>
              <select aria-label=${t("kindOf", m.title)} value=${m.kind} onChange=${(e) => api.setMaterialKind(exam.id, m.id, e.target.value).then(app.putExam, app.fail)}>
                ${KINDS.map((k) => html`<option value=${k}>${t("kind_" + k)}</option>`)}
              </select>
              <button class="mini" title=${t("remove")} aria-label=${t("removeThis", m.title)} onClick=${() => remove(m)}><${Icon} name="x" size=${14} /></button>
            </li>`,
        )}
      </ul>`}

      ${pasting
        ? html`<div class="paste view">
            <textarea
              ref=${box}
              class="answer"
              rows="7"
              placeholder=${t("objectivesPlaceholder")}
              aria-label=${t("pasteObjectives")}
              value=${pasting.text}
              onInput=${(e) => setPasting({ ...pasting, text: e.target.value })}
            ></textarea>
            <div class="row-end">
              <button class="btn plain" onClick=${() => setPasting(null)}>${t("cancel")}</button>
              <button class="btn second" id="addObjectives" disabled=${!pasting.text.trim()} onClick=${savePaste}>${t(pasting.id ? "save" : "addObjectives")}</button>
            </div>
          </div>`
        : html`<button class="link add-text" id="paste" onClick=${() => setPasting({ id: null, text: "" })}><${Icon} name="plus" />${t("pasteObjectives")}</button>`}
    </section>

    ${!first &&
    html`<section class="analysis">
      ${s &&
      html`<div class="section-head"><h2>${t("strategyTitle")}</h2></div>
        <p class="strategy-state">
          ${t("strategyMade", longDate(s.createdOn), s.model && s.model !== "sample" ? modelName(s.model) : "", s.pagesRead || 0)}
          ${s.stale && html`${" "}<strong>${t("strategyStale")}</strong>`}
        </p>`}
      ${run && run.kind !== "read"
        ? html`<${RunNote} run=${run} onCancel=${() => api.cancel(exam.id)} />`
        : estimate
          ? html`<${Estimate} est=${estimate} exam=${exam} onStart=${start} onCancel=${() => setEstimate(null)} onAgain=${ask} toSettings=${toSettings} />`
          : html`<div class="go">
              <button class=${"btn big " + (s && !s.stale ? "second" : "primary")} id="workOut" disabled=${Boolean(run)} onClick=${ask}>${t(s ? "workOutAgain" : "workOut")}</button>
              <p>${t("privacy")}</p>
            </div>`}
      ${error && !run && html`<${Problem} error=${error} onRetry=${ask} toSettings=${toSettings} />`}
    </section>`}

    <footer class="fineprint">
      ${tokens > 0 && html`<p>${t("usage", thousands(tokens), exam.usage.cost > 0 ? money(exam.usage.cost) : "")}</p>`}
      <p class="exam-actions">
        ${!s && html`<button class="link" id="editExam" onClick=${() => app.nav({ name: "edit", id: exam.id })}>${t("editExam")}</button>`}
        ${deleting
          ? html`<span>
              ${t("deleteSure")}${" "}
              <button
                class="link danger"
                id="deleteYes"
                onClick=${() =>
                  api.deleteExam(exam.id).then(() => {
                    app.reload();
                    app.nav({ name: "home" });
                  }, app.fail)}
              >
                ${t("deleteYes")}
              </button>
              ${" "}<button class="link" onClick=${() => setDeleting(false)}>${t("cancel")}</button>
            </span>`
          : html`<button class="link" id="delete" onClick=${() => setDeleting(true)}>${t("deleteExam")}</button>`}
      </p>
    </footer>
  </main>`;
}

function Estimate({ est, exam, onStart, onCancel, onAgain, toSettings }) {
  const cancel = html`<button class="btn plain" onClick=${onCancel}>${t("cancel")}</button>`;
  if (est.blocked) {
    return html`<div class="estimate view">
      <p>${t("err_" + est.blocked)}</p>
      <div class="row-end"><button class="btn plain" onClick=${onCancel}>${t("close")}</button></div>
    </div>`;
  }
  // Claude Code is chosen but not installed or not signed in: that comes first, with its own
  // buttons (get it, sign in, or use another AI), so nobody is sent round in a circle.
  if (est.claude && !(est.claude.installed && est.claude.signedIn !== false && !est.claude.expired)) {
    return html`<div class="estimate view">
      <${ClaudeState} onSignedIn=${onAgain} toSettings=${toSettings} />
      <div class="row-end">${cancel}</div>
    </div>`;
  }
  if (!est.ready) {
    return html`<div class="estimate view">
      <p>${t(est.provider ? "needKey" : "needAi")}</p>
      <div class="row-end">
        ${cancel}
        <button class="btn primary" id="toSettings" onClick=${toSettings}>${t("openSettings")}</button>
      </div>
    </div>`;
  }
  return html`<div class="estimate view">
    <h3>${t("estTitle")}</h3>
    <p>
      ${t("estTokens", thousands(est.input), thousands(est.output))}${est.inputMax > est.input * 1.2 ? " " + t("estTokensMax", thousands(est.inputMax)) : ""}${" "}
      ${est.provider === "claudeCode"
        ? t("estSubscription", modelName(est.model))
        : est.cost != null
          ? t("estCost", money(est.cost), modelName(est.model), est.costMax > est.cost * 1.2 ? money(est.costMax) : "")
          : t("estUnknown", modelName(est.model))}
    </p>
    <p>${t("estTime")}</p>
    ${est.finds && html`<p>${t("estFinds")}</p>`}
    ${est.noObjectives && html`<p>${t("estNoObjectives")}</p>`}
    ${est.scanned.length > 0 && html`<p>${t("estScanned", est.scanned.join(", "))}</p>`}
    ${est.unchanged && html`<p class="warn">${t("estUnchanged")}</p>`}
    ${exam.strategy && est.ticked > 0 && html`<p class="warn">${t("estTicked", est.ticked)}</p>`}
    <div class="row-end">
      ${cancel}
      <button class="btn primary" id="startAnalysis" onClick=${() => onStart(Boolean(est.unchanged))}>${t(est.unchanged ? "startAnyway" : "start")}</button>
    </div>
  </div>`;
}

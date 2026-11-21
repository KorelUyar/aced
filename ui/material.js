// Material: the book, the learning objectives and anything else that is exam material go in
// here, and the strategy is worked out from here. A new exam lands on this view.
import { html, useState, useEffect, Icon, thousands, money, modelName } from "./bits.js";
import { t, errorText, errorCode } from "./i18n.js";
import { ClaudeState, Problem } from "./claude.js";

const api = window.spurt;
const KINDS = ["book", "objectives", "slides", "notes", "oldExam"];

export function Material({ exam, app }) {
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState(null); // what the main process is doing right now
  const [problems, setProblems] = useState([]);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [estimate, setEstimate] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => api.onProgress((p) => p.examId === exam.id && setProgress(p.stage === "idle" ? null : p)), [exam.id]);

  const added = ({ exam: next, problems: found }) => {
    app.putExam(next);
    setProblems(found);
  };
  const change = (promise) => promise.then(app.putExam, app.fail);
  const drop = (e) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) api.addMaterial(exam.id, e.dataTransfer.files).then(added, app.fail);
  };
  const addObjectives = () =>
    api.addText(exam.id, "objectives", t("objectivesTitle"), text).then((next) => {
      app.putExam(next);
      setText("");
      setPasting(false);
    }, app.fail);

  const ask = () => {
    setError(null);
    api.estimate(exam.id).then(setEstimate, app.fail);
  };
  const start = () => {
    setRunning(true);
    setError(null);
    api
      .analyze(exam.id)
      .then((next) => {
        app.putExam(next);
        app.nav({ name: "exam", id: exam.id, tab: "today" });
      })
      .catch((err) => {
        if (errorCode(err) !== "cancelled") setError(err);
      })
      .finally(() => {
        setRunning(false);
        setEstimate(null);
      });
  };

  const first = exam.materials.length === 0;
  const reading = progress && progress.stage === "read";
  const tokens = exam.usage ? exam.usage.input + exam.usage.output : 0;

  return html`
    ${first && html`<p class="lead">${t("materialLead")}</p>`}

    <section
      class=${"drop" + (over ? " over" : "") + (first ? " first" : "")}
      onDragOver=${(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave=${() => setOver(false)}
      onDrop=${drop}
    >
      <${Icon} name="drop" size=${22} />
      <div>
        <strong>${reading ? t(progress.phase === "recognise" ? "recognising" : "reading", progress.title, progress.done, progress.total) : t("dropHere")}</strong>
        ${!reading && html`<p>${t("dropHint")}</p>`}
      </div>
      ${reading
        ? html`<button class="btn second" id="cancelRead" onClick=${() => api.cancel()}>${t("cancel")}</button>`
        : html`<button class="btn second" onClick=${() => api.chooseMaterial(exam.id).then(added, app.fail)}>${t("chooseFiles")}</button>`}
    </section>
    ${problems.map((p) => html`<p class="problem" role="alert">${t("problem_" + p.code, p.title)}</p>`)}

    ${exam.materials.length > 0 &&
    html`<ul class="materials">
      ${exam.materials.map(
        (m) =>
          html`<li key=${m.id} class=${m.scanned ? "scanned" : ""}>
            <div>
              <strong>${m.title}</strong>
              <span>${m.scanned ? t("scannedNote") : m.type === "pdf" ? t("pagesCount", m.pages) + (m.recognised ? ", " + t("recognisedNote") : "") : t("pastedText")}</span>
            </div>
            <select aria-label=${m.title} value=${m.kind} onChange=${(e) => change(api.setMaterialKind(exam.id, m.id, e.target.value))}>
              ${KINDS.map((k) => html`<option value=${k}>${t("kind_" + k)}</option>`)}
            </select>
            <button class="mini" title=${t("remove")} aria-label=${t("remove")} onClick=${() => change(api.removeMaterial(exam.id, m.id))}>
              <${Icon} name="x" size=${14} />
            </button>
          </li>`,
      )}
    </ul>`}

    ${pasting
      ? html`<section class="paste view">
          <textarea
            class="answer"
            rows="6"
            placeholder=${t("objectivesPlaceholder")}
            aria-label=${t("pasteObjectives")}
            value=${text}
            onInput=${(e) => setText(e.target.value)}
          ></textarea>
          <div class="row-end">
            <button class="btn plain" onClick=${() => setPasting(false)}>${t("cancel")}</button>
            <button class="btn second" id="addObjectives" disabled=${!text.trim()} onClick=${addObjectives}>${t("addObjectives")}</button>
          </div>
        </section>`
      : html`<button class="link add-text" id="paste" onClick=${() => setPasting(true)}><${Icon} name="plus" />${t("pasteObjectives")}</button>`}

    ${!first &&
    html`<section class="analysis">
      ${running
        ? html`<div class="running" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <span>${t(progress && progress.stage !== "read" ? "stage_" + progress.stage : "stage_strategy")}</span>
            <button class="btn plain" onClick=${() => api.cancel()}>${t("cancel")}</button>
          </div>`
        : estimate
          ? html`<${Estimate} est=${estimate} onStart=${start} onCancel=${() => setEstimate(null)} onAgain=${ask} app=${app} exam=${exam} />`
          : html`<div class="go">
              <button class="btn primary big" id="workOut" disabled=${reading} onClick=${ask}>${t(exam.strategy ? "workOutAgain" : "workOut")}</button>
              <p>${t("privacy")}</p>
            </div>`}
      ${error &&
      !running &&
      html`<${Problem}
        error=${error}
        onRetry=${() => {
          setError(null);
          ask();
        }}
        toSettings=${() => app.nav({ name: "settings", id: exam.id, from: { name: "exam", id: exam.id, tab: "material" } })}
      />`}
    </section>`}

    <footer class="fineprint">
      ${tokens > 0 && html`<p>${t("usage", thousands(tokens), exam.usage.cost > 0 ? money(exam.usage.cost) : "")}</p>`}
      <p class="exam-actions">
        <button class="link" onClick=${() => app.nav({ name: "edit", id: exam.id })}>${t("editExam")}</button>
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
  `;
}

function Estimate({ est, exam, onStart, onCancel, onAgain, app }) {
  if (est.blocked) {
    return html`<div class="estimate view">
      <p>${t("err_" + est.blocked)}</p>
      <div class="row-end"><button class="btn plain" onClick=${onCancel}>${t("close")}</button></div>
    </div>`;
  }
  if (!est.ready) {
    return html`<div class="estimate view">
      <p>${t("needAi")}</p>
      <div class="row-end">
        <button class="btn plain" onClick=${onCancel}>${t("cancel")}</button>
        <button class="btn primary" onClick=${() => app.nav({ name: "settings", id: exam.id, from: { name: "exam", id: exam.id, tab: "material" } })}>
          ${t("openSettings")}
        </button>
      </div>
    </div>`;
  }
  // Claude Code is chosen but not installed or not signed in: that comes first, with its button.
  if (est.claude && !(est.claude.installed && est.claude.signedIn !== false && !est.claude.expired)) {
    return html`<div class="estimate view">
      <${ClaudeState} onSignedIn=${onAgain} />
      <div class="row-end"><button class="btn plain" onClick=${onCancel}>${t("cancel")}</button></div>
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
    ${est.finds && html`<p>${t("estFinds")}</p>`}
    ${est.noObjectives && html`<p>${t("estNoObjectives")}</p>`}
    ${est.scanned.length > 0 && html`<p>${t("estScanned", est.scanned.join(", "))}</p>`}
    <div class="row-end">
      <button class="btn plain" onClick=${onCancel}>${t("cancel")}</button>
      <button class="btn primary" id="startAnalysis" onClick=${onStart}>${t("start")}</button>
    </div>
  </div>`;
}

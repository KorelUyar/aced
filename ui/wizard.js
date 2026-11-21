// New exam: five questions, one at a time.
import { html, useState, useEffect, useRef, Icon, Segs, Segmented, daysUntil, isoInDays, minutes, grade } from "./bits.js";
import { t, longDate } from "./i18n.js";

const STEPS = 5;

// `best` says at which end of the scale the best grade sits; the slider always gets better to the right.
export const SCALES = {
  ch: { min: 1, max: 6, step: 0.5, start: 5, best: "max", ticks: [1, 2, 3, 4, 5, 6] },
  de: { min: 1, max: 6, step: 0.5, start: 2, best: "min", ticks: [6, 5, 4, 3, 2, 1] },
  pct: { min: 0, max: 100, step: 5, start: 80, best: "max", ticks: [0, 25, 50, 75, 100] },
};

const PER_DAY = [15, 30, 45, 60, 90, 120];
const PACES = ["sprint", "thorough", "efficient"];

function Stepper({ value, min, max, unit, onChange }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)));
  return html`<div class="stepper">
    <button aria-label="−" onClick=${() => set(value - 1)}><${Icon} name="minus" /></button>
    <output>${value}</output>
    <button aria-label="+" onClick=${() => set(value + 1)}><${Icon} name="plus" /></button>
    <span class="unit">${unit}</span>
  </div>`;
}

export function Wizard({ draft: given, step: startAt, editing, onCancel, onDone }) {
  const [step, setStep] = useState(startAt || 1);
  const [d, setD] = useState({
    name: "",
    dateMode: "date",
    date: isoInDays(14),
    days: 14,
    timeMode: "perDay",
    perDay: 45,
    totalHours: 10,
    scale: "ch",
    target: SCALES.ch.start,
    pace: null,
    ...given,
  });
  const set = (patch) => setD((old) => ({ ...old, ...patch }));
  const nameField = useRef(null);

  const n = d.dateMode === "date" ? (d.date ? daysUntil(d.date) : -1) : d.days;
  const date = d.dateMode === "date" ? d.date : isoInDays(d.days);
  const studyDays = Math.max(1, n);
  const pace = d.pace || (n <= 7 ? "sprint" : "thorough");
  const valid = step === 1 ? d.name.trim().length > 0 : step === 2 ? n >= 0 : true;

  const go = () => {
    if (!valid) return;
    if (step < STEPS) return setStep(step + 1);
    onDone({
      name: d.name,
      date,
      time: d.timeMode === "perDay" ? { mode: "perDay", minutes: d.perDay } : { mode: "total", minutes: d.totalHours * 60 },
      scale: d.scale,
      target: d.target,
      pace,
    });
  };

  useEffect(() => {
    if (step === 1) nameField.current?.focus();
    const onKey = (e) => {
      if (e.key === "Enter" && e.target.tagName !== "BUTTON") go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const scale = SCALES[d.scale];
  const p = scale.best === "max" ? (d.target - scale.min) / (scale.max - scale.min) : (scale.max - d.target) / (scale.max - scale.min);

  const body = {
    1: () => html`
      <h1>${t("q1")}</h1>
      <input
        ref=${nameField}
        class="field"
        value=${d.name}
        placeholder=${t("q1Placeholder")}
        spellcheck=${false}
        onInput=${(e) => set({ name: e.target.value })}
      />
      <p class="hint">${t("q1Hint")}</p>
    `,
    2: () => html`
      <h1>${t("q2")}</h1>
      <${Segmented}
        label=${t("q2")}
        value=${d.dateMode}
        options=${[
          ["date", t("onDate")],
          ["days", t("inDays")],
        ]}
        onChange=${(v) => set({ dateMode: v })}
      />
      <div>
        ${d.dateMode === "date"
          ? html`<input class="field" type="date" value=${d.date} min=${isoInDays(0)} onInput=${(e) => set({ date: e.target.value })} />`
          : html`<${Stepper} value=${d.days} min=${1} max=${365} unit=${t("dayUnit", d.days)} onChange=${(v) => set({ days: v })} />`}
      </div>
      <p class="hint">${n < 0 ? t("q2Past") : t("q2Echo", n, longDate(date))}</p>
    `,
    3: () => html`
      <h1>${t("q3")}</h1>
      <${Segmented}
        label=${t("q3")}
        value=${d.timeMode}
        options=${[
          ["perDay", t("perDay")],
          ["total", t("inTotal")],
        ]}
        onChange=${(v) => set({ timeMode: v })}
      />
      ${d.timeMode === "perDay"
        ? html`<div class="chips" role="radiogroup">
            ${PER_DAY.map(
              (m) =>
                html`<button role="radio" aria-checked=${String(m === d.perDay)} onClick=${() => set({ perDay: m })}>${minutes(m)}</button>`,
            )}
          </div>`
        : html`<div>
            <${Stepper} value=${d.totalHours} min=${1} max=${200} unit=${t("hourUnit", d.totalHours)} onChange=${(v) => set({ totalHours: v })} />
          </div>`}
      <p class="hint">
        ${d.timeMode === "perDay"
          ? t("q3EchoDay", minutes(d.perDay), studyDays, minutes(d.perDay * studyDays))
          : t("q3EchoTotal", minutes(Math.max(5, Math.round((d.totalHours * 60) / studyDays / 5) * 5)))}
      </p>
    `,
    4: () => html`
      <h1>${t("q4")}</h1>
      <div class="grade">${grade(d.scale, d.target)}</div>
      <input
        class="grade-range"
        type="range"
        aria-label=${t("q4")}
        dir=${scale.best === "min" ? "rtl" : "ltr"}
        min=${scale.min}
        max=${scale.max}
        step=${scale.step}
        value=${d.target}
        style=${{ "--p": p }}
        onInput=${(e) => set({ target: Number(e.target.value) })}
      />
      <div class="grade-ticks" aria-hidden="true">${scale.ticks.map((x) => html`<span>${x}</span>`)}</div>
      <div class="grade-foot">
        <${Segmented}
          label=${t("q4")}
          value=${d.scale}
          options=${Object.keys(SCALES).map((id) => [id, t("scale_" + id)])}
          onChange=${(v) => set({ scale: v, target: SCALES[v].start })}
        />
        <span class="muted">${t("q4Hint_" + d.scale)}</span>
      </div>
    `,
    5: () => html`
      <h1>${t("q5")}</h1>
      <div class="paces" role="radiogroup" aria-label=${t("q5")}>
        ${PACES.map(
          (id) =>
            html`<button class="pace" role="radio" aria-checked=${String(id === pace)} onClick=${() => set({ pace: id })}>
              <i class="dot"></i>
              <strong>${t("pace_" + id)}</strong>
              <span>${t("pace_" + id + "_text")}</span>
            </button>`,
        )}
      </div>
    `,
  }[step];

  return html`<main class="page focus view">
    <div class="wizard-top">
      <${Segs} total=${STEPS} done=${step - 1} now=${step - 1} post=${false} label=${t("step", step, STEPS)} />
      <span class="muted">${t("step", step, STEPS)}</span>
    </div>
    <section class="question view" key=${step}>${body()}</section>
    <div class="wizard-foot">
      ${step === 1
        ? html`<button class="btn plain" onClick=${onCancel}>${t("cancel")}</button>`
        : html`<button class="btn plain" onClick=${() => setStep(step - 1)}>${t("back")}</button>`}
      <button class="btn primary big" disabled=${!valid} onClick=${go}>${step === STEPS ? t(editing ? "save" : "create") : t("next")}</button>
    </div>
  </main>`;
}

// Settings: language, appearance, and where the AI comes from.
import { html, useState, Segmented } from "./bits.js";
import { t, errorText, errorCode } from "./i18n.js";
import { ClaudeState } from "./claude.js";

const api = window.spurt;
const PROVIDERS = ["claudeCode", "anthropic", "openrouter", "openai"];
const CLAUDE_MODELS = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
  ["claude-fable-5-2", "Claude Fable 5.2"],
];

export function Settings({ settings, ai, onChange, app }) {
  const [key, setKey] = useState("");
  const [test, setTest] = useState(null); // null | "busy" | "ok" | error text
  const [checked, setChecked] = useState(0); // raised to make the Claude Code state look again
  const set = (patch) => api.setSettings(patch).then(onChange, app.fail);
  const setAi = (patch) => {
    setTest(null);
    return set({ ai: { provider: ai.provider, ...patch } });
  };
  const saveKey = (value) =>
    api.setKey(ai.provider, value).then((next) => {
      setKey("");
      setTest(null);
      onChange({ ai: next });
    }, app.fail);
  const runTest = () => {
    setTest("busy");
    api.testAi().then(
      () => setTest("ok"),
      (err) => {
        // A sign-in problem is shown by the state above, with its button: no second sentence here.
        const signIn = ["signIn", "noClaudeCode"].includes(errorCode(err));
        setTest(signIn ? null : errorText(err));
        if (signIn) setChecked((n) => n + 1);
      },
    );
  };

  const needsKey = ai.provider === "anthropic" || ai.provider === "openrouter" || ai.provider === "openai";
  const hasKey = ai.provider && ai.keys[ai.provider];
  const listed = ai.provider === "claudeCode" || ai.provider === "anthropic";

  // What the chosen provider needs, shown right under it.
  const fields =
    ai.provider &&
    html`<div class="ai-fields view">
      ${ai.provider === "claudeCode" &&
      html`<${ClaudeState} key=${checked} onSignedIn=${() => api.state().then((s) => onChange({ ai: s.ai }))} />`}
      ${ai.provider === "openai" &&
      html`<label>
        <span>${t("serverUrl")}</span>
        <input
          class="field"
          id="baseURL"
          value=${settings.ai.baseURL}
          placeholder="http://localhost:11434/v1"
          spellcheck=${false}
          onChange=${(e) => setAi({ baseURL: e.target.value })}
        />
      </label>`}
      ${needsKey &&
      html`<label>
        <span>${t("key")}</span>
        <div class="with-button">
          <input
            class="field"
            id="key"
            type="password"
            autocomplete="off"
            value=${key}
            placeholder=${hasKey ? t("keySaved") : t("keyPlaceholder")}
            onInput=${(e) => setKey(e.target.value)}
          />
          ${key.trim()
            ? html`<button class="btn second" id="saveKey" onClick=${() => saveKey(key)}>${t("saveKey")}</button>`
            : hasKey && html`<button class="btn plain" onClick=${() => saveKey("")}>${t("removeKey")}</button>`}
        </div>
      </label>`}
      <label>
        <span>${t("model")}</span>
        ${listed
          ? html`<select class="field" id="model" value=${ai.model} onChange=${(e) => setAi({ model: e.target.value })}>
              ${CLAUDE_MODELS.map(([id, name]) => html`<option value=${id}>${name}</option>`)}
            </select>`
          : html`<input class="field" id="model" value=${ai.model} spellcheck=${false} onChange=${(e) => setAi({ model: e.target.value })} />`}
      </label>
      <div class="with-button">
        <button class="btn second" id="test" disabled=${test === "busy" || !ai.ready} onClick=${runTest}>${t(test === "busy" ? "testing" : "test")}</button>
        <span class=${test && test !== "ok" && test !== "busy" ? "problem" : "muted"} role="status">${test === "ok" ? t("testOk") : test && test !== "busy" ? test : ""}</span>
      </div>
    </div>`;

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

    <section class="ai">
      <h2>${t("aiTitle")}</h2>
      <p class="note">${t("aiLead")}</p>
      <div class="paces" role="radiogroup" aria-label=${t("aiTitle")}>
        ${PROVIDERS.map((id) => {
          const missing = id === "claudeCode" && !ai.claudeCode;
          return html`<div class="provider" key=${id}>
            <button class="pace" role="radio" aria-checked=${String(ai.provider === id)} onClick=${() => setAi({ provider: id })}>
              <i class="dot"></i>
              <strong>${t("prov_" + id)}</strong>
              <span>${missing ? t("prov_claudeCode_missing") : t("prov_" + id + "_text")}</span>
            </button>
            ${ai.provider === id && fields}
          </div>`;
        })}
      </div>
    </section>
    ${api.sample && html`<p class="note">${t("sampleNote")}</p>`}
  </main>`;
}

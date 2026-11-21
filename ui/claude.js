// "Claude Code on this Mac" as the person sees it: is it installed, are they signed in, and one
// button that starts Claude Code's own sign-in and notices by itself when it is done.
// Also `Problem`: any error from the main process as a sentence with the next step as a button.
import { html, useState, useEffect } from "./bits.js";
import { t, errorText, errorCode, longDate } from "./i18n.js";

const api = window.spurt;
const NEEDS_SETTINGS = ["noProvider", "noKey", "badKey", "noCredit", "noModel", "noServer", "badAddress", "insecureAddress", "badAddressText", "usageLimit"];

/**
 * The state of Claude Code, with what to do about it. `onSignedIn` is called when the person
 * has become signed in while this was on screen.
 */
export function ClaudeState({ onSignedIn, toSettings }) {
  const [state, setState] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState(null);
  const good = (s) => s && s.installed && s.signedIn && !s.expired;
  const check = () =>
    api.claudeStatus().then(
      (next) => {
        setState(next);
        return next;
      },
      () => null,
    );

  useEffect(() => {
    check();
    // Coming back from the browser or the Terminal: look again right away.
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  useEffect(() => {
    if (!waiting) return;
    let rounds = 0;
    const id = setInterval(async () => {
      const next = await check();
      if (good(next)) {
        setWaiting(false);
        onSignedIn && onSignedIn(next);
      } else if (++rounds > 240) setWaiting(false); // ten minutes
    }, 2500);
    return () => clearInterval(id);
  }, [waiting]);

  const signIn = () => {
    setProblem(null);
    api.claudeSignIn().then(() => setWaiting(true), setProblem);
  };

  let text;
  let actions = null;
  if (!state) text = t("cc_checking");
  else if (!state.installed) {
    text = t("cc_missing");
    // Without Claude Code there are two ways on: get it, or take the AI from somewhere else.
    actions = html`<button class="btn primary" id="ccGet" onClick=${() => api.claudeSetup()}>${t("cc_get")}</button>
      ${toSettings && html`<button class="btn second" id="ccOther" onClick=${toSettings}>${t("cc_other")}</button>`}
      <button class="btn plain" onClick=${check}>${t("cc_again")}</button>`;
  } else if (waiting) {
    text = t("cc_waiting");
    actions = html`<span class="spinner" aria-hidden="true"></span><button class="btn plain" onClick=${signIn}>${t("cc_reopen")}</button>`;
  } else if (state.signedIn === false || state.expired) {
    text = t(state.expired ? "cc_expired" : "cc_signedOut");
    actions = html`<button class="btn primary" id="ccSignIn" onClick=${signIn}>${t(state.expired ? "cc_signInAgain" : "cc_signIn")}</button>`;
  } else if (state.signedIn) text = t("cc_ok", state.expiresAt ? longDate(state.expiresAt.slice(0, 10)).replace(/^\S+,?\s/, "") : "");
  else text = t("cc_unknown");

  return html`<div class=${"cc-state" + (good(state) ? " ok" : "")} role="status" data-state=${!state ? "checking" : !state.installed ? "missing" : waiting ? "waiting" : state.expired ? "expired" : state.signedIn === false ? "signedOut" : state.signedIn ? "ok" : "unknown"}>
    <p>${text}</p>
    ${actions && html`<div class="row-start">${actions}</div>`}
    ${waiting && html`<p class="aside">${t("cc_manual")} <code>claude auth login</code></p>`}
    ${problem && html`<p class="problem">${errorText(problem)}</p>`}
  </div>`;
}

/**
 * An error, said in a sentence, with the next step as a button: sign in to Claude Code, open
 * Settings, or try again.
 */
export function Problem({ error, onRetry, toSettings }) {
  const code = errorCode(error);
  if (code === "signIn" || code === "noClaudeCode") return html`<div class="problem-box"><${ClaudeState} onSignedIn=${onRetry} toSettings=${toSettings} /></div>`;
  return html`<div class="problem-box" role="alert">
    <p class="problem">${errorText(error)}</p>
    <div class="row-start">
      ${NEEDS_SETTINGS.includes(code) && toSettings && html`<button class="btn primary" onClick=${toSettings}>${t("openSettings")}</button>`}
      ${onRetry && (!NEEDS_SETTINGS.includes(code) || code === "usageLimit" || !toSettings) && html`<button class="btn second" id="retry" onClick=${onRetry}>${t("tryAgain")}</button>`}
    </div>
  </div>`;
}

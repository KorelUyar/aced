// Sharing an exam with friends: what to send (an Aced file, a PDF, a web page), and for the Aced
// file which material goes along. Then macOS's own share menu (AirDrop, Messages, Mail …).
import { html, useState, useEffect, Icon } from "./bits.js";
import { t } from "./i18n.js";
import { describe } from "./material.js";

const api = window.aced;

const OUTPUTS = ["aced", "pdf", "web"];

/** What goes along by default: the person's own notes, worksheets and screenshots; not books (big, and the friend has their own). */
const onByDefault = (m) => m.kind !== "book" || m.from === "pictures";

export function Share({ exam, close, app }) {
  const [output, setOutput] = useState("aced");
  const [chosen, setChosen] = useState(() => new Set(exam.materials.filter(onByDefault).map((m) => m.id)));
  useEffect(() => {
    const key = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const toggle = (id) =>
    setChosen((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const books = exam.materials.filter((m) => m.kind === "book" && m.from !== "pictures");
  const [busy, setBusy] = useState(false);
  const send = (how) => {
    setBusy(true);
    api.shareExam(exam.id, { output, materials: [...chosen], how }).then(
      (r) => {
        setBusy(false);
        if (r.saved) {
          app.notify(t("shareSaved", r.saved));
          close();
        } else if (r.shown) close();
      },
      (err) => {
        setBusy(false);
        app.fail(err);
      },
    );
  };

  return html`<div class="overlay" role="presentation" onClick=${(e) => e.target === e.currentTarget && close()}>
    <section class="share view" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
      <header class="share-head">
        <h2 id="shareTitle">${t("shareTitle")}</h2>
        <button class="mini" aria-label=${t("close")} title=${t("close")} onClick=${close}><${Icon} name="x" size=${14} /></button>
      </header>
      <p class="share-lead">${t("shareLead")}</p>

      <div class="share-outputs" role="radiogroup" aria-label=${t("shareWhat")}>
        ${OUTPUTS.map(
          (id) => html`<button class="pace share-out" role="radio" aria-checked=${String(output === id)} onClick=${() => setOutput(id)}>
            <i class="dot"></i>
            <strong>${t("shareOut_" + id)}</strong>
            <span>${t("shareOut_" + id + "_text")}</span>
          </button>`,
        )}
      </div>

      <p class="share-has">${t("shareOut_" + output + "_has")}</p>

      ${output === "aced" &&
      html`<div class="share-material">
            <h3>${t("shareMaterial")}</h3>
            <ul>
              ${exam.materials.map((m) => {
                const line = describe(m, false, "");
                return html`<li key=${m.id}>
                  <label>
                    <input type="checkbox" checked=${chosen.has(m.id)} onChange=${() => toggle(m.id)} />
                    <span class="share-m">
                      <strong>${m.title}</strong>
                      <small>${t("kind_" + m.kind)} · ${line.text}</small>
                    </span>
                  </label>
                </li>`;
              })}
            </ul>
            ${books.length > 0 && html`<p class="share-books">${t("shareBooks")}</p>`}
          </div>`}

      <p class="share-never"><${Icon} name="check" size=${14} />${t("shareNever")}</p>

      <div class="row-end">
        <button class="btn plain" onClick=${close}>${t("cancel")}</button>
        <button class="btn second" id="shareSave" disabled=${busy} onClick=${() => send("save")}>${t("shareSaveAs")}</button>
        <button class="btn primary" id="shareSend" disabled=${busy} onClick=${() => send("menu")}>${busy ? t("shareMaking") : t("shareSend")}</button>
      </div>
    </section>
  </div>`;
}

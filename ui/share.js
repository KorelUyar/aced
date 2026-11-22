// Sharing an exam with friends, in Aced's own window: every way is one click that does its job.
// The Aced file (with the material the person ticks) goes as a link, by AirDrop, Messages or
// Mail, onto the clipboard or into a folder; the plan also goes as a PDF or a web page to read
// without Aced. macOS's own share menu comes last ("More…").
import { html, useState, useEffect } from "./bits.js";
import { t, errorText, longDate } from "./i18n.js";
import { describe } from "./material.js";

const api = window.aced;

/** The ways the Aced file goes, after the link: in the order they are shown. */
const SEND = ["airdrop", "messages", "mail", "copy", "save"];
/** The plan as a page to read, without Aced. */
const PAGES = ["pdf", "web"];
/** Ways that open another part of macOS, and that a Mac may not have set up. */
const SERVICES = ["airdrop", "messages", "mail"];

/** What goes along by default: the person's own notes, worksheets and screenshots; not books (big, and the friend has their own). */
const onByDefault = (m) => m.kind !== "book" || m.from === "pictures";

// Larger pictures than the app's 16-point icons, drawn the same way (lines, round ends).
const GLYPHS = {
  link: html`<path d="M10 14l4-4" /><path d="M11 6.6l1.3-1.3a4 4 0 0 1 5.7 5.7l-1.3 1.3" /><path d="M13 17.4l-1.3 1.3a4 4 0 0 1-5.7-5.7l1.3-1.3" />`,
  airdrop: html`<path d="M6.2 17.6a8.2 8.2 0 1 1 11.6 0" /><path d="M8.8 15a4.5 4.5 0 1 1 6.4 0" /><path d="M12 12.4l-2.2 6.1h4.4z" />`,
  messages: html`<path d="M12 4.5c4.7 0 8.5 3.1 8.5 6.9s-3.8 6.9-8.5 6.9c-1 0-2-.1-2.9-.4L5.2 19.6l1-3.4c-1.7-1.3-2.7-3-2.7-4.8 0-3.8 3.8-6.9 8.5-6.9z" />`,
  mail: html`<rect x="3.5" y="5.5" width="17" height="13" rx="2.6" /><path d="M4.6 7.4L12 13l7.4-5.6" />`,
  copy: html`<rect x="8.5" y="8.5" width="11" height="11" rx="2.6" /><path d="M15.5 8.4V6.1a2.6 2.6 0 0 0-2.6-2.6H6.1a2.6 2.6 0 0 0-2.6 2.6v6.8a2.6 2.6 0 0 0 2.6 2.6h2.3" />`,
  save: html`<path d="M12 4v11" /><path d="M7.5 10.6L12 15l4.5-4.4" /><path d="M5 19.5h14" />`,
  pdf: html`<path d="M13.8 3.5H7.6a2.1 2.1 0 0 0-2.1 2.1v12.8a2.1 2.1 0 0 0 2.1 2.1h8.8a2.1 2.1 0 0 0 2.1-2.1V8.2z" /><path d="M13.8 3.5v4.7h4.7" /><path d="M8.8 12.8h6.4M8.8 16.2h4.4" />`,
  web: html`<circle cx="12" cy="12" r="8.5" /><path d="M3.6 12h16.8" /><path d="M12 3.5c2.2 2.4 3.3 5.2 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.2-3.3-8.5s1.1-6.1 3.3-8.5z" />`,
  more: html`<circle cx="6" cy="12" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="18" cy="12" r="1.1" />`,
  done: html`<path d="M5.5 12.5l4.2 4.2 8.8-9.4" />`,
  close: html`<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />`,
  safe: html`<rect x="5" y="10.5" width="14" height="9.5" rx="2.6" /><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" />`,
};

const Glyph = ({ name, size = 24 }) =>
  html`<svg class="glyph" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name]}</svg>`;

export function Share({ exam, close, app }) {
  const [chosen, setChosen] = useState(() => new Set(exam.materials.filter(onByDefault).map((m) => m.id)));
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(null); // the way under way
  const [problem, setProblem] = useState(null); // { way, text }
  const [link, setLink] = useState(null); // { url, expires, left }
  // What this Mac has set up (AirDrop, Messages, Mail); until it is known, everything is offered.
  const [services, setServices] = useState({});

  useEffect(() => {
    const key = (e) => e.key === "Escape" && !busy && close();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy]);
  useEffect(() => {
    let live = true;
    api.shareServices().then(
      (s) => live && setServices(s || {}),
      () => {},
    );
    return () => (live = false);
  }, []);

  const toggle = (id) => {
    setLink(null);
    setChosen((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const files = exam.materials.filter((m) => !m.missing);
  const along = files.filter((m) => chosen.has(m.id)).length;
  const books = exam.materials.filter((m) => m.kind === "book" && m.from !== "pictures");

  const go = (way) => {
    if (busy) return;
    if (services[way] === false) return setProblem({ way, text: t("shareMissing_" + way) });
    setBusy(way);
    setProblem(null);
    if (way !== "link") setLink(null);
    api.shareExam(exam.id, { way, materials: [...chosen] }).then(
      (r) => {
        setBusy(null);
        if (!r || r.cancelled) return;
        const left = r.left && r.left.length ? t("shareLeft", r.left) : "";
        if (way === "link") return setLink({ url: r.link, expires: r.expires, left });
        if (r.missing) {
          setServices((s) => ({ ...s, [way]: false }));
          return setProblem({ way, text: t("shareMissing_" + way) });
        }
        const text = r.saved ? t("shareSaved", r.saved) : t("shareDone_" + way);
        if (text || left) app.notify([text, left].filter(Boolean).join(" "));
        close();
      },
      (err) => {
        setBusy(null);
        setProblem({ way, text: errorText(err) });
      },
    );
  };
  const copyAgain = () => api.copyText(link.url).then(() => app.notify(t("shareLinkDone")), app.fail);

  const tile = (way) => {
    const missing = services[way] === false;
    return html`<button
      class=${"sw-tile" + (busy === way ? " busy" : "") + (missing ? " missing" : "")}
      id=${"share-" + way}
      disabled=${Boolean(busy) && busy !== way}
      aria-busy=${String(busy === way)}
      onClick=${() => go(way)}
    >
      <span class="sw-badge">${busy === way ? html`<span class="spinner" aria-hidden="true"></span>` : html`<${Glyph} name=${way} />`}</span>
      <strong>${t("shareVia_" + way)}</strong>
      ${missing && html`<small>${t("shareMissing")}</small>`}
    </button>`;
  };

  return html`<div class="overlay" role="presentation" onClick=${(e) => e.target === e.currentTarget && !busy && close()}>
    <section class="share share-win view" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
      <header class="sw-head">
        <div>
          <h2 id="shareTitle">${t("shareTitle")}</h2>
          <p class="sw-lead">${t("shareLead")}</p>
        </div>
        <button class="sw-close" aria-label=${t("close")} title=${t("close")} onClick=${() => !busy && close()}><${Glyph} name="close" size=${18} /></button>
      </header>

      ${link
        ? html`<div class="sw-link done" role="status">
            <span class="sw-badge"><${Glyph} name="done" /></span>
            <span class="sw-link-text">
              <strong>${t("shareLinkDone")}</strong>
              <input class="sw-url" readonly value=${link.url} aria-label=${t("shareVia_link")} onFocus=${(e) => e.target.select()} />
              <small>${t("shareLinkUntil", longDate(link.expires))}${link.left ? " " + link.left : ""}</small>
            </span>
            <button class="btn second" id="shareLinkAgain" onClick=${copyAgain}>${t("shareLinkAgain")}</button>
          </div>`
        : html`<button class=${"sw-link" + (busy === "link" ? " busy" : "")} id="share-link" disabled=${Boolean(busy) && busy !== "link"} aria-busy=${String(busy === "link")} onClick=${() => go("link")}>
            <span class="sw-badge">${busy === "link" ? html`<span class="spinner" aria-hidden="true"></span>` : html`<${Glyph} name="link" />`}</span>
            <span class="sw-link-text">
              <strong>${t("shareVia_link")}</strong>
              <small>${busy === "link" ? t("shareLinkMaking") : t("shareLinkText")}</small>
            </span>
          </button>`}

      <div class="sw-grid">${SEND.map(tile)}</div>

      ${problem && html`<p class="sw-problem" role="alert">${problem.text}</p>`}

      <div class="sw-along">
        <p>
          <span>${t("shareAlong", along, files.length)}</span>
          ${exam.materials.length > 0 &&
          html`<button class="link" id="shareChange" aria-expanded=${String(listOpen)} onClick=${() => setListOpen(!listOpen)}>${listOpen ? t("shareListDone") : t("shareChange")}</button>`}
        </p>
        ${listOpen &&
        html`<div class="share-material">
          <ul>
            ${exam.materials.map((m) => {
              const line = describe(m, false, "");
              return html`<li key=${m.id}>
                <label>
                  <input type="checkbox" checked=${chosen.has(m.id)} disabled=${Boolean(m.missing)} onChange=${() => toggle(m.id)} />
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
      </div>

      <div class="sw-pages">
        <h3>${t("sharePagesTitle")}</h3>
        <div class="sw-pages-row">
          ${PAGES.map(
            (way) => html`<button class=${"sw-page" + (busy === way ? " busy" : "")} id=${"share-" + way} disabled=${Boolean(busy) && busy !== way} aria-busy=${String(busy === way)} onClick=${() => go(way)}>
              <span class="sw-badge small">${busy === way ? html`<span class="spinner" aria-hidden="true"></span>` : html`<${Glyph} name=${way} size=${20} />`}</span>
              <span>
                <strong>${t("shareVia_" + way)}</strong>
                <small>${t("shareVia_" + way + "_text")}</small>
              </span>
            </button>`,
          )}
        </div>
      </div>

      <footer class="sw-foot">
        <p class="sw-never"><${Glyph} name="safe" size=${16} /><span>${t("shareNever")}</span></p>
        <button class="btn plain" id="share-more" disabled=${Boolean(busy)} onClick=${() => go("more")}><${Glyph} name="more" size=${18} />${t("shareVia_more")}</button>
      </footer>
    </section>
  </div>`;
}

export { SEND, PAGES, SERVICES };

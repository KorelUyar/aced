// What the line under a material says: what it was made from, how long it is, and who read it
// (the text recognition on this Mac, or the person's AI, with what that cost).
import { t } from "./i18n.js";
import { modelName, money } from "./bits.js";

const SLIDES = new Set(["pptx", "ppt", "odp"]);

/** { text, retry }: the line, and whether "Read with AI" is offered. */
export function describe(m, reading, model) {
  if (m.type === "text") return { text: t("pastedText"), retry: false };
  const source = m.from === "pictures" || !m.from || m.from === "pdf" ? "" : t("from_" + (["iwork", "textutil"].includes(m.from) ? m.format : m.from));
  const length = m.from === "pictures" ? t("picturesCount", m.pages) : SLIDES.has(m.from) || m.format === "key" ? t("slidesCount", m.pages) : t("pagesCount", m.pages);
  const parts = [source ? `${source}, ${length}` : length];
  if (m.missing) return { text: t("addCopyTitle", m.title), retry: false };
  // A copy of a shared exam's book that does not look like the same edition.
  if (m.edition === "other") parts.push(t("editionOther"));
  // Sheets that were hidden in the workbook are left out, and named.
  if (m.hiddenSheets && m.hiddenSheets.length) parts.push(t("hiddenSheets", m.hiddenSheets));
  if (reading) return { text: parts.concat(t("readingWithAi", model ? modelName(model) : "")).join(", "), retry: false };
  if (m.read === "ai") {
    parts.push(t("readByAi", modelName(m.model)));
    if (m.readCost > 0) parts.push(t("aboutCost", money(m.readCost)));
    return { text: parts.join(", "), retry: false };
  }
  if (m.scanned) return { text: m.readFailed ? `${t("scannedNote")} ${t("aiFailed_" + reason(m.readFailed))}` : t("scannedNote"), retry: Boolean(m.readFailed) };
  if (m.recognised) parts.push(t("recognisedNote"));
  if (m.readFailed) return { text: parts.join(", ") + ". " + t("aiFailed_" + reason(m.readFailed)), retry: true };
  return { text: parts.join(", "), retry: false };
}

const KNOWN = new Set(["cannotSee", "noProvider", "offline", "signIn", "usageLimit", "cancelled", "noKey", "badKey", "noClaudeCode", "noCredit", "rateLimit"]);
const reason = (code) => (KNOWN.has(code) ? code : "failed");

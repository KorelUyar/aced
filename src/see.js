// The person's AI reads pictures: screenshots, photos, and short documents that are only
// pictures, such as a scanned worksheet. The text recognition built into macOS reads them at
// once when they are added (fast, free, on this Mac, but weak on formulas); right after, the AI
// is shown a picture of every page and writes down what is on it, formulas in LaTeX. Its text
// then takes the place of the recognised one. When the AI cannot see pictures, fails, or the
// Mac is offline, the recognised text stays, and the person can ask for another try.
const fs = require("fs");
const os = require("os");
const path = require("path");
const files = require("./files");
const ai = require("./ai");
const P = require("./prompts");
const convert = require("./convert");

/** Documents longer than this stay with the recogniser on this Mac: a whole scanned book would mean hundreds of requests. */
const MOST_PAGES = 20;
/** The long side of the picture of a page the AI is shown, in pixels: sharp enough for small print, about 3,000 tokens a page. */
const LONG_SIDE = 2000;
/** Pages read at the same time. */
const AT_ONCE = 3;

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

/** Is this material one the AI should read? Pictures, and PDFs whose text had to be recognised, of up to MOST_PAGES pages. */
const eligible = (m) => m.type === "pdf" && m.pages <= MOST_PAGES && m.pages > 0 && (m.from === "pictures" || m.recognised || m.scanned);

/**
 * In JSON, "\f", "\b", "\t", "\n" and "\r" are characters, so a model that writes "\frac" or
 * "\times" without doubling the backslash sends a form feed or a tab instead. Inside formulas
 * those characters are never meant: they become the backslash and letter again.
 */
function repairLatex(text) {
  const fix = (s) => s.replace(/\f/g, "\\f").replace(/\u0008/g, "\\b").replace(/\t(?=[a-zA-Z])/g, "\\t").replace(/\r(?=[a-zA-Z])/g, "\\r").replace(/\n(?=(eq|abla|u\b|ot|e\b|i\b|leq|geq|ewline|orm)\b)/g, "\\n");
  return String(text || "")
    .replace(/\$\$[\s\S]*?\$\$/g, fix)
    .replace(/\$[^$\n]*?\$/g, fix)
    .replace(/[\f\u0008]/g, "");
}

/**
 * Has the AI read the pages of `material` (a PDF in the library). `onPage(done, total)` after
 * every page. Resolves to { pages: [text], model }. Throws "cannotSee" when the chosen model
 * does not take pictures, or the provider's error when a request fails.
 */
async function read(material, { signal, onUsage, onKey, onPage } = {}) {
  const sees = await ai.canSee({
    signal,
    samplePicture: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aced-sight-"));
      try {
        return fs.readFileSync(await convert.samplePicture(path.join(dir, "sample.png")));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  });
  if (sees === null) throw coded("noProvider");
  if (!sees) throw coded("cannotSee");
  const { model } = ai.config();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "aced-see-"));
  try {
    const pictures = await convert.pagePictures(files.pdfPath(material.hash), folder, { longSide: LONG_SIDE, signal });
    const total = pictures.length;
    if (!total) throw coded("unreadable");
    const pages = new Array(total).fill("");
    let next = 0;
    let done = 0;
    onPage?.(0, total);
    const worker = async () => {
      while (next < total) {
        const picture = pictures[next++];
        const data = fs.readFileSync(picture.file).toString("base64");
        const answer = await ai.ask(
          {
            name: "page_text",
            system: P.SEE_SYSTEM,
            prompt: P.seeTask(picture.page, total),
            schema: P.SEE,
            images: [{ mediaType: "image/jpeg", data }],
            maxTokens: 16000,
            effort: "low",
          },
          { signal, onUsage, onKey },
        );
        pages[picture.page - 1] = repairLatex(answer.text).trim();
        onPage?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, total) }, worker));
    return { pages, model };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** About how many tokens reading `pages` pages costs: what the estimate before a run can say. */
const estimate = (pages) => ({ input: pages * 3200, output: pages * 500 });

module.exports = { read, eligible, repairLatex, estimate, MOST_PAGES, LONG_SIDE };

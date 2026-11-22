// Runs in its own process (Electron utilityProcess): reads one file that is not a PDF and
// writes it as a page to print. Office files, e-books and web pages are untrusted input, so none
// of this happens in the main process or in the window. Nothing here touches the network, and
// every reader caps what it unpacks (see src/formats/zip.js and xml.js).
const fs = require("fs");
const path = require("path");
const { textToHtml, notebookToHtml, csvRows, decode } = require("./formats/text");
const { sheetsToHtml, LIMITS } = require("./formats/sheet");

const port = process.parentPort;

function run({ kind, file, ext, lang }) {
  // Hidden sheets are left out, and named (they are often the solutions).
  const sheets = (list) => ({ ...sheetsToHtml(list.filter((s) => !s.hidden), { lang }), hiddenSheets: list.filter((s) => s.hidden).map((s) => s.name) });
  switch (kind) {
    case "docx":
      return require("./formats/docx").convert(file);
    case "xlsx":
      return sheets(require("./formats/xlsx").convert(file));
    case "xls":
      return sheets(require("./formats/xls").convert(file));
    case "pptx":
      return require("./formats/pptx").convert(file);
    case "odt":
      return require("./formats/odf").convertText(file);
    case "ods":
      return sheets(require("./formats/odf").convertSheet(file));
    case "odp":
      return require("./formats/odf").convertSlides(file);
    case "epub":
      return require("./formats/web").epubFile(file);
    case "html":
      return require("./formats/web").htmlFile(file);
    case "slides-html":
      // An old PowerPoint file as Quick Look shows it: one slide after the other, on landscape pages.
      return require("./formats/web").htmlFile(file, { landscape: true });
    case "svg":
      return require("./formats/web").svgFile(file);
    case "iwork":
      return require("./formats/iwork").convert(file, ext);
    case "ipynb":
      return notebookToHtml(fs.readFileSync(file));
    case "csv": {
      const bytes = fs.readFileSync(file);
      if (bytes.length > 200 * 1024 * 1024) throw Object.assign(new Error("tooLarge"), { code: "tooLarge" });
      const { rows, total } = csvRows(decode(bytes), LIMITS.rows);
      return sheets([{ name: path.basename(file), rows, totalRows: total }]);
    }
    case "text": {
      const size = fs.statSync(file).size;
      // A text file is printed up to its first 1.5 million characters; more is not even read.
      const fd = fs.openSync(file, "r");
      const bytes = Buffer.alloc(Math.min(size, 6 * 1024 * 1024));
      fs.readSync(fd, bytes, 0, bytes.length, 0);
      fs.closeSync(fd);
      const out = textToHtml(bytes, ext);
      return { ...out, cut: out.cut || size > bytes.length };
    }
    default:
      throw Object.assign(new Error("unsupported"), { code: "unsupported" });
  }
}

port.on("message", ({ data }) => {
  try {
    const result = run(data);
    // The page goes to the job's own folder, not through this channel: with its pictures inside it, it can be large.
    let page = null;
    let pdf = null;
    if (result.pdf) {
      pdf = path.join(data.out, "preview.pdf");
      fs.writeFileSync(pdf, result.pdf);
    } else {
      page = path.join(data.out, "page.html");
      fs.writeFileSync(page, result.html);
    }
    port.postMessage({ type: "done", page, pdf, cut: Boolean(result.cut), partial: Boolean(result.partial), missingPictures: result.missingPictures || 0, hiddenSheets: result.hiddenSheets || [], leftOut: result.leftOut || 0 });
  } catch (err) {
    port.postMessage({ type: "error", code: (err && err.code) || "damaged", message: String((err && err.message) || err).slice(0, 300) });
  }
});

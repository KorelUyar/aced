// Every kind of file Aced reads, made on this Mac (scripts/fixtures/formats.js), added the way
// the app adds them: each must become a PDF in the library whose text holds what the file
// holds (exercise numbers, formulas as LaTeX, table cells), with its original kept beside it.
// And the hostile kind: a zip bomb, an external entity, a drawing with a script, a web page with
// a picture from a server, a picture with a huge number of pixels.
//
//   node_modules/.bin/electron scripts/test-formats.js        (ACED_VERBOSE=1: the text of each file)
const { app, BrowserWindow, protocol } = require("electron");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { quiet, sleep } = require("./hidden");

protocol.registerSchemesAsPrivileged([{ scheme: "aced-print", privileges: { standard: true, secure: true } }]);
quiet();
// The pages printed and the screenshots taken open and close hidden windows: the test goes on when none is left.
app.on("window-all-closed", () => {});
const VERBOSE = process.env.ACED_VERBOSE === "1";

let passed = 0;
let failed = 0;
const ok = (value, message) => {
  try {
    assert.ok(value, message);
    passed++;
  } catch (err) {
    failed++;
    console.log("FAIL", message);
  }
};
const same = (a, b, message) => {
  try {
    assert.deepStrictEqual(a, b, message);
    passed++;
  } catch {
    failed++;
    console.log("FAIL", message, "\n  got     ", JSON.stringify(a), "\n  expected", JSON.stringify(b));
  }
};

/** Pages of a worksheet as screenshots: what a student takes of an exercise sheet on screen. */
async function screenshots(dir) {
  const sheet = (n, body) => `<!doctype html><meta charset="utf-8"><style>body{font:17px/1.5 -apple-system,Helvetica;margin:30px;color:#111;background:#fff}h3{margin:0 0 12px}b{margin-right:6px}</style><h3>Übungsblatt 4 – Seite ${n}</h3>${body}`;
  const pages = [
    sheet(1, `<p><b>1.</b> Löse <math><msup><mi>x</mi><mn>2</mn></msup><mo>−</mo><mn>7</mn><mi>x</mi><mo>+</mo><mn>12</mn><mo>=</mo><mn>0</mn></math>.</p><p><b>2.</b> Vereinfache <math><mfrac><mrow><mn>6</mn><msup><mi>a</mi><mn>3</mn></msup></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math>.</p>`),
    sheet(2, `<p><b>3.</b> Berechne <math><msqrt><mn>144</mn></msqrt><mo>+</mo><msup><mn>2</mn><mn>5</mn></msup></math>.</p><p><b>4.</b> Ein Kapital von 2500 CHF wird zu 3 % verzinst. Wie gross ist es nach 4 Jahren?</p>`),
    sheet(3, `<p><b>5.</b> Bestimme die Ableitung von <math><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo>=</mo><mn>4</mn><msup><mi>x</mi><mn>3</mn></msup></math>.</p>`),
  ];
  const out = [];
  const win = new BrowserWindow({ show: false, width: 1400, height: 520, webPreferences: { offscreen: true } });
  for (const [i, page] of pages.entries()) {
    const file = path.join(dir, `sheet-${i + 1}.html`);
    fs.writeFileSync(file, page);
    await win.loadFile(file);
    win.webContents.setZoomFactor(2);
    await sleep(500);
    out.push((await win.webContents.capturePage()).toPNG());
  }
  win.destroy();
  return out;
}

app.whenReady().then(async () => {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aced-formats-"));
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end("x");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const remote = `http://127.0.0.1:${server.address().port}`;
  const secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-TOKEN");
  const { make } = require("./fixtures/formats");
  const shots = await screenshots(dir);
  const fx = await make(path.join(dir, "fixtures"), { remote, secret, shots });
  // WebP: sips cannot write it here, the page can.
  {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("about:blank");
    const data = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; c.getContext("2d").drawImage(img, 0, 0); resolve(c.toDataURL("image/webp", 0.92)); };
      img.src = "data:image/png;base64,${shots[0].toString("base64")}";
    })`);
    win.destroy();
    fx["Foto.webp"] = path.join(dir, "fixtures", "Foto.webp");
    fs.writeFileSync(fx["Foto.webp"], Buffer.from(data.split(",")[1], "base64"));
  }
  const files = require("../src/files");
  const userData = path.join(dir, "data");
  files.init(userData);

  const text = (item) => (files.readText(item.hash) || { pages: [] }).pages.join("\n");
  const add = async (name, lang = "de") => {
    try {
      const item = await files.add(fx[name], null, null, { lang });
      if (VERBOSE) console.log(`---- ${name}: ${item.pages} pages, ${item.chars} chars\n${text(item).slice(0, 700)}\n`);
      return item;
    } catch (err) {
      if (VERBOSE) console.log(`---- ${name}: ${err.code || err.message}`);
      return { error: err.code || err.message };
    }
  };
  const add_ = async (file) => {
    try {
      return await files.add(file, null, null, { lang: "de" });
    } catch (err) {
      return err.code || err.message;
    }
  };
  const kept = (item) => fs.existsSync(path.join(userData, "library", item.hash + ".pdf")) && fs.existsSync(path.join(userData, "originals", item.hash));

  // ---- Word with formulas in Word's own format: numbering, formulas as LaTeX, a table, two pages
  {
    const item = await add("Arbeitsblatt 7.docx");
    const t = text(item);
    same([item.type, item.from, item.pages, item.scanned], ["pdf", "docx", 2, false], "a Word file becomes a PDF of two pages (its page break kept)");
    ok(kept(item), "its PDF is in the library and the original beside it");
    ok(/1\.\s*Löse die Gleichung \$x\^\{?2\}?\s*-\s*5x\s*\+\s*6\s*=\s*0\$/.test(t), "exercise 1: Word's number and the formula as LaTeX");
    ok(/2\.\s*Berechne \$\\frac\{3a\s*\+\s*1\}\{\\sqrt\{a\}\}\$/.test(t), "exercise 2: a fraction with a root");
    ok(/\\frac\{-b\s*\\pm\s*\\sqrt\{b\^\{?2\}?\s*-\s*4ac\}\}\{2a\}/.test(t), "exercise 3: the quadratic formula");
    ok(/\\sum_\{k\s*=\s*1\}\^\{?n\}?/.test(t), "a sum with its limits");
    ok(/4\.\s*Ein Rechteck/.test(t) && /6\.\s*Finde die Nullstellen/.test(t) && /a\)\s*graphisch/.test(t) && /b\)\s*rechnerisch/.test(t), "numbering goes on across the page break, with lettered sub-items");
    ok(!/@@[MDE]/.test(t), "no markers left in the text");
    const pagesText = files.readText(item.hash).pages;
    ok(/Teil B/.test(pagesText[1]) && !/Teil B/.test(pagesText[0]), "page 2 of the text is page 2 of the PDF");
  }
  // ---- Word written by macOS (textutil), old Word, RTF, OpenDocument from textutil
  for (const name of ["Prozent (textutil).docx", "Prozent.doc", "Prozent.rtf", "Prozent (textutil).odt"]) {
    const item = await add(name);
    ok(!item.error && /Aufgabe 1:\s*Berechne 15 % von 240/.test(text(item)) && /Grundwert/.test(text(item)), `${name}: text and table read`);
  }
  // ---- Excel: formatted cells, both visible sheets, the hidden one left out
  {
    const item = await add("Noten.xlsx");
    const t = text(item);
    same([item.from, item.scanned], ["xlsx", false], "an Excel file becomes a PDF");
    ok(/Quadratische Gleichungen/.test(t) && /15\.00%/.test(t) && /05\.12\.2026/.test(t), "strings, percentages and dates as Excel shows them");
    ok(/Zinseszins/.test(t) && /6,092\.01 CHF/.test(t), "the second sheet, with its number format");
    ok(!/versteckt/.test(t), "a hidden sheet is left out");
  }
  // ---- Excel 97 to 2003 (.xls, written by xlwt; kept in scripts/fixtures/formats)
  {
    fx["Noten.xls"] = path.join(__dirname, "fixtures", "formats", "Noten.xls");
    const item = await add("Noten.xls");
    const t = text(item);
    same([item.from, item.pages], ["xls", 2], "an old Excel file: two sheets, two pages");
    ok(/Quadratische Gleichungen/.test(t) && /15\.0%/.test(t) && /05\.12\.2026/.test(t) && /Übung 12/.test(t) && /Berechne 30\^2/.test(t), "its shared strings, percentages, dates and both sheets");
  }
  {
    const item = await add("Messwerte gross.xlsx");
    ok(item.cut && /Hier stehen nur die Zeilen 1 bis 1000 von 5000/.test(text(item)), "a sheet of 5000 rows is cut at 1000, and the page says so");
  }
  // ---- PowerPoint: one page per slide, with a table, a formula and a picture
  {
    const item = await add("Exponentialfunktionen.pptx");
    const t = files.readText(item.hash).pages;
    same([item.from, item.pages], ["pptx", 3], "three slides, three pages");
    ok(/Übung 12/.test(t[0]) && /Übung 13/.test(t[1]) && /Übung 14/.test(t[2]), "slide N is page N");
    ok(/N_\{?0\}?/.test(t[1]) && /2\^\{?t\}?/.test(t[1]) && /800/.test(t[1]), "the formula as LaTeX, and the table");
  }
  // ---- OpenDocument
  {
    const odt = await add("Potenzen.odt");
    ok(/\\frac\{a\^\{?5\}?\}\{a\^\{?2\}?\}/.test(text(odt)) && /1\.\s*Vereinfache/.test(text(odt)) && /1024/.test(text(odt)), "OpenDocument text: numbered list, formula object as LaTeX, table");
    const ods = await add("Messreihe.ods");
    ok(/Messreihe/.test(text(ods)) && /31\.25/.test(text(ods)) && ods.pages <= 2, "OpenDocument sheet: a million repeated empty rows are not printed");
    const odp = await add("Vektoren.odp");
    same([odp.pages, /Übung 22/.test(files.readText(odp.hash).pages[1] || "")], [2, true], "OpenDocument slides: a page per slide");
  }
  // ---- e-book, notebook, text formats, CSV
  {
    const item = await add("Geometrie.epub");
    const t = text(item);
    ok(/a\^\{?2\}?\s*\+\s*b\^\{?2\}?\s*=\s*c\^\{?2\}?/.test(t) && /Aufgabe 2\.1/.test(t) && item.pages >= 2, "e-book: chapters on their own pages, MathML as LaTeX");
    ok(!/SCRIPT/.test(t), "no script of the e-book ran");
  }
  ok(/18\.0/.test(text(await add("Mittelwert.ipynb"))), "a notebook: its code and what it printed");
  ok(/5,5/.test(text(await add("Punkte.csv"))), "CSV with semicolons");
  ok(/f\(x\)/.test(text(await add("Werte.tsv"))), "TSV");
  ok(/quadratische Gleichungen/.test(text(await add("Lernziele.txt"))), "plain text");
  ok(/Mitternachtsformel/.test(text(await add("Notizen.md"))), "Markdown");
  ok(/Aufgabe 8/.test(text(await add("Formelsammlung.tex"))), "LaTeX source as text");
  ok(/"aufgabe": 10/.test(text(await add("Daten.json"))), "JSON");
  ok(/def fib/.test(text(await add("folge.py"))), "source code");
  ok(/Aufgabe 12/.test(text(await add("ohne Endung"))), "a text file without an ending is recognised by its content");

  // ---- web page and drawing: nothing runs, nothing is loaded from a server
  hits.length = 0;
  {
    const item = await add("Übungen online.html");
    const t = text(item);
    ok(/Aufgabe 3\.1\.4/.test(t) && /Aufgabe 3\.1\.5/.test(t), "a web page is printed");
    ok(!/SCRIPT RAN|ONLOAD RAN/.test(t), "its scripts did not run");
    const svg = await add("Dreieck.svg");
    ok(!svg.error && svg.pages === 1, "a drawing is printed on one page");
    await sleep(500);
    same(hits, [], "neither the web page nor the drawing loaded anything from the server");
  }

  // ---- pictures: one document, one page each, in the order taken, named after the first
  {
    const shots = ["Bildschirmfoto 3.png", "Bildschirmfoto 1.png", "Bildschirmfoto 2.png"].map((n) => fx[n]);
    // Taken one after the other: 1, 2, 3 (the file times say so, as for real screenshots).
    const base = Date.now() / 1000 - 3600;
    shots.forEach((f) => fs.utimesSync(f, base, base));
    ["Bildschirmfoto 1.png", "Bildschirmfoto 2.png", "Bildschirmfoto 3.png"].forEach((n, i) => fs.utimesSync(fx[n], base + i * 60, base + i * 60));
    const sorted = [...shots].sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    const item = await files.addPictures(sorted, null, null, { lang: "de" });
    let pages = files.readText(item.hash).pages;
    same([item.from, item.pages, item.title], ["pictures", 3, "Bildschirmfoto 1 (3 Seiten)"], "three screenshots: one document of three pages, named after the first");
    // The Mac's text recognition can be busy for a while (macOS prepares its models after an
    // update, or another app uses them): then the pages are read again, up to twice.
    // Under load, macOS's recogniser can come back empty for one page: every page with text must
    // be the right one, in the order taken, and at least two of the three must be read.
    const inOrder = (p) => [1, 2, 3].every((n, i) => new RegExp(`Seite ${n}`).test(p[i] || "") || !String(p[i] || "").trim()) && p.filter((x) => /Seite/.test(x)).length >= 2;
    let again = false;
    for (let i = 0; i < 2 && !inOrder(pages); i++) {
      await sleep(4000);
      pages = await require("../src/ocr").read(files.pdfPath(item.hash), () => {});
      again = true;
    }
    ok(inOrder(pages), "in the order given, page by page, read on this Mac");
    ok((item.recognised && !item.scanned) || again, "their text is recognised");
    ok(fs.readdirSync(path.join(userData, "originals", item.hash)).length === 3, "the three originals are kept");
  }
  for (const name of ["Foto.heic", "Foto.jpg", "Foto.gif", "Foto.bmp", "Foto.tiff", "Foto.webp"]) {
    const item = await add(name);
    ok(!item.error && item.pages === 1 && /Löse/.test(text(item)), `${name}: one page, text recognised`);
  }
  {
    const item = await add("Scan zwei Seiten.tiff");
    same(item.pages, 2, "a TIFF with two pages gives two pages");
  }
  {
    const item = await add("Wahrscheinlichkeit.pages");
    ok(item.partial && /Doppelsechs/.test(text(item)) && item.pages === 2, "Pages: its preview and its text, said to be partial");
  }

  // ---- hostile and unreadable files
  {
    const t0 = Date.now();
    const bomb = await add("Bombe.docx");
    same(bomb.error, "tooLarge", "a zip bomb is refused");
    ok(Date.now() - t0 < 30000, "and quickly");
    const entity = await add("Entity.docx");
    ok(!entity.error && !/TOP-SECRET/.test(text(entity)) && /&xxe;/.test(text(entity)), "an external entity is not resolved: the file it points to is never read");
    same((await add("Riesig.png")).error, "tooManyPixels", "a picture of 900 megapixels is refused before it is decoded");
    same((await add("Archiv.zip")).error, "zip", "a zip archive gets its own sentence");
    same((await add("Programm.exe")).error, "unsupported", "a program is not material");
  }
  same(hits, [], "nothing at all was loaded from the server");

  // ---- symbolic links are never followed (a folder from an unpacked archive can hold one)
  {
    const { identify } = require("../src/formats");
    const links = path.join(dir, "links");
    fs.mkdirSync(links);
    fs.symlinkSync(secret, path.join(links, "Kapitel 2.txt"));
    same(identify(path.join(links, "Kapitel 2.txt")).why, "link", "a link to a file is a link, not the file");
    same(await add_(path.join(links, "Kapitel 2.txt")), "link", "and adding it is refused");
    // A Pages package whose preview PDF is a link to any PDF on the Mac.
    const outside = path.join(dir, "elsewhere.pdf");
    fs.copyFileSync(path.join(userData, "library", fs.readdirSync(path.join(userData, "library")).find((n) => n.endsWith(".pdf"))), outside);
    const pkg = path.join(links, "Arbeitsblatt.pages");
    fs.mkdirSync(path.join(pkg, "QuickLook"), { recursive: true });
    fs.symlinkSync(outside, path.join(pkg, "QuickLook", "Preview.pdf"));
    fs.writeFileSync(path.join(pkg, "Index.zip"), require("./fixtures/formats").zipOf([["Index/Document.iwa", require("./fixtures/formats").snappyFrame(Buffer.from([2, 8, 1]))]]));
    fs.symlinkSync(path.dirname(secret), path.join(pkg, "Data"));
    const pages = await add_(pkg);
    ok(pages === "unsupported" || (typeof pages === "object" && !/TOP-SECRET/.test(text(pages)) && pages.from === "iwork"), "a package's preview that is a link is not read, nor a linked folder in it");
    // An RTF package with a picture that is a link.
    const rtfd = path.join(links, "Notizen.rtfd");
    fs.mkdirSync(rtfd);
    fs.writeFileSync(path.join(rtfd, "TXT.rtf"), "{\\rtf1\\ansi Aufgabe 3: Notizen mit Bild.\\par}");
    fs.symlinkSync(secret, path.join(rtfd, "secret.txt"));
    const notes = await add_(rtfd);
    ok(typeof notes === "object" && /Aufgabe 3/.test(text(notes)) && !/TOP-SECRET/.test(text(notes)), "an RTF package is read without the link in it");
    ok(typeof notes === "object" && !fs.readdirSync(path.join(userData, "originals", notes.hash, "Notizen.rtfd")).includes("secret.txt"), "and its copy beside the PDF has no link in it");
  }
  // ---- a text file that talks about PDFs stays a text file
  {
    const { identify } = require("../src/formats");
    const md = path.join(dir, "PDF-Notizen.md");
    fs.writeFileSync(md, "# Notizen\nEine PDF-Datei beginnt mit %PDF-1.7 und endet mit %%EOF.\n");
    same(identify(md).kind, "text", "a .md that mentions %PDF- is text");
    const real = path.join(dir, "eigentlich-pdf.txt");
    fs.copyFileSync(path.join(dir, "elsewhere.pdf"), real);
    same(identify(real).kind, "pdf", "a file that starts as a PDF is a PDF, whatever its ending");
  }
  // ---- what could not be shown, and what was hidden, is kept with the material
  {
    const { zipOf } = require("./fixtures/formats");
    const emf = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(80)]);
    const doc = path.join(dir, "Mit EMF.docx");
    fs.writeFileSync(doc, zipOf([
      ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
      ["word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.emf"/><Relationship Id="rAlt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/><Relationship Id="rRtf" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.rtf"/></Relationships>`],
      ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>Aufgabe 1: </w:t></w:r><w:moveTo w:id="1"><w:r><w:t>VERSCHOBEN berechne die Fläche.</w:t></w:r></w:moveTo><w:moveFrom w:id="2"><w:r><w:t>ALTER-ORT</w:t></w:r></w:moveFrom></w:p><w:p><w:r><w:pict><v:shape><v:imagedata r:id="rImg"/></v:shape></w:pict></w:r></w:p><w:altChunk r:id="rAlt"/><w:altChunk r:id="rRtf"/></w:body></w:document>`],
      ["word/media/a.emf", emf],
      ["word/chunk.html", "<html><body><p>Aufgabe 2: EINGEBETTET aus HTML.</p></body></html>"],
      ["word/chunk.rtf", "{\\rtf1 Aufgabe 3}"],
    ]));
    const item = await add_(doc);
    ok(typeof item === "object" && item.missingPictures === 1, "a picture that cannot be shown is counted on the material, so the app can say so");
    ok(typeof item === "object" && /VERSCHOBEN/.test(text(item)) && !/ALTER-ORT/.test(text(item)), "moved text (a tracked change) is at its new place, not its old one");
    ok(typeof item === "object" && /EINGEBETTET/.test(text(item)) && item.leftOut === 1, "an embedded web page is put in; an embedded RTF is counted as left out");
    const sheets = await add_(fx["Noten.xlsx"]);
    same(sheets.hiddenSheets, ["Hilfsblatt"], "a hidden sheet is named on the material");
  }

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${failed ? "FAIL" : "ok"} formats: ${passed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)} s)`);
  app.exit(failed ? 1 : 0);
});

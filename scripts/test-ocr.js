// Checks of the path a book without text takes (a scan, or a book saved from a web reader that
// draws its letters as shapes):
//
//   node_modules/.bin/electron scripts/test-ocr.js
//
// - the printed page number is found in recognised page texts, also when the file is a part of a book
// - exercise numbers are found in recognised text (a "1." read as "l.", a "5." as "S."), and
//   ordinary text is checked as strictly as before
// - the helper built from native/ocr.swift: it says where it stands before the first page,
//   names one recogniser for the whole file, and reads a small PDF made of pictures
// The helper must have been built (scripts/build-ocr.sh). After a change to it, or an update of
// macOS, the first run takes about a minute longer: macOS builds its models once. Nothing
// appears on screen.
const { app, nativeImage } = require("electron");
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { quiet, hiddenWindow, capture } = require("./hidden");

quiet();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-ocr-"));
app.setPath("userData", dir);
// A helper window is opened and closed along the way (to make the pictures); that must not end the run.
app.on("window-all-closed", () => {});

let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const same = (a, b, message) => {
  assert.deepStrictEqual(a, b, message);
  checks++;
};

// ------------------------------------------------------------ printed page numbers

function offsetChecks() {
  const { printedOffset } = require("../src/files");
  const body = "Running text of the page, a few lines long.\nAnother line of it.";

  // The running head of a real textbook as it was recognised: the number at the left on even
  // pages, at the right on odd ones, after ten pages of cover and contents.
  const textbook = Array.from({ length: 40 }, (_, i) => {
    const printed = i + 1 - 10;
    if (printed < 1) return `Contents\n${body}`;
    return (printed % 2 ? `1.1 • Real Numbers: Algebra Essentials ${printed}` : `${printed} 1 • Prerequisites`) + `\n${body}\nAccess for free at openstax.org`;
  });
  same(printedOffset(textbook), 10, "the number stands at either end of the running head");

  // A footer, with some numbers misread the way the weaker recogniser does it.
  const misread = { 1: "I", 7: "?", 11: "ll", 13: "L3" };
  const footer = Array.from({ length: 16 }, (_, i) => (i < 2 ? "Chemie Grundlagen\nInhalt" : `${body}\nChemie Grundlagen ${misread[i - 1] || i - 1}`));
  same(printedOffset(footer), 2, "a few misread numbers do not hide the others");

  // Only chapter 7 of a book was scanned: its first page is page 120.
  const part = Array.from({ length: 24 }, (_, i) => `${body}\n– ${i + 120} –`);
  same(printedOffset(part), -119, "a part of a book: the printed numbers are the higher ones");
  same(printedOffset(Array.from({ length: 20 }, (_, i) => `Benutzerhandbuch\n${body}\nBestellungen finden Sie auf www.example.ch  Seite ${i + 1}`)), 0, "printed number and position agree");

  // Numbers that are not page numbers must not add up to one.
  same(printedOffset(Array.from({ length: 30 }, (_, i) => `3.${(i % 9) + 1} Lösen von Gleichungen\n${body}\nDer pH-Wert beträgt 4.5`)), 0, "section numbers and decimals are not page numbers");
  same(printedOffset(Array.from({ length: 30 }, () => `${body}\nMathematik 2`)), 0, "the same number on every page is not a page number");
  same(printedOffset(Array.from({ length: 30 }, (_, i) => `${(i * 37) % 23} apples\n${body}\ncosts ${(i * 91) % 57}`)), 0, "numbers all over the place agree on nothing");
  same(printedOffset(Array.from({ length: 5 }, (_, i) => `${body}\n${i + 3}`)), 0, "five pages are too few to be sure");
  same(printedOffset([]), 0);
}

// ------------------------------------------------------------ exercise numbers

function labelChecks() {
  const { findLabel, checkExercise } = require("../src/engine");

  // Recognised text: lists of exercises as the helper returns them (pieces of one line are
  // joined with two spaces).
  const list = "Aufgaben zu Kapitel 1\ni. Gib für HNO3 die korrespondierende Base an.\n2. Erkläre, warum Wasser ein Ampholyt ist.\n3. Ordne zu: Donator oder Akzeptor?\n4. Formuliere die Protolyse.\nS. Berechne den pH-Wert von Salzsäure.\n6. Berechne c(H3O+) einer Lösung.";
  same([findLabel(list, "1", true), findLabel(list, "5", true), findLabel(list, "3", true)], [2, 2, 2], '"i." before "2." is the 1, "S." between "4." and "6." is the 5');
  ok(findLabel(list, "1") < 2 && findLabel(list, "5") < 2, "in ordinary text a letter is never read as a number");
  same(findLabel("l. What is the order of operations?  2. What acronym is used?  3. Explain your answer.", "1", true), 2, '"l." at the start, in a row of three');
  same(findLabel("9. Skizziere die Kurve.\n1O. Wie viele mL Salzsäure werden neutralisiert?\n11. Welcher Indikator eignet sich?", "10", true), 2, "two digits, one of them misread");
  same(findLabel("10. Skizziere die Kurve.\nll. Welcher Indikator eignet sich?\n12. Formuliere.", "11", true), 0, "no digit left at all: not taken for a number");
  same(findLabel("1 Gib die Base an.  2 Erkläre den Begriff.  3 Ordne zu.\n4 Formuliere die Protolyse.", "2", true), 2, "a number without its full stop at the start of a column");
  same(findLabel("1 Gib die Base an.  2 Erkläre den Begriff.  3 Ordne zu.\n4 Formuliere die Protolyse.", "2"), 1, "ordinary text: as strict as before");

  // What must not be taken for an exercise number, recognised or not.
  same(findLabel("Siehe auch\nS. 45 im Lehrbuch.\nI. Einleitung\ni. e. the first one", "5", true), 0, "a line that starts with S. and has no neighbours");
  same(findLabel("4. Formuliere die Protolyse.\nS. 45 zeigt die Kurve.\n6. Berechne.", "5", true), 0, '"S. 45" is a page, also between exercises');
  same(findLabel("I. Einleitung\nDer Text beginnt hier.", "1", true), 0, "a Roman numeral on its own");
  same(findLabel("2. Löse die Gleichung:\ni) für x = 2\nii) für x = 3\n3. Zeichne den Graphen.", "1", true), 0, 'the part "i)" of exercise 2 comes after it: not exercise 1');
  same(findLabel("Breite  12 cm\nLänge  13 Meter", "12", true), 1, "a number in a table");
  same(findLabel("costs 17 apples", "7", true), 0);
  same(findLabel("A solution like this has a pH of 2. Pure water is neutral.", "2", true), 1, "a number that ends a sentence");
  same(findLabel("Aufgabe 12 a) Berechne", "12 a", true), 2, "what was found before is still found");

  // A whole book: only one whose text was recognised gets the looser reading.
  const pages = ["Theorie, keine Aufgaben.", list, "7. Berechne den pH-Wert.\n8. Eine Lösung hat c(OH-).\n9. Um welchen Faktor?"];
  const recognised = { data: { pages, recognised: true } };
  same(checkExercise(recognised, 2, "1"), { page: 2, state: "confirmed" });
  same(checkExercise(recognised, 3, "5"), { page: 2, state: "moved" }, "a misread number is still found one page off");
  same(checkExercise(recognised, 1, "12"), { page: 1, state: "unconfirmed" });
  same(checkExercise({ data: { pages } }, 2, "1"), { page: 2, state: "unconfirmed" }, "a book with real text is checked as before");
  // A page's own number in its running head is not an exercise. Exercise 12 is on page 14 of
  // the file (printed page 4); page 22 is printed page 12 and starts with that number.
  const head = (printed) => (printed < 1 ? "Contents" : printed % 2 ? `1.1 • Real Numbers: Algebra Essentials ${printed}` : `${printed}  1 • Prerequisites`);
  const withHeads = (recognised) => ({ data: { recognised, pages: Array.from({ length: 30 }, (_, i) => head(i + 1 - 10) + (i === 13 ? "\n11. Simplify.\n12. Evaluate the expression.\n13. Solve." : "\nRunning text.")) } });
  for (const book of [withHeads(true), withHeads(false)]) {
    same(checkExercise(book, 21, "12", 10), { page: 21, state: "unconfirmed" }, "the page that carries 12 as its page number is not where exercise 12 is");
    same(checkExercise(book, 22, "12", 10), { page: 22, state: "unconfirmed" });
    same(checkExercise(book, 4, "12", 10), { page: 14, state: "moved" }, "the printed page the model gave is still put right");
    same(checkExercise(book, 13, "12", 10), { page: 14, state: "moved" });
  }
  same(checkExercise({ data: { pages: ["Titel", "2. Löse die Gleichung.\n3. Zeichne."] } }, 2, "2"), { page: 2, state: "confirmed" }, "an exercise with the number of its page is still found");
  // The model gave the printed page (130) of a scanned part of a book that starts at page 120.
  const part = { data: { recognised: true, pages: Array.from({ length: 30 }, (_, i) => (i === 10 ? list : `Text of page ${i + 120}.`)) } };
  same(checkExercise(part, 130, "3", -119), { page: 11, state: "moved" }, "a printed page number above the page count is put right");
}

// ------------------------------------------------------------ a PDF made of pictures

const PAGE = { width: 600, height: 850 };
const COLUMNS = 4;

const EXERCISES = ["Gib für HNO3 die korrespondierende Base an.", "Erkläre, warum Wasser ein Ampholyt ist.", "Ordne zu: Protonendonator oder Protonenakzeptor?", "Formuliere die Protolyse von Essigsäure in Wasser."];
const THEORY = "Nach Brønsted ist eine Säure ein Teilchen, das ein Proton abgibt. Man nennt sie deshalb Protonendonator. Eine Base nimmt ein Proton auf und heisst Protonenakzeptor. Wasser kann als Säure oder als Base reagieren.";

/** A small book: a title page, a contents page, then ten pages with a printed number (1 to 10); exercises on printed page 4. */
function bookPages() {
  const page = (body, printed) => `<section>${body}${printed ? `<footer>Chemie Grundlagen &nbsp; ${printed}</footer>` : ""}</section>`;
  const pages = [page("<h1>Chemie Grundlagen</h1><p>Lehrmittel für die Sekundarstufe</p>"), page("<h1>Inhalt</h1><p>Säuren und Basen</p><p>Der pH-Wert</p>")];
  for (let printed = 1; printed <= 10; printed++) {
    pages.push(printed === 4 ? page("<h2>Aufgaben zu Kapitel 1</h2>" + EXERCISES.map((text, i) => `<p>${i + 1}. ${text}</p>`).join(""), printed) : page(`<h2>Kapitel ${printed}: Säuren und Basen</h2><p>${THEORY}</p><p>${THEORY}</p>`, printed));
  }
  return pages;
}

/** Pictures of the pages, taken from one hidden window that shows them side by side. */
async function pictures(pages) {
  const rows = Math.ceil(pages.length / COLUMNS);
  const win = hiddenWindow(PAGE.width * COLUMNS, PAGE.height * rows);
  const style = `<style>
    body { margin: 0; background: #fff; color: #000; font: 17px/1.5 Georgia, serif; display: grid; grid-template-columns: repeat(${COLUMNS}, ${PAGE.width}px); }
    section { width: ${PAGE.width}px; height: ${PAGE.height}px; box-sizing: border-box; padding: 50px; position: relative; overflow: hidden; }
    footer { position: absolute; bottom: 40px; left: 0; right: 0; text-align: center; font-size: 15px; }
    h1 { font-size: 30px; } h2 { font-size: 22px; }
  </style>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<meta charset="utf-8">${style}${pages.join("")}`));
  const sheet = nativeImage.createFromBuffer(await capture(win));
  win.destroy();
  // The capture has two pixels per point on some screens.
  const scale = sheet.getSize().width / (PAGE.width * COLUMNS);
  assert.ok(scale === 1 || scale === 2, `the capture has the size of the window (${JSON.stringify(sheet.getSize())})`);
  const width = PAGE.width * scale;
  const height = PAGE.height * scale;
  return pages.map((_, i) => {
    const bgra = sheet.crop({ x: (i % COLUMNS) * width, y: Math.floor(i / COLUMNS) * height, width, height }).toBitmap();
    assert.strictEqual(bgra.length, width * height * 4, "the picture of a page has the size of a page");
    const gray = Buffer.alloc(width * height);
    for (let p = 0; p < gray.length; p++) gray[p] = (bgra[p * 4] * 29 + bgra[p * 4 + 1] * 150 + bgra[p * 4 + 2] * 77) >> 8;
    return { width, height, gray };
  });
}

/** A PDF with one picture per page and no text in it: what a scan is to the app. */
function picturePdf(images) {
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let size = parts[0].length;
  const object = (n, dict, stream) => {
    offsets[n] = size;
    const pieces = [Buffer.from(`${n} 0 obj\n${dict}\n`), ...(stream ? [Buffer.from("stream\n"), stream, Buffer.from("\nendstream\n")] : []), Buffer.from("endobj\n")];
    parts.push(...pieces);
    size += pieces.reduce((sum, piece) => sum + piece.length, 0);
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${images.length} >>`);
  images.forEach((image, i) => {
    const n = 3 + i * 3;
    const draw = Buffer.from("q 595 0 0 842 0 0 cm /Im0 Do Q");
    const data = zlib.deflateSync(image.gray);
    object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    object(n + 1, `<< /Length ${draw.length} >>`, draw);
    object(n + 2, `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`, data);
  });
  const count = 2 + images.length * 3;
  const table = Array.from({ length: count }, (_, i) => String(offsets[i + 1]).padStart(10, "0") + " 00000 n \n").join("");
  parts.push(Buffer.from(`xref\n0 ${count + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ the helper

/** Every line the helper prints for a file, as objects. */
function helperLines(helper, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim().split("\n").map((line) => JSON.parse(line))) : reject(new Error("the helper ended with " + code))));
  });
}

const wordsIn = (text, words) => words.filter((word) => text.toLowerCase().includes(word.toLowerCase())).length;

async function helperChecks() {
  const ocr = require("../src/ocr");
  const files = require("../src/files");
  const { checkExercise } = require("../src/engine");
  const helper = path.join(__dirname, "..", "build", "bin", "aced-ocr");
  assert.ok(ocr.available(), "the helper is not built: run scripts/build-ocr.sh first");

  const pages = bookPages();
  const file = path.join(dir, "Chemie Grundlagen (Scan).pdf");
  fs.writeFileSync(file, picturePdf(await pictures(pages)));

  // ---- what the helper prints
  const lines = await helperLines(helper, [file]);
  same(lines[0], { page: 0, total: pages.length }, "the first line comes before anything is read: page 0 of N");
  const named = lines.filter((line) => line.recogniser);
  const firstText = lines.findIndex((line) => "text" in line);
  same(named.length, 1, "one recogniser is named for the file");
  ok(lines.indexOf(named[0]) < firstText, "and it is named before the first page");
  // On a Mac whose accurate recogniser cannot be used this says "fast", and the check fails there.
  // "fast" is the fallback macOS gives while its accurate recogniser is not ready (after an update,
  // or under load): the file is still read, and the app says which one read it.
  ok(["accurate", "fast"].includes(named[0].recogniser), "a recogniser reads the file, and the app knows which");
  same(lines.filter((line) => "text" in line).map((line) => line.page), pages.map((_, i) => i + 1), "then every page, in order");
  ok(lines.every((line) => line.total === pages.length && ("text" in line || line.page <= pages.length)));
  same((await helperLines(helper, [file, "6", "6"])).filter((line) => "text" in line).map((line) => line.page), [6], "a range of pages");

  // ---- the same through ocr.js
  const steps = [];
  const texts = await ocr.read(file, (done, total, state) => steps.push([done, total, state]));
  same(steps[0], [0, pages.length, undefined], "progress starts at page 0, before the recogniser is known");
  same(steps.at(-1), [pages.length, pages.length, "accurate"]);
  const states = steps.map((step) => step[2]).filter((state) => state && state !== "preparing");
  ok(states.length >= pages.length && new Set(states).size === 1, "one recogniser from the first page to the last");
  ok(steps.every((step, i) => i === 0 || step[0] >= steps[i - 1][0]), "the page count only goes up");
  same(texts.length, pages.length);
  if (process.env.ACED_TEST_TRACE) console.log(texts.map((text, i) => `--- page ${i + 1}\n${text}`).join("\n"));
  ok(wordsIn(texts[0], ["Chemie", "Grundlagen", "Lehrmittel"]) === 3, "the title page is read");
  ok(wordsIn(texts[4], ["Brønsted", "Säure", "Teilchen", "Proton", "Protonendonator", "Protonenakzeptor", "Wasser", "reagieren"]) >= 7, "running text is read, umlauts and all: " + texts[4].slice(0, 200));
  ok(/(^|\n)1\. Gib für/.test(texts[5]) && /(^|\n)4\. Formuliere/.test(texts[5]), "the exercises keep their numbers: " + texts[5]);
  ok(/Chemie Grundlagen\s+4\s*$/.test(texts[5]), "the footer with the page number is the last line");
  same(await ocr.prepare(), "accurate", "getting ready ahead of the first book names the same recogniser");

  // ---- stopping
  const stop = new AbortController();
  let failure = null;
  await ocr.read(file, () => stop.abort(), stop.signal).catch((err) => (failure = err));
  same(failure && failure.code, "cancelled", "the helper is stopped when the person cancels");
  const gone = new AbortController();
  gone.abort();
  failure = null;
  await ocr.read(file, null, gone.signal).catch((err) => (failure = err));
  same(failure && failure.code, "cancelled");
  failure = null;
  await ocr.read(path.join(dir, "missing.pdf")).catch((err) => (failure = err));
  same(failure && failure.message, "ocr", "a file the helper cannot open is an error, not an empty book");

  // ---- the whole way: a file without text is added to the library
  files.init(dir);
  const said = [];
  const item = await files.add(file, (done, total, phase, state) => said.push({ done, total, phase, state }));
  const recognising = said.filter((s) => s.phase === "recognise");
  same([recognising[0].done, recognising[0].total, recognising[0].state], [0, pages.length, undefined], '"recognising, page 0 of N" is said before the helper has read anything');
  same(said.findIndex((s) => s.phase === "recognise"), said.findLastIndex((s) => s.phase === "read") + 1, "right after the file itself was read");
  same([item.pages, item.scanned, item.recognised, item.offset], [pages.length, false, true, 2], "the book is usable, and its printed page numbers are found");
  const data = files.readText(item.hash);
  same(data.recogniser, "accurate", "which recogniser read the book is kept with its text");
  const source = { data };
  same(checkExercise(source, 6, "3"), { page: 6, state: "confirmed" }, "an exercise is found on the recognised page");
  same(checkExercise(source, 9, "3", item.offset), { page: 9, state: "unconfirmed" }, "and not where it is not");
  const again = await files.add(file, () => assert.fail("a book that was read before is not read again"));
  same(again.hash, item.hash);
}

app.whenReady().then(async () => {
  let failed = false;
  try {
    for (const part of [offsetChecks, labelChecks, helperChecks]) {
      if (process.env.ACED_TEST_TRACE) console.log("…", part.name);
      await part();
    }
    console.log(`ok: ${checks} checks`);
  } catch (err) {
    console.log("FAIL", err.message, "\n", String(err.stack).split("\n").slice(1, 4).join("\n"));
    failed = true;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // Not app.quit(): Electron then ends with 0 whatever process.exitCode says.
  app.exit(failed ? 1 : 0);
});

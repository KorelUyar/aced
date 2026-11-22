// Sharing (0.5): the sample exam, with a real book of its own, shared from one fresh profile and
// opened in a second one: a new exam at 0%, the plan and formula sheet as sent, the questions
// without answers, the material that went along read again, and the book waiting for the
// friend's own copy, found at once when it is the same file, and called another edition when it
// is not. What may never go along is checked in the file itself. Then hostile Aced files: a zip
// bomb, names that try to leave the folder, a material that is not what it says, huge fields, a
// newer version, damaged files. And the exam as one page (the PDF and the web page).
//
//   node_modules/.bin/electron scripts/test-share.js
const { app, BrowserWindow, protocol } = require("electron");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { quiet } = require("./hidden");

protocol.registerSchemesAsPrivileged([{ scheme: "aced-print", privileges: { standard: true, secure: true } }]);
quiet();
app.on("window-all-closed", () => {});

let passed = 0;
let failed = 0;
const ok = (value, message) => {
  if (value) passed++;
  else {
    failed++;
    console.log("FAIL", message);
  }
};
const same = (a, b, message) => {
  try {
    assert.deepStrictEqual(a, b);
    passed++;
  } catch {
    failed++;
    console.log("FAIL", message, "\n  got     ", JSON.stringify(a), "\n  expected", JSON.stringify(b));
  }
};
const failsWith = async (fn, code, message) => {
  try {
    await fn();
    failed++;
    console.log("FAIL", message, "(no error)");
  } catch (err) {
    same(err.code, code, message);
  }
};

/**
 * A PDF that tells a lot about itself: an author, a path for a title, the app that made it, XMP,
 * and a photo whose EXIF names its owner. Its page says "Dichte rho = m / V".
 */
function metaPdf() {
  const { nativeImage } = require("electron");
  const jpeg = nativeImage.createFromBuffer(require("./fixtures/formats").png(60, 40, [30, 90, 200])).toJPEG(85);
  const owner = Buffer.from("SENDER-CAMERA-OWNER\0", "latin1");
  const tiff = Buffer.concat([Buffer.from("4d4d002a00000008" + "0001" + "013b0002" + owner.length.toString(16).padStart(8, "0") + "0000001a" + "00000000", "hex"), owner]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (tiff.length + 8) >> 8, (tiff.length + 8) & 255]), Buffer.from("Exif\0\0", "latin1"), tiff]);
  const photo = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
  const xmp = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Jamie Example</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const content = "q 120 0 0 80 40 60 cm /Im1 Do Q BT /F1 14 Tf 40 30 Td (Dichte rho = m / V) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 160] /Resources << /XObject << /Im1 5 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>",
    [`<< /Length ${content.length} >>`, Buffer.from(content, "latin1")],
    [`<< /Type /XObject /Subtype /Image /Width 60 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${photo.length} >>`, photo],
    [`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>`, Buffer.from(xmp)],
    "<< /Author (Jamie Example) /Title (/home/jamie/Documents/Secret.docx) /Creator (Microsoft Word) /Producer (Microsoft Word) >>",
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((o, i) => {
    const chunk = Array.isArray(o) ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o[0]}\nstream\n`, "latin1"), o[1], Buffer.from("\nendstream\nendobj\n", "latin1")]) : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1");
    offsets.push(at);
    parts.push(chunk);
    at += chunk.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** A book of `pages` pages, each with its number and two exercises on it. */
async function book(file, pages, title) {
  const win = new BrowserWindow({ show: false });
  const body = Array.from({ length: pages }, (_, i) => `<section style="break-after:page"><h2>${title} – Seite ${i + 1}</h2><p>Aufgabe ${i * 2 + 1}. Löse die Gleichung.</p><p>Aufgabe ${i * 2 + 2}. Berechne die Nullstellen.</p><p style="position:absolute;bottom:0">${i + 1}</p></section>`).join("");
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<meta charset="utf-8"><body style="font:14px Helvetica">${body}</body>`));
  fs.writeFileSync(file, await win.webContents.printToPDF({}));
  win.destroy();
}

app.whenReady().then(async () => {
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aced-test-share-"));
  const A = path.join(root, "sender");
  const B = path.join(root, "friend");
  fs.mkdirSync(A);
  fs.mkdirSync(B);
  const store = require("../src/store");
  const files = require("../src/files");
  const share = require("../src/share");
  const sample = require("../src/sample").exams("de")[0];

  // ---- the sender: the sample exam, with a real book and a real worksheet
  files.init(A);
  store.init({ dir: A, systemLang: "de" });
  const bookFile = path.join(root, "Mathematik 1.pdf");
  await book(bookFile, 112, "Mathematik 1");
  const bookItem = await files.add(bookFile);
  const worksheet = path.join(root, "Arbeitsblatt 7.docx");
  fs.writeFileSync(worksheet, require("./fixtures/formats").docx());
  const sheetItem = await files.add(worksheet, null, null, { lang: "de" });
  const objectives = files.addText("Ich kann die Scheitelpunktform herleiten.\nIch kann Nullstellen berechnen.", "Lernziele");
  // A note that stays home, and a sheet with a photo that says a lot about itself, read by an AI.
  const note = files.addText("SENDER-PRIVATE-NOTE: mein Passwort", "SENDER-NOTE-TITLE");
  const metaFile = path.join(root, "Dichte.pdf");
  fs.writeFileSync(metaFile, metaPdf());
  const metaItem = await files.add(metaFile);
  ok(/Dichte rho/.test(files.readText(metaItem.hash).pages[0]), "the sheet with the photo reads");
  files.writeText(metaItem.hash, { ...files.readText(metaItem.hash), pages: ["AI-READ: Dichte ρ = m/V"], recognised: true, reader: "ai", model: "claude-opus-5-5" });
  const sheetText = files.readText(sheetItem.hash).pages;
  const exam = store.createExam(sample);
  store.change(exam.id, (e) => {
    e.materials = [
      { ...bookItem, id: "m1", kind: "book", title: "Mathematik 1: Algebra und Funktionen" },
      { ...sheetItem, id: "m4", kind: "notes" },
      { ...objectives, id: "m2", kind: "objectives" },
      { ...note, id: "m6", kind: "notes" },
      { ...metaItem, id: "m7", kind: "notes", read: "ai", model: "claude-opus-5-5" },
    ];
    e.strategy = structuredClone(sample.strategy);
    e.strategy.topics[0].steps.push({ id: "t1/note", kind: "read", material: "m6", from: 1, to: 1, minutes: 5 });
    e.formulas = sample.formulas;
    e.sets = structuredClone(sample.sets);
    // What the sender has done, typed and was told: none of it may go along.
    e.done = { "t1/r0": { date: "2026-11-20", minutes: 15, at: 1 } };
    e.sets["final#0"].draft = { "final#0/k0": "SENDER-TYPED-ANSWER" };
    e.sets["final#0"].result = { points: 3, max: 10, typed: { "final#0/k0": "SENDER-RESULT" }, marks: {} };
    e.results = [{ date: "2026-11-20", points: 3, max: 10, grade: 2.5 }];
    e.usage = { input: 123456, output: 999, cost: 4.2 };
    e.answers = ["k-secret-answer-key"];
  });
  store.setSettings({ ai: { provider: "anthropic", model: "claude-opus-5-5" } });
  const sent = store.exam(exam.id);
  const acedFile = path.join(root, share.fileName(sent.name, "aced"));
  const copies = fs.mkdtempSync(path.join(root, "copies-"));
  const packed = await share.packExam(sent, { chosen: ["m4", "m2", "m7"], appVersion: "0.5.0", files, ocr: require("../src/ocr"), dir: copies });
  same(packed.left, [], "every ticked PDF could be copied clean");
  same(fs.readdirSync(copies), [], "and the copies are gone again");
  fs.writeFileSync(acedFile, packed.bytes);
  same(path.basename(acedFile), "Mathematik Quadratische Funktionen.aced", "the file is named after the exam, nothing else");

  // ---- what is in the file
  const zip = require("../src/formats/zip");
  const archive = zip.open(acedFile);
  same(archive.names.sort(), ["aced.json", "m/2.pdf", "m/5.pdf"], "only the plan and the material that was ticked (the worksheet and the sheet as PDFs; the book stays out)");
  const raw = archive.read("aced.json").toString("utf8");
  const pdfs = Buffer.concat([archive.read("m/2.pdf"), archive.read("m/5.pdf")]).toString("latin1");
  archive.close();
  for (const [what, bad] of [
    ["the author", "Jamie Example"],
    ["a path as the title", "Secret.docx"],
    ["the app that made it", "Microsoft Word"],
    ["XMP", "xmpmeta"],
    ["EXIF", "Exif"],
    ["the photo's owner", "SENDER-CAMERA-OWNER"],
    ["the converter's page address", "aced-print"],
    ["the Mac's system version", "macOS Version"],
    ["the time the copy was made", "D:20"],
  ]) ok(!pdfs.includes(bad), `never in a PDF of the file: ${what}`);
  const doc = JSON.parse(raw);
  same([doc.format, doc.version, doc.exam.name], ["aced-exam", 1, sample.name], "a versioned Aced file");
  for (const [what, bad] of [
    ["ticks", '"done"'],
    ["typed answers", "SENDER-TYPED-ANSWER"],
    ["results", "SENDER-RESULT"],
    ["results list", '"results"'],
    ["usage", "123456"],
    ["kept answers", "k-secret-answer-key"],
    ["AI settings", "anthropic"],
    ["the profile's folder", A],
    ["the book's file name", "Mathematik 1.pdf"],
    ["the user's name", os.userInfo().username],
    ["the home folder", os.homedir()],
    ["an unticked note's title", "SENDER-NOTE-TITLE"],
    ["an unticked note's text", "SENDER-PRIVATE-NOTE"],
  ]) ok(!raw.includes(bad), `never in the file: ${what}`);
  ok(!doc.materials.some((m) => m.id === "m6"), "material that stays home has no entry at all");
  ok(!doc.strategy.topics.some((t) => t.steps.some((st) => st.material === "m6")), "and no step points at it");
  const sentBook = doc.materials.find((m) => m.id === "m1");
  same(Object.keys(sentBook).sort(), ["hash", "id", "included", "kind", "pages", "probe", "title"], "a book that stays home: its title, pages and fingerprint only");
  ok(sentBook.included === false && sentBook.hash === bookItem.hash && sentBook.probe.text.length === 3 && sentBook.probe.text.every((x) => /^[a-f0-9]{16}$/.test(x)), "the book is named with its SHA-256 and three page fingerprints, without its pages");
  ok(/^[a-f0-9-]{36}$/.test(doc.id), "every shared file has an id of its own");
  ok(doc.sets[0].questions.every((q) => !("draft" in q) && !("typed" in q)) && !("result" in doc.sets[0]), "questions go along without anything typed or marked");

  // ---- the friend: a new exam at 0%, the book waiting for their copy
  files.init(B);
  store.init({ dir: B, systemLang: "de" });
  const id = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22" });
  const got = store.exam(id);
  const view = store.view(got);
  same([got.name, view.percent, Object.keys(got.done).length, got.results.length, got.usage.input], [sample.name, 0, 0, 0, 0], "a new exam at 0%: no ticks, no results, no usage");
  same(got.shared, { on: "2026-11-22", id: doc.id }, "marked as shared, with the day and the file's id");
  ok(!got.strategy.stale, "opening it does not call for a new plan");
  const m7 = got.materials.find((m) => m.id === "m7");
  same([m7.read, m7.model, files.readText(m7.hash).pages], ["ai", "claude-opus-5-5", ["AI-READ: Dichte ρ = m/V"]], "what the sender's AI read came along: nothing is read again");
  same(got.strategy.topics.map((t) => t.steps.length), sample.strategy.topics.map((t) => t.steps.length), "the plan as it was sent, step by step");
  same(got.formulas.map((g) => g.formulas.length), sample.formulas.map((g) => g.formulas.length), "the formula sheet");
  ok(Object.values(got.sets).every((set) => set.result === null && Object.keys(set.draft).length === 0), "the questions, waiting to be answered");
  const m1 = got.materials.find((m) => m.id === "m1");
  same([m1.missing, m1.expect.pages, m1.expect.hash === bookItem.hash], [true, 112, true], "the book waits for the friend's own copy");
  const m4 = got.materials.find((m) => m.id === "m4");
  ok(!m4.missing && m4.pages === 2 && /Quadratische Gleichungen/.test(files.readText(m4.hash).pages.join(" ")), "the worksheet came along");
  same(files.readText(m4.hash).pages, sheetText, "with the text the sender's Aced read");
  ok(/Scheitelpunktform herleiten/.test(files.readText(got.materials.find((m) => m.id === "m2").hash).pages.join(" ")), "the learning objectives came along");
  // Another edition: fewer pages, another title.
  const other = path.join(root, "Mathe neu.pdf");
  await book(other, 98, "Neue Auflage");
  const second = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22" });
  const r1 = await share.supplyBook(second, "m1", other, { store, files, lang: "de" });
  same(r1.edition, "other", "a book with other pages and another title is called another edition");
  // As many pages, but other text on them: another edition too, whatever its name.
  const lookalike = path.join(root, "Mathematik 1 Kopie.pdf");
  await book(lookalike, 112, "Andere Ausgabe");
  const fourth = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22" });
  same((await share.supplyBook(fourth, "m1", lookalike, { store, files, lang: "de" })).edition, "other", "as many pages with other text on them: another edition");
  // Another file of the same edition (made again: other bytes, the same text): the same book.
  const again = path.join(root, "Mathematik 1 nochmals.pdf");
  await book(again, 112, "Mathematik 1");
  const fifth = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22" });
  const r3 = await share.supplyBook(fifth, "m1", again, { store, files, lang: "de" });
  ok(r3.item.hash !== bookItem.hash && r3.edition === "same", "another file with the same text on the same pages: the same edition");
  // The same book: found by its SHA-256, and the plan's steps point into it.
  const r2 = await share.supplyBook(id, "m1", bookFile, { store, files, lang: "de" });
  same(r2.edition, "same", "the same book is found by its SHA-256");
  const after = store.exam(id).materials.find((m) => m.id === "m1");
  ok(!after.missing && after.hash === bookItem.hash && fs.existsSync(files.pdfPath(after.hash)), "the book takes its place in the plan, with its pages");
  ok(store.exam(id).strategy.topics[0].steps.every((st) => !st.material || st.material === "m1"), "the steps still point to it");
  // Opened again on this Mac: the book is there at once.
  const third = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22" });
  same(store.exam(third).materials.find((m) => m.id === "m1").missing, undefined, "a book this Mac already has is found at once");
  // The same shared file again, when the person is asked: open the exam they have, add another
  // copy, or nothing.
  let asked = 0;
  const reopened = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22", already: async () => (asked++, "open") });
  ok(asked === 1 && store.exam(reopened).shared.id === doc.id, "the same shared file again: the person is asked, and the exam they have opens");
  const count = store.exams().length;
  const copied = await share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22", already: async () => "copy" });
  ok(copied !== reopened && store.exams().length === count + 1, "or another copy is added, when they say so");
  await failsWith(() => share.importExam(acedFile, { store, files, lang: "de", today: "2026-11-22", already: async () => "cancel" }), "cancelled", "or nothing happens");
  same(store.exams().length, count + 1, "and nothing was added then");

  // ---- hostile Aced files
  const H = path.join(root, "hostile");
  fs.mkdirSync(H);
  const put = (name, bytes) => {
    const f = path.join(H, name);
    fs.writeFileSync(f, bytes);
    return f;
  };
  const docOf = (patch) => JSON.stringify({ ...doc, ...patch });
  const zipOf = share.zipOf;
  const importing = (f) => () => share.importExam(f, { store, files, lang: "de", today: "2026-11-22" });
  // Ids every object has ("constructor", "__proto__" …): refused, so nothing reads as ticked off.
  const odd = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
  const topic0 = doc.strategy.topics[0];
  const oddFile = put(
    "odd ids.aced",
    zipOf([
      [
        "aced.json",
        Buffer.from(
          JSON.stringify({
            ...doc,
            materials: [...doc.materials, { id: "__proto__", kind: "notes", type: "text", title: "x", included: true, text: "x" }, { id: "constructor", kind: "notes", type: "text", title: "y", included: true, text: "y" }],
            strategy: { ...doc.strategy, topics: [topic0, { ...topic0, id: "constructor" }, { ...topic0, id: "t-odd", steps: topic0.steps.map((st, i) => ({ ...st, id: odd[i % odd.length] })) }] },
          }),
        ),
      ],
    ]),
  );
  const oddExam = store.exam(await share.importExam(oddFile, { store, files, lang: "de", today: "2026-11-22" }));
  const oddIds = [...oddExam.materials.map((m) => m.id), ...oddExam.strategy.topics.flatMap((t) => [t.id, ...t.steps.map((st) => st.id)])];
  ok(!oddIds.some((x) => odd.includes(x)), "ids every object has are refused on import");
  same(store.view(oddExam).percent, 0, "and nothing reads as ticked off");
  const { tickOf } = require("../src/planner");
  ok(tickOf({}, "constructor") === undefined && tickOf({}, "toString") === undefined && tickOf({ a: 1 }, "a") === 1, "a step is ticked off only by an entry of its own");
  const before = store.exams().length;
  await failsWith(importing(put("kein-zip.aced", "just text")), "damaged", "a file that is not a zip");
  await failsWith(importing(put("ohne-json.aced", zipOf([["readme.txt", Buffer.from("hi")]]))), "damaged", "a zip without aced.json");
  await failsWith(importing(put("kaputt.aced", zipOf([["aced.json", Buffer.from("{not json")]]))), "damaged", "broken JSON");
  await failsWith(importing(put("fremd.aced", zipOf([["aced.json", Buffer.from(JSON.stringify({ format: "something", version: 1 }))]]))), "damaged", "another kind of JSON");
  await failsWith(importing(put("neuer.aced", zipOf([["aced.json", Buffer.from(docOf({ version: 99, app: "9.0.0" }))]]))), "newer", "a file from a newer Aced says so");
  const cut = fs.readFileSync(acedFile);
  await failsWith(importing(put("abgeschnitten.aced", cut.subarray(0, Math.floor(cut.length / 2)))), "damaged", "a file cut in half");
  // A bomb: aced.json unpacks to 64 MB of spaces.
  const zeros = zlib.deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 32), { level: 9 });
  const bomb = zipOf([["aced.json", Buffer.from("{}")]]);
  const bombFile = put("bombe.aced", Buffer.concat([bomb]));
  {
    // Built by hand: the entry claims 2 bytes and holds 64 MB.
    const crc = zlib.crc32(Buffer.from("{}")) >>> 0;
    const name = Buffer.from("aced.json");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zeros.length, 18);
    local.writeUInt32LE(2, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(zeros.length, 20);
    c.writeUInt32LE(2, 24);
    c.writeUInt16LE(name.length, 28);
    const dir = Buffer.concat([c, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(30 + name.length + zeros.length, 16);
    fs.writeFileSync(bombFile, Buffer.concat([local, name, zeros, dir, end]));
  }
  const t0 = Date.now();
  await failsWith(importing(bombFile), "tooLarge", "a zip bomb in aced.json is refused");
  ok(Date.now() - t0 < 10000, "and quickly");
  // Names that try to leave the folder, a material that is no PDF, a link's target as content.
  const evil = docOf({
    exam: { name: "X".repeat(100000), date: "not a date", time: { mode: "perDay", minutes: 1e9 }, scale: "evil", target: 1e9, pace: "<script>" },
    materials: [
      { id: "m1", kind: "book", type: "pdf", title: "../../../etc/passwd", pages: 5, hash: "zz", included: true, file: "../../../../tmp/evil.pdf" },
      { id: "m2", kind: "notes", type: "pdf", title: "Notiz", pages: 1, included: true, file: "m/2.pdf" },
      { id: "m3", kind: "notes", type: "pdf", title: "Absolut", pages: 1, included: true, file: "/etc/hosts" },
      { id: "../m4", kind: "notes", type: "text", title: "Böse Id", text: "x", included: true },
      { id: "m5", kind: "objectives", type: "text", title: "<img src=x onerror=alert(1)>", text: "Lernziel " + "y".repeat(5_000_000), included: true },
    ],
    strategy: { ...doc.strategy, approach: "z".repeat(50000), topics: Array.from({ length: 500 }, (_, i) => ({ ...doc.strategy.topics[0], id: "t" + i })) },
    sets: [{ key: "final#0", final: true, topicIds: ["t1"], questions: [{ id: "q", topicId: "t1", type: "text", prompt: "p", answer: "a", points: 99999 }], draft: { q: "typed" }, result: { points: 1 } }],
  });
  const evilFile = put("böse.aced", zipOf([
    ["aced.json", Buffer.from(evil)],
    ["m/2.pdf", Buffer.from("/etc/passwd")],
    ["../../../../tmp/evil.pdf", Buffer.from("%PDF-1.4 escaped")],
  ]));
  const evilId = await share.importExam(evilFile, { store, files, lang: "de", today: "2026-11-22" });
  const e = store.exam(evilId);
  ok(e.name.length <= 120 && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.time.minutes <= 960 * 25 && ["ch", "de", "pct"].includes(e.scale) && e.target <= 100 && e.pace !== "<script>", "every field of the exam is checked and cut to size");
  same(e.materials.map((m) => m.id).sort(), ["m1", "m2", "m3", "m5"], "a material with an id that is no id is left out");
  ok(e.materials.find((m) => m.id === "m1").missing && e.materials.find((m) => m.id === "m3").missing, "a material whose file name leaves the folder is not read: it waits like a book");
  ok(e.materials.find((m) => m.id === "m2").missing, "a 'PDF' that is not one is not taken");
  ok(!fs.existsSync("/tmp/evil.pdf") || fs.readFileSync("/tmp/evil.pdf", "utf8") !== "%PDF-1.4 escaped", "nothing is written where a name inside the file points");
  ok(files.readText(e.materials.find((m) => m.id === "m5").hash).pages.join("").length <= 3000000, "a huge text is cut");
  ok(e.strategy.topics.length <= 60 && e.strategy.approach.length <= 4000, "a huge plan is cut");
  ok(e.sets["final#0"].questions[0].points <= 20 && e.sets["final#0"].result === null && Object.keys(e.sets["final#0"].draft).length === 0, "questions are checked, and nothing typed comes in");
  same(store.exams().length, before + 1, "only the readable file became an exam");

  // ---- the exam as one page: the PDF and the web page
  const { examPage, footerOf } = require("../src/export");
  const page = await examPage(store.exam(id), { lang: "de" });
  ok(!/<script/i.test(page) && /Content-Security-Policy" content="default-src 'none'/.test(page), "the web page has no script and loads nothing");
  ok(/<math/.test(page) && /Gemacht mit Aced · uyarid\.com/.test(page), "formulas as MathML, and the line at its foot");
  ok(!page.includes(B) && !page.includes(os.userInfo().username) && !page.includes("SENDER"), "nothing of the person in it");
  const htmlFile = path.join(root, "seite.html");
  fs.writeFileSync(htmlFile, page);
  const pdf = path.join(root, "seite.pdf");
  await require("../src/print").print(htmlFile, pdf, { footer: footerOf("de") });
  const text = (await (async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const d = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    for (let n = 1; n <= d.numPages; n++) pages.push((await (await d.getPage(n)).getTextContent()).items.map((i) => i.str).join(" "));
    return pages;
  })());
  ok(text.length >= 2 && text.every((p) => /Gemacht mit Aced/.test(p)), "the PDF has the line at the foot of every page");
  ok(text.some((p) => /Lösen S\. 92: 4, 5, 7/.test(p)) && text.some((p) => /Mitternachtsformel/.test(p)), "the PDF holds the plan and the formula sheet");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`${failed ? "FAIL" : "ok"} sharing: ${passed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)} s)`);
  app.exit(failed ? 1 : 0);
});

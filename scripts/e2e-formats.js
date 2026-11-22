// Material that is not a PDF, the whole way for real: in the app, in a hidden window, through
// Claude Code on this Mac (the person's own login; this costs real usage). Three exams:
//   screenshots   three screenshots of an exercise sheet (two PNG, one HEIC), dropped together:
//                 one document, read on this Mac at once and by the AI right after;
//   word          a Word worksheet with formulas in Word's own format, on two pages;
//   excel         an Excel workbook whose second sheet holds the exercises.
// For each: the strategy must cite the right page (every exercise it hands out is found on the
// page it names), a step must move the book panel to that page, and the helper must find it.
//
//   node_modules/.bin/electron scripts/e2e-formats.js <outDir> [screenshots,word,excel]
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("e2e-formats.js"));
const out = path.resolve(args[0] || "e2e-formats");
const only = new Set((args[1] || "screenshots,word,excel").split(","));
fs.mkdirSync(out, { recursive: true });
const userData = path.join(out, "data");
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
process.env.ACED_LANG = "de";
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const saved = () => JSON.parse(fs.readFileSync(path.join(userData, "aced.json"), "utf8"));

/** The sheet's pages as screenshots, two times their size, as a Retina screen takes them. */
async function screenshots(dir) {
  const page = (n, body) => `<!doctype html><meta charset="utf-8"><style>body{font:17px/1.55 -apple-system,Helvetica;margin:34px;color:#111;background:#fff}h3{margin:0 0 14px}p{margin:0 0 14px}b{margin-right:6px}</style><h3>Übungsblatt 4: Quadratische Gleichungen – Seite ${n}</h3>${body}`;
  const sheets = [
    page(1, `<p><b>1.</b> Löse <math><msup><mi>x</mi><mn>2</mn></msup><mo>−</mo><mn>7</mn><mi>x</mi><mo>+</mo><mn>12</mn><mo>=</mo><mn>0</mn></math>.</p><p><b>2.</b> Löse <math><mn>2</mn><msup><mi>x</mi><mn>2</mn></msup><mo>−</mo><mn>8</mn><mo>=</mo><mn>0</mn></math>.</p><p><b>3.</b> Vereinfache <math><mfrac><mrow><mn>6</mn><msup><mi>a</mi><mn>3</mn></msup></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math>.</p>`),
    page(2, `<p><b>4.</b> Bestimme die Diskriminante <math><mi>D</mi><mo>=</mo><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></math> von <math><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mn>2</mn><mi>x</mi><mo>+</mo><mn>5</mn><mo>=</mo><mn>0</mn></math>. Wie viele Lösungen gibt es?</p><p><b>5.</b> Löse mit der Mitternachtsformel <math><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></mrow></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math>: <math><mn>3</mn><msup><mi>x</mi><mn>2</mn></msup><mo>−</mo><mn>5</mn><mi>x</mi><mo>−</mo><mn>2</mn><mo>=</mo><mn>0</mn></math>.</p>`),
    page(3, `<p><b>6.</b> Ein Rechteck ist 3 cm länger als breit und hat die Fläche <math><mn>40</mn><mspace width="0.2em"/><msup><mtext>cm</mtext><mn>2</mn></msup></math>. Stelle eine quadratische Gleichung auf und bestimme die Seiten.</p><p><b>7.</b> Für welche Werte von <math><mi>k</mi></math> hat <math><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>k</mi><mi>x</mi><mo>+</mo><mn>9</mn><mo>=</mo><mn>0</mn></math> genau eine Lösung?</p>`),
  ];
  const win = new BrowserWindow({ show: false, width: 1500, height: 560, webPreferences: { offscreen: true } });
  const files = [];
  for (const [i, html] of sheets.entries()) {
    const source = path.join(dir, `sheet-${i + 1}.html`);
    fs.writeFileSync(source, html);
    await win.loadFile(source);
    win.webContents.setZoomFactor(2);
    await sleep(500);
    const png = path.join(dir, `Bildschirmfoto 2026-11-22 um 10.0${i}.1${i}.png`);
    fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG());
    fs.rmSync(source);
    files.push(png);
  }
  win.destroy();
  // The second one as HEIC, as a Mac set to save screenshots that way makes it.
  const heic = files[1].replace(/\.png$/, ".heic");
  require("child_process").execFileSync("/usr/bin/sips", ["-s", "format", "heic", files[1], "--out", heic], { stdio: "ignore" });
  fs.rmSync(files[1]);
  files[1] = heic;
  // Taken one after the other.
  const base = Date.now() / 1000 - 600;
  files.forEach((f, i) => fs.utimesSync(f, base + i * 30, base + i * 30));
  return files;
}

/** An Excel workbook: an overview, then the exercises on the second sheet. */
function workbook() {
  const { zipOf } = require("./fixtures/formats");
  const rows = (list) => list.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`).join("");
  const sheet = (data) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`;
  const overview = rows([["Zinsrechnung: Übersicht"], ["Thema", "Formel"], ["Jahreszins", "Z = K · p / 100"], ["Zinseszins", "K_n = K_0 · (1 + p/100)^n"], ["Die Übungen stehen auf dem Blatt «Übungen»."]]);
  const exercises = rows([
    ["Nr", "Aufgabe", "Punkte"],
    ["Ü1", "Ein Kapital von 5000 CHF wird zu 2.5 % verzinst. Wie viel Zins gibt es nach einem Jahr?", "2"],
    ["Ü2", "Welches Kapital bringt bei 3 % Zins im Jahr 450 CHF?", "2"],
    ["Ü3", "Zinseszins: 12000 CHF werden 5 Jahre zu 3.1 % angelegt. Berechne das Endkapital.", "3"],
    ["Ü4", "Nach wie vielen Jahren verdoppelt sich ein Kapital bei 4 % Zinseszins?", "3"],
  ]);
  return zipOf([
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Übersicht" sheetId="1" r:id="rId1"/><sheet name="Übungen" sheetId="2" r:id="rId2"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", sheet(overview)],
    ["xl/worksheets/sheet2.xml", sheet(exercises)],
  ]);
}

app.whenReady().then(async () => {
  const win = await window;
  const errors = [];
  win.webContents.on("console-message", (e) => (e.level === "error" || e.level === 3) && errors.push(e.message));
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(300);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector, timeout) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, timeout);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  const type = (selector, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const shot = async (name) => {
    await sleep(500);
    fs.writeFileSync(path.join(out, name + ".png"), await capture(win));
  };
  /** Drops files on the drop area the way a person does (a real drag, through Chromium). */
  const dropFiles = async (paths) => {
    const [x, y] = await js(`(() => { const r = document.querySelector('.drop').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    win.webContents.debugger.attach("1.3");
    for (const kind of ["dragEnter", "dragOver", "drop"]) {
      await win.webContents.debugger.sendCommand("Input.dispatchDragEvent", { type: kind, x, y, data: { items: [], files: paths, dragOperationsMask: 1 } });
    }
    win.webContents.debugger.detach();
  };
  const textOf = (hash) => JSON.parse(fs.readFileSync(path.join(userData, "texts", hash + ".json"), "utf8"));
  const results = [];

  async function exam({ key, name, objectives, add, expectPage, ask, materials = 1 }) {
    const t0 = Date.now();
    const date = new Date(Date.now() + 5 * 864e5).toLocaleDateString("sv");
    const created = await js(`window.aced.createExam({ name: ${JSON.stringify(name)}, date: ${JSON.stringify(date)}, time: { mode: 'perDay', minutes: 30 }, scale: 'ch', target: 5, pace: 'thorough' })`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(500);
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`!!document.querySelector('.drop')`);
    await add();
    await until(`document.querySelectorAll('.materials li').length === ${materials}`, 300000);
    const mine = () => saved().exams.find((e) => e.id === created.id);
    const m = mine().materials[0];
    log(`${key}: added "${m.title}" | ${m.pages} pages | from ${m.from} | ${m.chars} characters${m.recognised ? " | recognised on this Mac" : ""}`);
    // Pictures: the AI reads them right after; the row says so.
    if (m.from === "pictures") {
      const local = textOf(m.hash).pages;
      log(`${key}: text recognised on this Mac, page 1:\n${local[0]}`);
      await until(`/gelesen von|read by|Mac erkannt/.test(document.querySelector('.materials li span')?.textContent || '') && !document.querySelector('.materials .spinner')`, 600000);
      log(`${key}: row says: ${await js(`document.querySelector('.materials li span').textContent.trim()`)}`);
      const read = textOf(m.hash);
      log(`${key}: read by ${read.reader === "ai" ? read.model : "this Mac only"} in ${((Date.now() - t0) / 1000).toFixed(0)} s, page 1:\n${read.pages[0]}`);
      results.push({ key, check: "pictures read by the AI", ok: read.reader === "ai" });
      await shot(`${key}-material`);
    }
    await click("#paste");
    await type(".paste textarea", objectives);
    await click("#addObjectives");
    await until(`document.querySelectorAll('.materials li').length === ${materials + 1}`);
    // The strategy, with its formula sheet.
    await click("#workOut");
    await until(`!!document.querySelector('#startAnalysis') || !!document.querySelector('.estimate .cc-state')`, 120000);
    let t1 = Date.now();
    await click("#startAnalysis");
    await until(`!!document.querySelector('.path .step') || !!document.querySelector('.analysis .problem-box')`, 900000);
    const s = mine().strategy;
    if (!s) throw new Error(`${key}: no strategy: ` + (await js(`document.querySelector('.analysis')?.innerText`)));
    log(`${key}: strategy in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
    const steps = s.topics.flatMap((t) => t.steps);
    for (const t of s.topics) log(`   ${t.title} | ${t.steps.map((st) => (st.kind === "read" ? `read p.${st.from}-${st.to}` : st.kind === "solve" ? `solve p.${st.page}: ${st.labels.join(", ")}${st.unconfirmed.length ? ` (not found: ${st.unconfirmed.join(", ")})` : ""}` : "questions")).join("; ")}`);
    const solves = steps.filter((st) => st.kind === "solve");
    const confirmed = solves.length > 0 && solves.every((st) => !st.unconfirmed.length);
    const onPage = solves.find((st) => st.page === expectPage);
    results.push({ key, check: "every exercise found on the page cited", ok: confirmed });
    results.push({ key, check: `an exercise on page ${expectPage} handed out`, ok: Boolean(onPage) });
    // The step moves the book to its page.
    await until(`!!document.querySelector('.path .step')`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 120000);
    if (onPage) {
      const index = await js(`[...document.querySelectorAll('.path .step')].findIndex((li) => /S\\.\\s*${expectPage}\\b|p\\.\\s*${expectPage}\\b/.test(li.querySelector('.jump')?.textContent || ''))`);
      if (index >= 0) {
        await js(`document.querySelectorAll('.path .step')[${index}].querySelector('.jump').click()`);
        await until(`document.querySelector('.book-page')?.dataset.page === '${expectPage}' && document.querySelector('.book-page')?.dataset.state === 'shown'`, 60000);
      }
      const at = await js(`document.querySelector('.book-page').dataset.page`);
      log(`${key}: the step on page ${expectPage} moved the book to page ${at}`);
      results.push({ key, check: "the step moves the book panel to its page", ok: at === String(expectPage) });
    }
    await shot(`${key}-exam`);
    // The helper finds it.
    await click("#helperToggle");
    t1 = Date.now();
    await type(".drawer .ask input", ask);
    await click(".drawer .ask .btn");
    await until(`!!document.querySelector('.drawer .answered') || !!document.querySelector('.drawer .problem-box')`, 300000);
    const answer = (await js(`document.querySelector('.drawer .turn').innerText`)).replace(/\n+/g, " | ");
    log(`${key}: helper in ${((Date.now() - t1) / 1000).toFixed(0)} s: ${answer.slice(0, 500)}`);
    const links = await js(`[...document.querySelectorAll('.drawer .page-link')].map((b) => b.textContent)`);
    const link = await js(`[...document.querySelectorAll('.drawer .page-link')].findIndex((b) => /\\b${expectPage}\\b/.test(b.textContent))`);
    if (link >= 0) {
      await js(`document.querySelectorAll('.drawer .page-link')[${link}].click()`);
      await until(`document.querySelector('.book-page')?.dataset.page === '${expectPage}'`, 60000);
    }
    log(`${key}: the helper's page links: ${JSON.stringify(links)}`);
    results.push({ key, check: `the helper names page ${expectPage} and its link moves the book there`, ok: link >= 0 });
    await shot(`${key}-helper`);
    await click(".drawer .mini");
    log(`${key}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s | tokens ${JSON.stringify(mine().usage)}`);
  }

  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    await js(`window.aced.setSettings({ ai: { provider: 'claudeCode', model: 'claude-opus-5-5' } })`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(500);
    const fixtures = path.join(out, "files");
    fs.mkdirSync(fixtures, { recursive: true });

    if (only.has("screenshots")) {
      const shots = await screenshots(fixtures);
      await exam({
        key: "screenshots",
        name: "Quadratische Gleichungen",
        objectives: "Ich kann quadratische Gleichungen mit der Mitternachtsformel lösen.\nIch kann mit quadratischen Gleichungen Textaufgaben lösen (Flächen).",
        add: () => dropFiles(shots),
        expectPage: 3,
        ask: "Auf welcher Seite ist die Aufgabe mit dem Rechteck und der Fläche 40 cm²?",
      });
    }
    if (only.has("word")) {
      const { make } = require("./fixtures/formats");
      const fx = await make(path.join(fixtures, "word"), {});
      await exam({
        key: "word",
        name: "Arbeitsblatt 7",
        objectives: "Ich kann quadratische Gleichungen lösen.\nIch kann Textaufgaben zu Flächen lösen.\nIch kann Summenformeln anwenden.",
        add: () => dropFiles([fx["Arbeitsblatt 7.docx"]]),
        expectPage: 2,
        ask: "Wo ist die Aufgabe mit der Summenformel?",
      });
    }
    if (only.has("excel")) {
      const file = path.join(fixtures, "Zinsrechnung.xlsx");
      fs.writeFileSync(file, workbook());
      await exam({
        key: "excel",
        name: "Zinsrechnung",
        objectives: "Ich kann Jahreszinsen berechnen.\nIch kann Endkapitale mit Zinseszins berechnen.",
        add: () => dropFiles([file]),
        expectPage: 2,
        ask: "Wo finde ich die Aufgabe zum Zinseszins mit 12000 CHF?",
      });
    }
    for (const r of results) log(`${r.ok ? "ok  " : "FAIL"} ${r.key}: ${r.check}`);
    if (errors.length) log("errors in the page:", errors.slice(0, 3).join(" | "));
    process.exitCode = results.every((r) => r.ok) && !errors.length ? 0 : 1;
  } catch (e) {
    await shot("failure").catch(() => {});
    log("FAIL", e.message, errors.slice(0, 3).join(" | "));
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
});

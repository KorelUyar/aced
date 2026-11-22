// Pictures of learning in the app (0.6), on the sample exams, in a hidden window at 2x:
//
//   node_modules/.bin/electron scripts/shots-learn.js <outDir> <light|dark> [en|de]
//
// A topic with its summary at the top, the plan in "efficient" (the summary, the tasks, the
// check: no reading), and one of the book's exercises in the app before and after "Show solution".
const { app, nativeTheme } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const [outArg, theme = "dark", lang = "en"] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("shots-learn.js"));
const out = path.resolve(outArg || "learn-shots");
fs.mkdirSync(out, { recursive: true });
process.env.ACED_SAMPLE = "1";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aced-learn-shots-"));
app.setPath("userData", scratch);
fs.writeFileSync(path.join(scratch, "claude-state"), "ok");
Object.assign(process.env, { ACED_CLAUDE: path.join(__dirname, "fixtures", "claude-stub.sh"), ACED_STUB_STATE: path.join(scratch, "claude-state") });
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

/**
 * A few pages of an invented textbook, so the book beside the plan shows real pages: the
 * chapter on quadratic functions with the exercises the sample's tasks come from.
 */
async function sampleBook(file) {
  const { BrowserWindow } = require("electron");
  const pages = {
    88: ["4.2 Die Scheitelpunktform", "Jede quadratische Funktion lässt sich schreiben als f(x) = a(x − d)² + e. Der Punkt S(d | e) ist der Scheitelpunkt der Parabel.", "Ist a > 0, ist die Parabel nach oben geöffnet, ist a < 0, nach unten."],
    89: ["Quadratische Ergänzung", "Aus der Normalform f(x) = x² + px + q wird mit x² + px = (x + p/2)² − (p/2)² die Scheitelpunktform.", "Beispiel: x² − 6x + 5 = (x − 3)² − 9 + 5 = (x − 3)² − 4, also S(3 | −4)."],
    90: ["Parabeln zeichnen", "Trage zuerst den Scheitelpunkt ein. Gehe von dort 1 nach rechts und a nach oben, 2 nach rechts und 4a nach oben. Die Parabel ist symmetrisch zur Geraden x = d."],
    92: ["Aufgaben", "4  Bestimme den Scheitelpunkt der Parabel f(x) = x² − 4x + 1.", "5  Bestimme den Scheitelpunkt der Parabel f(x) = x² + 6x + 4.", "6  Bestimme den Scheitelpunkt der Parabel f(x) = −x² + 2x + 3.", "7  Bestimme den Scheitelpunkt der Parabel f(x) = 2x² − 8x + 3."],
    93: ["Aufgaben", "10  Gib die Gleichung der Parabel mit dem Scheitelpunkt S(−1 | 4) und a = 2 an.", "11  Zeichne die Parabel f(x) = (x − 1)² − 2 in ein Koordinatensystem. Wo schneidet sie die y-Achse?"],
    99: ["Aufgaben", "2  Löse die Gleichung x² − 7x + 12 = 0.", "3  Löse die Gleichung 2x² + 3x − 2 = 0.", "6  Wie viele Lösungen hat x² − 6x + 9 = 0?"],
  };
  const body = Array.from({ length: 112 }, (_, i) => {
    const n = i + 1;
    const [head, ...lines] = pages[n] || [n >= 80 ? "4 Quadratische Funktionen" : "Mathematik 1"];
    return `<section><p class="run">4 Quadratische Funktionen</p><h2>${head}</h2>${lines.map((l) => `<p>${l}</p>`).join("")}<p class="n">${n}</p></section>`;
  }).join("");
  const style = "section{break-after:page;position:relative;height:255mm;padding:6mm 4mm;font:13pt Georgia,serif;color:#1c1c1c}h2{font:600 17pt Helvetica,sans-serif;margin:10mm 0 6mm}p{margin:0 0 4mm;line-height:1.45}.run{font:9pt Helvetica,sans-serif;color:#888}.n{position:absolute;bottom:0;right:4mm;font:10pt Helvetica,sans-serif}";
  const w = new BrowserWindow({ show: false });
  await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<meta charset="utf-8"><style>${style}</style><body>${body}</body>`));
  fs.writeFileSync(file, await w.webContents.printToPDF({ pageSize: "A4" }));
  w.destroy();
}

app.whenReady().then(async () => {
  const win = await window;
  // The book beside the plan: an invented one, under its fingerprint like any book. Reading is
  // left out of "efficient", so the sample's ticks on reading are taken back for these pictures.
  const made = path.join(scratch, "book.pdf");
  await sampleBook(made);
  const hash = require("crypto").createHash("sha256").update(fs.readFileSync(made)).digest("hex");
  fs.copyFileSync(made, require("../src/files").pdfPath(hash));
  require("../src/store").change("sample-math", (e) => {
    e.materials.find((m) => m.id === "m1").hash = hash;
    delete e.done["t1/r0"];
    delete e.done["t2/r0"];
  });
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout: " + code);
  };
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const lights = `(() => { if (document.getElementById('shotChrome')) return;
    const d = document.createElement('div'); d.id = 'shotChrome';
    Object.assign(d.style, { position: 'fixed', left: '18px', top: '20px', display: 'flex', gap: '8px', zIndex: 99, pointerEvents: 'none' });
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const s = document.createElement('span');
      Object.assign(s.style, { width: '12px', height: '12px', borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 .5px rgb(0 0 0 / .18)' }); d.append(s); }
    document.body.append(d); })()`;
  const shot = async (name) => {
    await js(lights);
    await sleep(500);
    const file = path.join(out, `${name}-${lang}-${theme}.png`);
    fs.writeFileSync(file, await capture(win));
    console.log("shot", file);
  };
  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    nativeTheme.themeSource = theme;
    await js(`window.aced.setSettings({ appearance: ${JSON.stringify(theme)}, lang: ${JSON.stringify(lang)} }).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(500);
    // The plan in "efficient".
    const exam = await js(`window.aced.state().then((s) => s.exams.find((e) => e.id === 'sample-math'))`);
    await js(`window.aced.editExam('sample-math', ${JSON.stringify({ name: exam.name, date: exam.date, time: exam.time, scale: exam.scale, target: exam.target, pace: "efficient" })}).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(400);
    await js(`window.__nav({ name: 'exam', id: 'sample-math' })`);
    await until(`!!document.querySelector('.path .step')`);
    // The topic that is up shows its summary at the top.
    await until(`!!document.querySelector('.summary-card')`);
    await js(`document.querySelector('.stage.current').scrollIntoView({ block: 'start' })`);
    await shot("summary");
    // The plan: the summary card folded, so the list of steps shows.
    await click(".summary-card .mini");
    await sleep(300);
    await js(`document.querySelector('.plan').scrollTo(0, 0)`);
    await shot("efficient");
    // One of the book's exercises in the app, before and after "Show solution".
    await js(`[...document.querySelectorAll('.step .jump')].find((b) => /in (the app|der App)/.test(b.textContent)).click()`);
    await until(`!!document.querySelector('.drawer.tasks .task-prompt')`);
    await js(`(() => { const f = document.querySelector('.drawer.tasks input.field'); if (!f) return; f.value = '2; 3'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    await shot("task");
    await click("#checkTask");
    await until(`!!document.querySelector('.verdict')`);
    await click("#showSolution");
    await until(`!!document.querySelector('.task-solution')`);
    await shot("task-solution");
  } catch (err) {
    console.log("FAIL", err.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit();
  }
});

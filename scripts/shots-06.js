// Pictures of 0.6's share window and of writing in the book, in a hidden window at 2x:
//
//   node_modules/.bin/electron scripts/shots-06.js <outDir> share <light|dark> [de]
//       Aced's share window over the sample exam
//   node_modules/.bin/electron scripts/shots-06.js <outDir> ink <light|dark> [de]
//       a book page with pen, highlighter and a note: a fresh profile with a book printed here,
//       the strokes drawn with the mouse the way a person draws them
const { app, dialog, nativeTheme, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const [outArg, mode = "share", theme = "light", lang = "en"] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("shots-06.js"));
const out = path.resolve(outArg || "shots-06");
fs.mkdirSync(out, { recursive: true });
if (mode === "share") process.env.ACED_SAMPLE = "1";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aced-shots06-"));
app.setPath("userData", scratch);
fs.writeFileSync(path.join(scratch, "claude-state"), "ok");
Object.assign(process.env, { ACED_CLAUDE: path.join(__dirname, "fixtures", "claude-stub.sh"), ACED_STUB_STATE: path.join(scratch, "claude-state") });
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

/** A page of a maths book, in German like the sample exam (printed by Chromium). */
const BOOK_PAGE = (n) => `<section style="break-after:page;padding:56px 64px;font:15px/1.55 Georgia,serif;color:#1d1d1f">
  <p style="font:600 12px/1 -apple-system,sans-serif;letter-spacing:.08em;color:#8a8f98;text-transform:uppercase">Kapitel 4 · Quadratische Funktionen</p>
  <h1 style="font:700 30px/1.2 -apple-system,sans-serif;margin:14px 0 18px">4.${n} Die Scheitelpunktform</h1>
  <p>Jede quadratische Funktion lässt sich in der Form <i>f</i>(<i>x</i>) = <i>a</i>(<i>x</i> − <i>d</i>)² + <i>e</i> schreiben. Der Punkt S(<i>d</i> | <i>e</i>) ist der Scheitelpunkt der Parabel: Bei <i>a</i> &gt; 0 ist er ihr tiefster Punkt, bei <i>a</i> &lt; 0 ihr höchster.</p>
  <p style="margin-top:12px">Aus der allgemeinen Form <i>f</i>(<i>x</i>) = <i>ax</i>² + <i>bx</i> + <i>c</i> erhält man die Scheitelpunktform durch quadratische Ergänzung. Dabei wird der Term so umgeformt, dass ein Binom entsteht.</p>
  <div style="margin:22px 0;padding:16px 20px;border-left:4px solid #2a6df4;background:#f2f6fe;font:17px/1.5 Georgia,serif">
    <b style="font:700 13px/1 -apple-system,sans-serif;color:#2a6df4">MERKE</b><br>
    Scheitelpunkt: <i>d</i> = −<i>b</i> / (2<i>a</i>), &nbsp; <i>e</i> = <i>f</i>(<i>d</i>)
  </div>
  <p>Beispiel: <i>f</i>(<i>x</i>) = 2<i>x</i>² − 8<i>x</i> + 6 = 2(<i>x</i>² − 4<i>x</i>) + 6 = 2(<i>x</i> − 2)² − 2. Der Scheitelpunkt ist S(2 | −2), die Parabel ist nach oben geöffnet und doppelt so steil wie die Normalparabel.</p>
  <h2 style="font:700 19px/1.3 -apple-system,sans-serif;margin:26px 0 10px">Aufgaben</h2>
  <p><b>4</b> &nbsp; Bestimme den Scheitelpunkt von <i>f</i>(<i>x</i>) = <i>x</i>² + 6<i>x</i> + 5.</p>
  <p><b>5</b> &nbsp; Schreibe <i>g</i>(<i>x</i>) = −3<i>x</i>² + 12<i>x</i> − 7 in der Scheitelpunktform.</p>
  <p><b>6</b> &nbsp; Eine Parabel hat den Scheitelpunkt S(−1 | 4) und geht durch P(1 | 0). Bestimme ihre Gleichung.</p>
  <p><b>7</b> &nbsp; Für welche Werte von <i>c</i> hat <i>h</i>(<i>x</i>) = <i>x</i>² − 4<i>x</i> + <i>c</i> keine Nullstelle?</p>
</section>`;

app.whenReady().then(async () => {
  const win = await window;
  win.setContentSize(1360 * SCALE, 860 * SCALE);
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout: " + code);
  };
  const click = async (selector) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  const lights = `(() => { if (document.getElementById('shotChrome')) return;
    const d = document.createElement('div'); d.id = 'shotChrome';
    Object.assign(d.style, { position: 'fixed', left: '18px', top: '20px', display: 'flex', gap: '8px', zIndex: 99, pointerEvents: 'none' });
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const s = document.createElement('span');
      Object.assign(s.style, { width: '12px', height: '12px', borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 .5px rgb(0 0 0 / .18)' }); d.append(s); }
    document.body.append(d); })()`;
  const shot = async (name) => {
    await js(lights);
    await sleep(500);
    const file = path.join(out, `${name}-${theme}${lang === "de" ? "-de" : ""}.png`);
    fs.writeFileSync(file, await capture(win));
    console.log("shot", file);
  };
  /** A line drawn with the mouse, through `points` given in CSS pixels of the window. */
  const drag = async (points) => {
    // (input comes in the window's own pixels: CSS pixels times the zoom)
    const send = (type, [x, y], buttons = 1) => win.webContents.sendInputEvent({ type, x: Math.round(x * SCALE), y: Math.round(y * SCALE), button: "left", clickCount: 1, ...(type === "mouseMove" ? { buttons } : {}) });
    send("mouseMove", points[0], 0);
    send("mouseDown", points[0]);
    for (const p of points.slice(1)) {
      send("mouseMove", p);
      await sleep(8);
    }
    send("mouseUp", points[points.length - 1]);
    await sleep(120);
  };

  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    nativeTheme.themeSource = theme;
    await js(`window.aced.setSettings({ appearance: ${JSON.stringify(theme)}, lang: ${JSON.stringify(lang)} }).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(500);

    if (mode === "share") {
      await js(`window.__nav({ name: 'exam', id: 'sample-math' })`);
      await until(`!!document.querySelector('.path .step')`);
      // Without a share service (ACED_LINK_HOST set and empty): no link.
      process.env.ACED_LINK_HOST = "";
      await js(`window.__share(true)`);
      await until(`!!document.querySelector('.share-win.no-link')`);
      await sleep(400);
      await shot("share-window-nolink");
      await click(".sw-close");
      // With one (only its address matters for the picture: nothing is sent).
      process.env.ACED_LINK_HOST = "http://127.0.0.1:9";
      await js(`window.__share(true)`);
      await until(`!!document.querySelector('#share-link')`);
      await sleep(400);
      await shot("share-window");
      await click("#shareChange");
      await shot("share-window-material");
      return;
    }

    // ---- writing in the book: a fresh exam with a book printed here
    const book = path.join(scratch, "Mathematik 1.pdf");
    const printer = new BrowserWindow({ show: false });
    await printer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<meta charset="utf-8"><style>@page{size:A4;margin:0}body{margin:0}</style>${[1, 2, 3, 4].map(BOOK_PAGE).join("")}`));
    fs.writeFileSync(book, await printer.webContents.printToPDF({ pageSize: "A4", printBackground: true, margins: { marginType: "none" } }));
    printer.destroy();
    const store = require("../src/store");
    const sample = require("../src/sample").exams("de")[0];
    const created = await js(`window.aced.createExam(${JSON.stringify({ name: sample.name, date: sample.date, time: sample.time, scale: sample.scale, target: sample.target, pace: sample.pace })})`);
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(400);
    await js(`window.__nav({ name: 'setup', id: ${JSON.stringify(created.id)} })`);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] });
    await click("#chooseFiles");
    await until(`document.querySelectorAll('.materials li').length === 1`, 60000);
    const bookId = store.exam(created.id).materials[0].id;
    const strategy = structuredClone(sample.strategy);
    for (const t of strategy.topics)
      for (const st of t.steps) {
        if (!st.material) continue;
        st.material = bookId;
        if (st.kind === "read") Object.assign(st, { from: 2, to: 3 });
        if (st.kind === "solve") st.page = 2;
      }
    store.change(created.id, (e) => {
      e.strategy = strategy;
      e.formulas = sample.formulas.map((g) => ({ ...g, formulas: g.formulas.map((f) => ({ ...f, material: bookId, page: 2 })) }));
    });
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(400);
    await js(`window.__nav({ name: 'exam', id: ${JSON.stringify(created.id)} })`);
    await until(`document.querySelector('.book-page')?.dataset.state === 'shown'`, 60000);
    await sleep(500);
    await click("#inkToggle");
    // Where the page is on the screen, and where its lines are (fractions of the page).
    const rect = await js(`(() => { const r = document.querySelector('.leaf[data-page="2"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const P = (fx, fy) => [rect.x + fx * rect.w, rect.y + fy * rect.w];
    const line = (fx0, fx1, fy, wobble = 0.002, steps = 28) => Array.from({ length: steps + 1 }, (_, i) => P(fx0 + ((fx1 - fx0) * i) / steps, fy + Math.sin(i * 0.9) * wobble));
    // the highlighter over the rule in the box, yellow; then green over the example
    await click("#ink-hl");
    await drag(line(0.105, 0.6, 0.408, 0.0006));
    await js(`document.querySelectorAll('.ink-colour')[1].click()`);
    await sleep(100);
    await drag(line(0.08, 0.42, 0.484, 0.0006));
    // the pen: the title underlined in blue, exercise 5 circled in red, a tick at exercise 4
    await click("#ink-pen");
    await js(`document.querySelectorAll('.ink-colour')[1].click()`);
    await sleep(100);
    await drag(line(0.08, 0.55, 0.16, 0.0022));
    await js(`document.querySelectorAll('.ink-colour')[2].click()`);
    await sleep(100);
    const circle = Array.from({ length: 50 }, (_, i) => {
      const a = (i / 45) * Math.PI * 2 - 0.5;
      return P(0.093 + 0.03 * Math.cos(a), 0.672 + 0.022 * Math.sin(a));
    });
    await drag(circle);
    await drag([P(0.555, 0.62), P(0.562, 0.628), P(0.568, 0.634), P(0.578, 0.62), P(0.59, 0.602)]);
    // a note in the margin beside the exercises
    await click("#ink-text");
    const [nx, ny] = P(0.6, 0.548);
    win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(nx * SCALE), y: Math.round(ny * SCALE), button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(nx * SCALE), y: Math.round(ny * SCALE), button: "left", clickCount: 1 });
    await until(`document.activeElement?.classList.contains('ink-note')`);
    await js(`(() => { const el = document.activeElement; el.value = ${JSON.stringify(lang === "de" ? "Prüfung: genau so!\nd = −b / 2a merken" : "Exam: exactly like this!\nremember d = −b / 2a")}; el.dispatchEvent(new Event('input')); })()`);
    await click("#ink-pen");
    await sleep(800);
    const kept = await js(`window.aced.inkLoad(${JSON.stringify(store.exam(created.id).materials[0].hash)})`);
    console.log("kept", JSON.stringify(Object.fromEntries(Object.entries(kept).map(([n, p]) => [n, { strokes: p.s.length, notes: p.n.length }]))));
    await shot("ink-page");
  } catch (err) {
    console.log("FAIL", err.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});

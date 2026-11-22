// Pictures of sharing (0.5), on the sample exams, in a hidden window at 2x:
//
//   node_modules/.bin/electron scripts/shots-share.js <outDir> <light|dark> [friend]
//
// Without "friend": the Share dialog over the exam, the PDF of the exam (its first pages as
// pictures) and the web page at the width of a phone. With "friend": the exam as a friend sees
// it after opening the Aced file, with the book still to be added.
const { app, BrowserWindow, nativeTheme, protocol } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SCALE, quiet, hideWindowsOf, capture, sleep } = require("./hidden");

const [outArg, theme = "light", mode = ""] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("shots-share.js"));
const out = path.resolve(outArg || "share-shots");
fs.mkdirSync(out, { recursive: true });
process.env.ACED_SAMPLE = "1";
if (mode === "friend") process.env.ACED_SAMPLE_SHARED = "1";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aced-share-shots-"));
app.setPath("userData", scratch);
fs.writeFileSync(path.join(scratch, "claude-state"), "ok");
Object.assign(process.env, { ACED_CLAUDE: path.join(__dirname, "fixtures", "claude-stub.sh"), ACED_STUB_STATE: path.join(scratch, "claude-state") });
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

app.whenReady().then(async () => {
  const win = await window;
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
  const lights = `(() => { if (document.getElementById('shotChrome')) return;
    const d = document.createElement('div'); d.id = 'shotChrome';
    Object.assign(d.style, { position: 'fixed', left: '18px', top: '20px', display: 'flex', gap: '8px', zIndex: 99, pointerEvents: 'none' });
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const s = document.createElement('span');
      Object.assign(s.style, { width: '12px', height: '12px', borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 .5px rgb(0 0 0 / .18)' }); d.append(s); }
    document.body.append(d); })()`;
  const shot = async (name) => {
    await js(lights);
    await sleep(500);
    fs.writeFileSync(path.join(out, `${name}-${theme}.png`), await capture(win));
    console.log("shot", `${name}-${theme}`);
  };
  try {
    await until(`!!window.__nav && document.fonts.status === 'loaded'`);
    win.webContents.setZoomFactor(SCALE);
    nativeTheme.themeSource = theme;
    await js(`window.aced.setSettings({ appearance: ${JSON.stringify(theme)}, lang: 'en' }).then(() => window.dispatchEvent(new Event('focus')))`);
    await sleep(500);
    await js(`window.__nav({ name: 'exam', id: 'sample-math' })`);
    await until(`!!document.querySelector('.path .step')`);

    if (mode === "friend") {
      // The book panel, with the book still to be added.
      await until(`!!document.querySelector('.missing-book')`);
      await shot("share-friend");
      return;
    }

    // ---- the Share dialog
    await js(`document.querySelector('.tabs.panels button:nth-child(2)').click()`);
    await until(`!!document.querySelector('.formula')`);
    await js(`window.__share(true)`);
    await until(`!!document.querySelector('.share')`);
    await shot("share-dialog");

    if (theme !== "light") return;
    // ---- the exam as one page: printed to a PDF, and as the web page on a phone
    const store = require("../src/store");
    const { examPage } = require("../src/export");
    // In the language of the sample's own (German) content: the page's labels follow the app's language.
    const page = await examPage(store.exam("sample-math"), { lang: "de" });
    const htmlFile = path.join(out, "Mathematik Quadratische Funktionen.html");
    fs.writeFileSync(htmlFile, page);
    const pdf = path.join(out, "Mathematik Quadratische Funktionen.pdf");
    await require("../src/print").print(htmlFile, pdf, { footer: require("../src/export").footerOf("de") });
    const pics = await require("../src/convert").pagePictures(pdf, out, { longSide: 1400, first: 1, last: 2 });
    for (const p of pics) fs.renameSync(p.file, path.join(out, `share-pdf-page${p.page}.jpg`));
    console.log("pdf", pics.length, "pages shown of", fs.statSync(pdf).size, "bytes");
    for (const look of ["light", "dark"]) {
      nativeTheme.themeSource = look;
      const phone = new BrowserWindow({ show: false, width: 390 * 2, height: 1690 * 2, webPreferences: { offscreen: true, javascript: false } });
      await phone.loadFile(htmlFile);
      phone.webContents.setZoomFactor(2);
      await sleep(700);
      fs.writeFileSync(path.join(out, `share-web-phone-${look}.png`), (await phone.webContents.capturePage()).toPNG());
      phone.destroy();
      console.log("shot", `share-web-phone-${look}`);
    }
    nativeTheme.themeSource = theme;
  } catch (err) {
    console.log("FAIL", err.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});

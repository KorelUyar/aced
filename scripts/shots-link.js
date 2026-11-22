// Pictures of the page a link to a shared exam opens (service/page.html), at the width of a
// phone, in both themes and both languages: the service runs here, the sample exam is locked
// and put on it as the app does, and the page unlocks it in the browser.
//
//   node_modules/.bin/electron scripts/shots-link.js <outDir> <en|de>
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, sleep } = require("./hidden");

const [outArg, lang = "en"] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith("shots-link.js"));
const out = path.resolve(outArg || "shots-link");
// The page speaks the browser's language.
app.commandLine.appendSwitch("lang", lang === "de" ? "de-CH" : "en-GB");
fs.mkdirSync(out, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aced-shots-link-"));
app.setPath("userData", scratch);
quiet();

app.whenReady().then(async () => {
  const service = require("../service/server");
  const link = require("../src/link");
  const share = require("../src/share");
  const s = await service.start({ ...service.settings({}), port: 0, dataDir: path.join(scratch, "data") }, { quiet: true });
  try {
    const host = `http://127.0.0.1:${s.port}`;
    const exam = require("../src/sample").exams("de")[0];
    const bytes = share.pack(exam, { chosen: [], appVersion: "0.6.0", textOf: () => null, pdfOf: () => null, shareId: "11111111-2222-3333-4444-555555555555" });
    const { url } = await link.make(bytes, { host });
    const links = { exam: url, gone: `${host}/s/${"A".repeat(22)}#${url.split("#")[1]}`, broken: url.slice(0, -3) };
    // One window for all of them (a second offscreen window after the first is closed fails here).
    const win = new BrowserWindow({ show: false, width: 390, height: 1100, webPreferences: { offscreen: true } });
    {
      for (const look of ["light", "dark"]) {
        for (const [what, address] of Object.entries(links)) {
          if (what !== "exam" && (look === "dark" || lang === "de")) continue;
          nativeTheme.themeSource = look;
          await win.loadURL("about:blank");
          await win.loadURL(address);
          await sleep(900);
          const name = `link-page-${what}-${look}-${lang}.png`;
          fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
          const shown = await win.webContents.executeJavaScript(`[document.getElementById('name')?.textContent, document.getElementById('problemTitle')?.textContent, document.querySelectorAll('#topics > li').length, document.getElementById('openApp')?.getAttribute('href')]`);
          console.log("shot", name, JSON.stringify(shown));
        }
      }
    }
  } catch (err) {
    console.log("FAIL", err.message);
    process.exitCode = 1;
  } finally {
    await s.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});

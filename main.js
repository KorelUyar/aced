const { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu } = require("electron");
const path = require("path");
const brand = require("./src/brand");
const store = require("./src/store");

// `--sample` (or SPURT_SAMPLE=1) starts with invented exams kept in memory only. It is how the
// screenshots are made and how the app is shown before the real engine exists.
const SAMPLE = process.argv.includes("--sample") || process.env.SPURT_SAMPLE === "1";

let win;

const isMac = process.platform === "darwin";
const colors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#15171c", symbols: "#f3f4f7" }
    : { background: "#f4f5f7", symbols: "#14161b" };

function applyAppearance(value) {
  nativeTheme.themeSource = value === "light" || value === "dark" ? value : "system";
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 19 } }
      : { titleBarOverlay: { color: colors().background, symbolColor: colors().symbols, height: 52 } }),
    backgroundColor: colors().background,
    title: brand.name,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--spurt-name=${brand.name}`, `--spurt-sample=${SAMPLE ? 1 : 0}`],
    },
  });
  win.once("ready-to-show", () => win.show());
  nativeTheme.on("updated", () => {
    if (!win || win.isDestroyed()) return;
    const c = colors();
    win.setBackgroundColor(c.background);
    if (!isMac) win.setTitleBarOverlay({ color: c.background, symbolColor: c.symbols, height: 52 });
  });
  win.on("closed", () => app.quit());
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  // The page never leaves the app's own files.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

app.setName(brand.name);

app.whenReady().then(() => {
  if (!isMac) Menu.setApplicationMenu(null);
  // Run from the source folder, the Dock would show Electron's icon.
  if (isMac && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, "build", "icon.png"));
  store.init({ dir: app.getPath("userData"), sample: SAMPLE });
  applyAppearance(store.settings().appearance);
  createWindow();
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

// ---------------------------------------------------------------- IPC

const wrap = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

ipcMain.handle("state", wrap(() => ({ settings: store.settings(), exams: store.exams() })));
ipcMain.handle("exam:create", wrap((draft) => store.createExam(draft)));
ipcMain.handle("exam:update", wrap((id, patch) => store.updateExam(id, patch)));
ipcMain.handle(
  "settings:set",
  wrap((patch) => {
    const next = store.setSettings(patch);
    applyAppearance(next.appearance);
    return next;
  }),
);

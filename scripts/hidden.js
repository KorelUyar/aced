// Shared by the scripts that take pictures: run Electron without a visible window and without
// taking the keyboard focus (other things run on this Mac), then capture pages at 2x.
const { app, BrowserWindow } = require("electron");
const Module = require("module");

const SCALE = 2;

function quiet() {
  app.dock?.hide();
  // Keys typed in by a test stay in memory: nothing is put into the keychain.
  process.env.SPURT_KEYS = "memory";
  // The interface follows the Mac's language; a test says which one it expects.
  process.env.SPURT_LANG = process.env.SPURT_LANG || "en";
  // An error in the main process would otherwise put a dialog on the screen and wait for a click.
  process.on("uncaughtException", (err) => {
    console.log("FAIL uncaught:", err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : err);
    app.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.log("FAIL unhandled:", err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : err);
    app.exit(1);
  });
}

/** Makes every window that `file` (e.g. main.js) opens stay hidden; resolves to the first one. */
function hideWindowsOf(file) {
  let found;
  const first = new Promise((resolve) => (found = resolve));
  class Hidden extends BrowserWindow {
    constructor(options) {
      super({
        ...options,
        show: false,
        enableLargerThanScreen: true,
        paintWhenInitiallyHidden: true,
        // a hidden page must keep animating, or a capture shows a half-faded view
        webPreferences: { ...options.webPreferences, backgroundThrottling: false },
      });
      found(this);
    }
    show() {}
    focus() {}
  }
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    const loaded = load.call(this, request, parent, ...rest);
    if (request === "electron" && parent && parent.filename === file) {
      return new Proxy(loaded, { get: (target, key) => (key === "BrowserWindow" ? Hidden : target[key]) });
    }
    return loaded;
  };
  return first;
}

function hiddenWindow(width, height, webPreferences = {}, options = {}) {
  const win = new BrowserWindow({
    ...options,
    show: false,
    enableLargerThanScreen: true,
    paintWhenInitiallyHidden: true,
    useContentSize: true,
    width,
    height,
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  return win;
}

// A hidden page only draws while something is capturing it. The first capture wakes it up
// (and may still show a view fading in); the second one is the picture.
async function capture(win) {
  await win.webContents.capturePage(undefined, { stayHidden: true });
  await sleep(350);
  const image = await win.webContents.capturePage(undefined, { stayHidden: true });
  return image.toPNG();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { SCALE, quiet, hideWindowsOf, hiddenWindow, capture, sleep };

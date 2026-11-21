// Renders build/icon.svg to build/icon.png (1024) and build/icon.icns, in a hidden window:
//
//   node_modules/.bin/electron scripts/icon.js
const { app } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, hiddenWindow, sleep } = require("./hidden");

quiet();
const build = path.join(__dirname, "..", "build");

app.whenReady().then(async () => {
  const win = hiddenWindow(1024, 1024, { offscreen: true }, { transparent: true, frame: false });
  const svg = fs.readFileSync(path.join(build, "icon.svg"), "utf8");
  const page = `<body style="margin:0;background:transparent">${svg}</body>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page));
  await sleep(500);
  const image = await win.webContents.capturePage();
  const png = path.join(build, "icon.png");
  fs.writeFileSync(png, image.resize({ width: 1024, height: 1024 }).toPNG());

  if (process.platform === "darwin") {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), "aced-icon-")) + "/icon.iconset";
    fs.mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync("sips", ["-z", size, size, png, "--out", `${set}/icon_${size}x${size}.png`], { stdio: "ignore" });
      execFileSync("sips", ["-z", size * 2, size * 2, png, "--out", `${set}/icon_${size}x${size}@2x.png`], { stdio: "ignore" });
    }
    execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(build, "icon.icns")]);
  }
  console.log("wrote", png);
  app.quit();
});

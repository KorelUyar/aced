// After electron-builder: sign the app ad hoc (Apple Silicon refuses unsigned code) and zip it
// as dist/<Name>-macOS.zip, the file install.sh uses. The name comes from package.json.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { productName } = require("../package.json");

const dist = path.join(__dirname, "..", "dist");
const dir = ["mac-universal", "mac-arm64", "mac"].map((d) => path.join(dist, d)).find((d) => fs.existsSync(path.join(d, `${productName}.app`)));
if (!dir) throw new Error(`${productName}.app not found in dist/`);
const appPath = path.join(dir, `${productName}.app`);
const zip = path.join(dist, `${productName}-macOS.zip`);

execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
fs.rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zip], { stdio: "inherit" });
console.log("wrote", zip);

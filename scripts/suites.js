// Runs every suite of a group, one after the other, and reports at the end: one failure (or a flake
// of the Mac's text recognition under load) cannot hide the suites after it.
//
//   node scripts/suites.js test | smoke
const { spawnSync } = require("child_process");
const path = require("path");

const GROUPS = {
  test: ["test.js", "test-ocr.js", "test-book.js", "test-formats.js", "test-share.js", "test-link.js", "test-learn.js"],
  smoke: ["smoke.js", "smoke.js sample", "smoke.js damaged", "smoke-formats.js", "smoke-share.js", "smoke-06.js"],
};
const group = process.argv[2];
if (!GROUPS[group]) {
  console.log("usage: node scripts/suites.js " + Object.keys(GROUPS).join(" | "));
  process.exit(2);
}
const electron = require("electron");
const failed = [];
for (const suite of GROUPS[group]) {
  const [file, ...args] = suite.split(" ");
  const r = spawnSync(electron, [path.join(__dirname, file), ...args], { stdio: "inherit", cwd: path.join(__dirname, "..") });
  if (r.status !== 0) failed.push(suite);
}
console.log(failed.length ? `FAIL ${group}: ${failed.join(", ")}` : `ok ${group}: all ${GROUPS[group].length} suites`);
process.exit(failed.length ? 1 : 0);

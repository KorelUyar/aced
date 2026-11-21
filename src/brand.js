// The app's name lives in package.json ("productName") and nowhere else. The main process reads
// it here, the interface gets it through the preload, the build scripts read package.json.
const pkg = require("../package.json");

module.exports = { name: pkg.productName, version: pkg.version };

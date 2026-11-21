// The app used to be called Spurt. What a person had in Spurt is moved into this app's own
// folder the first time it starts: exams, ticks, books, the text read from them, kept answers
// and backups. Nothing is deleted on the way, and a move that is cut short (the app is quit,
// the Mac loses power) is simply carried on at the next start: the data file goes last, and
// as long as it is not here, the move is not done.
const fs = require("fs");
const path = require("path");

const OLD_DATA = "spurt.json";
const DATA = "aced.json";

/** Moves one file, also across disks. Something that is already at its place is left alone. */
function carry(from, to) {
  if (fs.existsSync(to)) return;
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to + ".part");
    fs.renameSync(to + ".part", to);
  }
}

/**
 * `dir`: this app's folder. `oldDir`: the folder Spurt kept its data in (or null).
 * Returns null when there was nothing to do, else { exams: true, keys } where `keys` says
 * that Spurt had saved keys. Those cannot come along: macOS keeps the secret they are locked
 * with under the old app's name, so the person enters them once more.
 */
function fromSpurt(dir, oldDir) {
  if (fs.existsSync(path.join(dir, DATA))) return null;
  fs.mkdirSync(dir, { recursive: true });
  // A folder that already holds Spurt's file under its old name (the same folder, renamed by hand, or a test profile).
  const source = fs.existsSync(path.join(dir, OLD_DATA)) ? dir : oldDir && fs.existsSync(path.join(oldDir, OLD_DATA)) ? oldDir : null;
  if (!source) return null;
  if (source !== dir) {
    for (const folder of ["library", "texts", "answers"]) {
      const from = path.join(source, folder);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (const name of fs.readdirSync(from)) carry(path.join(from, name), path.join(dir, folder, name));
    }
  }
  for (const name of fs.readdirSync(source)) {
    if (/^spurt\.backup(\.\d)?\.json$/.test(name)) fs.copyFileSync(path.join(source, name), path.join(dir, name.replace(/^spurt/, "aced")));
  }
  const keys = fs.existsSync(path.join(source, "keys.bin")) && fs.statSync(path.join(source, "keys.bin")).size > 0;
  // The data file last, whole or not at all.
  fs.copyFileSync(path.join(source, OLD_DATA), path.join(dir, DATA + ".part"));
  fs.renameSync(path.join(dir, DATA + ".part"), path.join(dir, DATA));
  // Spurt's own file gets another name, so an old copy of Spurt would start empty instead of
  // showing exams whose books are gone. It is not deleted.
  try {
    fs.renameSync(path.join(source, OLD_DATA), path.join(source, "spurt.moved-to-aced.json"));
  } catch {
    // it stays where it is
  }
  return { exams: true, keys };
}

module.exports = { fromSpurt };

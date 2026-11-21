// Finds the pages of the person's books that a question is about. Runs here, on the text read
// from the files: the model is then given those pages only, not the whole book.

const STOP = new Set(
  ("the a an and or of to in on for with is are was be it this that these those what which where how do does can i my me you your we at by from as not " +
    "der die das den dem des ein eine einen einem einer und oder zu zum zur im in auf fuer mit ist sind war es ich mein meine du dein wir wo wie was welche welcher " +
    "kann nicht von bei aus als auch noch nach ueber unter find finde finden gibt give there page pages seite seiten").split(" "),
);

/** Words as they are compared: lower case, no accents, long words cut to their first letters so "Aufgaben" finds "Aufgabe". */
function words(text) {
  const out = [];
  const plain = String(text).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const w of plain.match(/[a-z0-9]+/g) || []) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w.length > 6 ? w.slice(0, 6) : w);
  }
  return out;
}

const indexes = new Map(); // hash of a file -> its pages as word counts

function indexOf(hash, pages) {
  if (indexes.has(hash)) return indexes.get(hash);
  const df = new Map();
  const docs = pages.map((text) => {
    const tf = new Map();
    const list = words(text);
    for (const w of list) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return { tf, length: list.length };
  });
  const index = { docs, df, average: docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1) || 1 };
  indexes.set(hash, index);
  if (indexes.size > 12) indexes.delete(indexes.keys().next().value);
  return index;
}

/**
 * `sources`: [{ n, hash, pages: [text] }]. Returns the best pages for the question, best first:
 * [{ n, page, score }] (page numbers start at 1). BM25, the usual ranking for this.
 */
function rank(sources, question, limit = 10) {
  const query = [...new Set(words(question))];
  if (!query.length) return [];
  const hits = [];
  for (const s of sources) {
    const { docs, df, average } = indexOf(s.hash, s.pages);
    docs.forEach((d, i) => {
      if (!d.length) return;
      let score = 0;
      for (const w of query) {
        const f = d.tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (docs.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / average));
      }
      if (score > 0) hits.push({ n: s.n, page: i + 1, score });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { rank, words };

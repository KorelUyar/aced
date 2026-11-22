// A small XML reader for the parts of office files and e-books. It reads elements, attributes,
// text and CDATA, and resolves namespaces. It never reads a DOCTYPE: entity declarations in
// one, internal or external, are skipped whole, and an entity it does not know (anything but
// &lt; &gt; &amp; &quot; &apos; and numbers) stays in the text as it was written. So an
// "external entity" can never pull in a file or an address, and a "billion laughs" expands to
// nothing.

const coded = (code) => Object.assign(new Error(code), { code });

const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text) {
  if (text.indexOf("&") < 0) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (whole, ref) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : whole;
  });
}

/** Skips "<!...>" from `at`, with any "[...]" inside it and quoted strings. Returns where it ends. */
function skipDeclaration(src, at) {
  let depth = 0;
  let quote = null;
  for (let i = at + 2; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return i + 1;
  }
  return src.length;
}

const NAME_END = /[\s/>]/;
const SPACE_OR_END = /[\s>]/g;

/** Where the next space or ">" is at or after `from` (or -1), without copying the text. */
function stopAt(src, from) {
  SPACE_OR_END.lastIndex = from;
  const m = SPACE_OR_END.exec(src);
  return m ? m.index : -1;
}

/**
 * Parses XML text into elements: { name, local, prefix, ns, attrs, children }. Children are
 * elements and strings. `most` caps the number of elements (a huge part is refused, not read).
 */
function parse(src, { most = 4000000 } = {}) {
  const root = { name: "#root", local: "#root", prefix: "", ns: "", attrs: {}, children: [], spaces: {} };
  const stack = [root];
  let count = 0;
  let i = 0;
  const n = src.length;
  const add = (text) => {
    if (!text) return;
    const kids = stack[stack.length - 1].children;
    if (typeof kids[kids.length - 1] === "string") kids[kids.length - 1] += text;
    else kids.push(text);
  };
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      add(decode(src.slice(i)));
      break;
    }
    if (lt > i) add(decode(src.slice(i, lt)));
    const next = src[lt + 1];
    if (next === "!") {
      if (src.startsWith("<!--", lt)) {
        const end = src.indexOf("-->", lt + 4);
        i = end < 0 ? n : end + 3;
      } else if (src.startsWith("<![CDATA[", lt)) {
        const end = src.indexOf("]]>", lt + 9);
        add(src.slice(lt + 9, end < 0 ? n : end));
        i = end < 0 ? n : end + 3;
      } else {
        // <!DOCTYPE ...> and anything like it: never interpreted.
        i = skipDeclaration(src, lt);
      }
      continue;
    }
    if (next === "?") {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (next === "/") {
      const end = src.indexOf(">", lt);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim();
      // Closes the nearest open element of that name (a stray end tag is ignored).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    // A start tag: its name, then attributes until ">" or "/>" (a ">" inside quotes does not end it).
    let p = lt + 1;
    while (p < n && !NAME_END.test(src[p])) p++;
    const name = src.slice(lt + 1, p);
    if (!name) {
      add("<");
      i = lt + 1;
      continue;
    }
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      while (p < n && /\s/.test(src[p])) p++;
      if (p >= n) break;
      if (src[p] === ">") {
        p++;
        break;
      }
      if (src[p] === "/" && src[p + 1] === ">") {
        selfClosing = true;
        p += 2;
        break;
      }
      const eq = src.indexOf("=", p);
      const stop = stopAt(src, p);
      if (eq < 0 || (stop >= 0 && stop < eq)) {
        // An attribute without a value (not XML, but harmless): taken as empty.
        const end = stop < 0 ? n : stop;
        if (end === p) {
          p++;
          continue;
        }
        attrs[src.slice(p, end)] = "";
        p = end;
        continue;
      }
      const key = src.slice(p, eq).trim();
      p = eq + 1;
      while (p < n && /\s/.test(src[p])) p++;
      const quote = src[p];
      let value;
      if (quote === '"' || quote === "'") {
        const end = src.indexOf(quote, p + 1);
        value = src.slice(p + 1, end < 0 ? n : end);
        p = end < 0 ? n : end + 1;
      } else {
        const end = stopAt(src, p);
        value = src.slice(p, end < 0 ? n : end);
        p = end < 0 ? n : end;
      }
      if (key) attrs[key] = decode(value);
    }
    if (++count > most) throw coded("tooLarge");
    const parent = stack[stack.length - 1];
    // Namespaces: what this element declares, on top of what it inherits.
    let spaces = parent.spaces;
    for (const key in attrs) {
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        if (spaces === parent.spaces) spaces = { ...parent.spaces };
        spaces[key === "xmlns" ? "" : key.slice(6)] = attrs[key];
      }
    }
    const colon = name.indexOf(":");
    const prefix = colon > 0 ? name.slice(0, colon) : "";
    const el = { name, local: colon > 0 ? name.slice(colon + 1) : name, prefix, ns: spaces[prefix] || "", attrs, children: [], spaces };
    parent.children.push(el);
    if (!selfClosing) stack.push(el);
    i = p;
  }
  const top = root.children.find((c) => typeof c !== "string");
  if (!top) throw coded("damaged");
  return top;
}

// ------------------------------------------------------------ reading the tree

const isEl = (x) => x && typeof x === "object";

/** Element children, all or those with this local name (or one of these). */
function kids(node, local) {
  if (!node) return [];
  const want = Array.isArray(local) ? local : local ? [local] : null;
  return node.children.filter((c) => isEl(c) && (!want || want.includes(c.local)));
}
const kid = (node, local) => (node ? node.children.find((c) => isEl(c) && c.local === local) : undefined);

/** An attribute by its local name ("val" finds "w:val"), or undefined. */
function attr(node, local) {
  if (!node) return undefined;
  if (Object.prototype.hasOwnProperty.call(node.attrs, local)) return node.attrs[local];
  for (const key in node.attrs) {
    const colon = key.indexOf(":");
    if (colon > 0 && key.slice(colon + 1) === local && key.slice(0, colon) !== "xmlns") return node.attrs[key];
  }
  return undefined;
}

/** Every descendant element with this local name, in document order. */
function all(node, local, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (!isEl(c)) continue;
    if (c.local === local) out.push(c);
    all(c, local, out);
  }
  return out;
}
const first = (node, local) => {
  if (!node) return undefined;
  for (const c of node.children) {
    if (!isEl(c)) continue;
    if (c.local === local) return c;
    const found = first(c, local);
    if (found) return found;
  }
  return undefined;
};

/** All text below a node, joined. */
function text(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  let out = "";
  for (const c of node.children) out += typeof c === "string" ? c : text(c);
  return out;
}

module.exports = { parse, decode, kids, kid, attr, all, first, text, isEl };

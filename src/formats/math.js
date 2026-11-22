// Formulas. Word keeps them in its own format (OMML), OpenDocument and web pages as MathML.
// Either way they become two things here: MathML, which the page draws as a formula, and LaTeX,
// which goes into the text the AI reads. The page carries the LaTeX invisibly beside the
// formula (see `marked`), so the AI reads "$x^{2}-5x+6=0$", not the formula's letters in pieces.
const X = require("./xml");

// ------------------------------------------------------------ a formula as a small tree

const el = (t, c = [], a = {}) => ({ t, c: c.filter(Boolean), a });
const row = (c) => (c.length === 1 ? c[0] : el("mrow", c));

const GREEK = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "varepsilon", ϵ: "epsilon", ζ: "zeta", η: "eta", θ: "theta", ϑ: "vartheta", ι: "iota", κ: "kappa", λ: "lambda",
  μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", ϱ: "varrho", σ: "sigma", ς: "varsigma", τ: "tau", υ: "upsilon", φ: "varphi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
  Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Υ: "Upsilon", Φ: "Phi", Ψ: "Psi", Ω: "Omega",
};
const SYMBOLS = {
  "−": "-", "±": "\\pm ", "∓": "\\mp ", "×": "\\times ", "·": "\\cdot ", "⋅": "\\cdot ", "÷": "\\div ", "∗": "*", "≤": "\\le ", "≥": "\\ge ", "≠": "\\neq ", "≈": "\\approx ",
  "≡": "\\equiv ", "∼": "\\sim ", "≅": "\\cong ", "∝": "\\propto ", "∞": "\\infty ", "→": "\\to ", "←": "\\leftarrow ", "↔": "\\leftrightarrow ", "⇒": "\\Rightarrow ",
  "⇐": "\\Leftarrow ", "⇔": "\\Leftrightarrow ", "∈": "\\in ", "∉": "\\notin ", "⊂": "\\subset ", "⊆": "\\subseteq ", "⊃": "\\supset ", "⊇": "\\supseteq ",
  "∪": "\\cup ", "∩": "\\cap ", "∅": "\\emptyset ", "∀": "\\forall ", "∃": "\\exists ", "¬": "\\neg ", "∧": "\\wedge ", "∨": "\\vee ", "∑": "\\sum ", "∏": "\\prod ",
  "∫": "\\int ", "∬": "\\iint ", "∭": "\\iiint ", "∮": "\\oint ", "∂": "\\partial ", "∇": "\\nabla ", "∆": "\\Delta ", "°": "^{\\circ}", "′": "'", "″": "''", "…": "\\ldots ",
  "⋯": "\\cdots ", "⋮": "\\vdots ", "∠": "\\angle ", "⊥": "\\perp ", "∥": "\\parallel ", "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}",
  "ℂ": "\\mathbb{C}", "√": "\\surd ", "⁡": "", "⁢": "", "⁣": "", "⁤": "", " ": " ", "%": "\\%", "#": "\\#", "&": "\\&", $: "\\$", "{": "\\{", "}": "\\}", "_": "\\_",
};
const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "max", "min", "sup", "inf", "det", "gcd", "deg", "dim", "ker", "arg", "mod"]);
const ACCENTS = { "̂": "hat", "^": "hat", ˆ: "hat", "̃": "tilde", "~": "tilde", "˜": "tilde", "̄": "overline", "¯": "overline", "‾": "overline", "→": "vec", "⃗": "vec", "̇": "dot", "˙": "dot", "̈": "ddot", "¨": "ddot", "̌": "check", ˇ: "check", "̆": "breve", "˘": "breve" };

// ------------------------------------------------------------ OMML (Word) to the tree

const tokens = (text, plain) => {
  if (plain && /[A-Za-zÀ-ÿ]{2,}/.test(text)) return [el("mi", [text], { mathvariant: "normal" })];
  const out = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*|\p{L}|\s+|./gu)) {
    const s = m[0];
    if (/^\s+$/.test(s)) continue;
    if (/^\d/.test(s)) out.push(el("mn", [s]));
    else if (/^\p{L}$/u.test(s)) out.push(el("mi", [s], plain ? { mathvariant: "normal" } : {}));
    else out.push(el("mo", [s]));
  }
  return out;
};

const val = (node, name) => {
  const k = X.kid(node, name);
  return k ? X.attr(k, "val") : undefined;
};
const props = (node, name) => X.kid(node, name) || null;

function omml(node) {
  const arg = (name) => row(X.kids(X.kid(node, name)).flatMap(omml));
  switch (node.local) {
    case "oMathPara":
    case "oMath":
    case "e":
    case "num":
    case "den":
    case "sub":
    case "sup":
    case "deg":
    case "lim":
    case "fName":
      return X.kids(node).flatMap(omml);
    case "r": {
      const rPr = props(node, "rPr");
      const plain = Boolean(X.kid(rPr, "nor")) || ["p", "b"].includes(val(rPr, "sty"));
      return X.kids(node, "t").flatMap((t) => tokens(X.text(t), plain));
    }
    case "f": {
      const type = val(props(node, "fPr"), "type");
      if (type === "lin") return [el("mrow", [arg("num"), el("mo", ["/"]), arg("den")])];
      return [el("mfrac", [arg("num"), arg("den")], type === "noBar" ? { linethickness: "0" } : {})];
    }
    case "sSup":
      return [el("msup", [arg("e"), arg("sup")])];
    case "sSub":
      return [el("msub", [arg("e"), arg("sub")])];
    case "sSubSup":
      return [el("msubsup", [arg("e"), arg("sub"), arg("sup")])];
    case "sPre":
      return [el("msubsup", [el("mrow"), arg("sub"), arg("sup")]), arg("e")];
    case "rad": {
      const hide = ["1", "on", "true"].includes(val(props(node, "radPr"), "degHide"));
      const deg = X.kids(X.kid(node, "deg"));
      return [hide || !deg.length ? el("msqrt", [arg("e")]) : el("mroot", [arg("e"), arg("deg")])];
    }
    case "d": {
      const pr = props(node, "dPr");
      const open = val(pr, "begChr") ?? "(";
      const close = val(pr, "endChr") ?? ")";
      const sep = val(pr, "sepChr") ?? "|";
      const parts = [];
      X.kids(node, "e").forEach((e, i) => {
        if (i) parts.push(el("mo", [sep]));
        parts.push(row(X.kids(e).flatMap(omml)));
      });
      return [el("mrow", [open && el("mo", [open], { fence: "true" }), ...parts, close && el("mo", [close], { fence: "true" })])];
    }
    case "nary": {
      const pr = props(node, "naryPr");
      const chr = val(pr, "chr") ?? "∫";
      const under = val(pr, "limLoc") === "undOvr" || (val(pr, "limLoc") === undefined && /[∑∏∐⋃⋂]/.test(chr));
      const on = (v) => v === undefined || !["1", "on", "true"].includes(v);
      const sub = on(val(pr, "subHide")) && X.kids(X.kid(node, "sub")).length ? arg("sub") : null;
      const sup = on(val(pr, "supHide")) && X.kids(X.kid(node, "sup")).length ? arg("sup") : null;
      const op = el("mo", [chr], { largeop: "true" });
      const base = sub && sup ? el(under ? "munderover" : "msubsup", [op, sub, sup]) : sub ? el(under ? "munder" : "msub", [op, sub]) : sup ? el(under ? "mover" : "msup", [op, sup]) : op;
      return [base, arg("e")];
    }
    case "func":
      return [el("mrow", [arg("fName"), el("mo", ["⁡"]), arg("e")])];
    case "limLow":
      return [el("munder", [arg("e"), arg("lim")])];
    case "limUpp":
      return [el("mover", [arg("e"), arg("lim")])];
    case "acc":
      return [el("mover", [arg("e"), el("mo", [val(props(node, "accPr"), "chr") ?? "̂"])], { accent: "true" })];
    case "bar":
      return val(props(node, "barPr"), "pos") === "top" ? [el("mover", [arg("e"), el("mo", ["¯"])], { accent: "true" })] : [el("munder", [arg("e"), el("mo", ["_"])])];
    case "groupChr": {
      const pr = props(node, "groupChrPr");
      const chr = val(pr, "chr") ?? "⏟";
      return [el(val(pr, "pos") === "top" ? "mover" : "munder", [arg("e"), el("mo", [chr])])];
    }
    case "eqArr":
      return [el("mtable", X.kids(node, "e").map((e) => el("mtr", [el("mtd", [row(X.kids(e).flatMap(omml))])])), { columnalign: "left" })];
    case "m":
      return [el("mtable", X.kids(node, "mr").map((r) => el("mtr", X.kids(r, "e").map((e) => el("mtd", [row(X.kids(e).flatMap(omml))])))))];
    case "box":
    case "borderBox":
      return [arg("e")];
    case "phant":
      return [];
    default:
      // Properties (…Pr) and anything unknown: only what is inside it counts.
      if (node.local.endsWith("Pr") || node.local === "ctrlPr") return [];
      return X.kids(node).flatMap(omml);
  }
}

/** A Word formula (m:oMath or m:oMathPara) as the tree. */
const fromOmml = (node) => el("math", omml(node), node.local === "oMathPara" ? { display: "block" } : {});

// ------------------------------------------------------------ MathML (OpenDocument, web pages) to the tree

const MATHML = new Set(["math", "mrow", "mi", "mn", "mo", "mtext", "ms", "mspace", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "munder", "mover", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "menclose", "mfenced", "mmultiscripts", "mprescripts", "none", "semantics", "mphantom", "merror", "mlabeledtr"]);
const KEEP = ["mathvariant", "display", "linethickness", "accent", "accentunder", "stretchy", "fence", "separator", "largeop", "form", "columnalign", "open", "close", "separators", "notation"];

function fromMathml(node) {
  if (typeof node === "string") return node;
  const name = node.local;
  if (name === "semantics") {
    const shown = X.kids(node).find((k) => !/^annotation/.test(k.local));
    return shown ? fromMathml(shown) : null;
  }
  if (name === "mphantom" || /^annotation/.test(name)) return null;
  const children = node.children.map(fromMathml).filter((c) => c !== null && c !== undefined && !(typeof c === "string" && !c.trim() && !/^(mi|mn|mo|mtext|ms)$/.test(name)));
  if (name === "mfenced") {
    // Not drawn by browsers any more: brackets and separators as plain operators.
    const open = X.attr(node, "open") ?? "(";
    const close = X.attr(node, "close") ?? ")";
    const seps = (X.attr(node, "separators") ?? ",").replace(/\s/g, "");
    const parts = [];
    children.forEach((c, i) => {
      if (i && seps) parts.push(el("mo", [seps[Math.min(i - 1, seps.length - 1)]]));
      parts.push(c);
    });
    return el("mrow", [open && el("mo", [open], { fence: "true" }), ...parts, close && el("mo", [close], { fence: "true" })]);
  }
  const a = {};
  for (const k of KEEP) if (X.attr(node, k) !== undefined) a[k] = X.attr(node, k);
  return el(MATHML.has(name) ? name : "mrow", children, a);
}

// ------------------------------------------------------------ the tree as MathML and as LaTeX

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function toMathml(node) {
  if (typeof node === "string") return esc(node);
  const attrs = Object.entries(node.a || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<${node.t}${attrs}>${node.c.map(toMathml).join("")}</${node.t}>`;
}

const plainText = (node) => (typeof node === "string" ? node : node.c.map(plainText).join(""));
const symbol = (s) =>
  [...s].map((ch) => (GREEK[ch] ? `\\${GREEK[ch]} ` : SYMBOLS[ch] !== undefined ? SYMBOLS[ch] : ch)).join("");
const group = (s) => (s.length === 1 ? s : `{${s}}`);
const BIG = /^\\(sum|prod|int|iint|iiint|oint|lim|max|min|sup|inf)\b/;

function latex(node) {
  if (typeof node === "string") return symbol(node);
  const c = node.c;
  const L = (i) => (c[i] === undefined ? "" : latex(c[i]).trim());
  switch (node.t) {
    case "math":
    case "mrow":
    case "mstyle":
    case "mpadded":
    case "menclose":
    case "merror":
      return c.map(latex).join("");
    case "mi": {
      const s = plainText(node).trim();
      if (FUNCTIONS.has(s)) return `\\${s} `;
      if (s.length > 1 && /^[A-Za-z]+$/.test(s)) return node.a.mathvariant === "normal" ? `\\mathrm{${s}}` : s;
      return symbol(s);
    }
    case "mn":
      return plainText(node).trim();
    case "mo": {
      const s = plainText(node).trim();
      return s === "⁡" ? "" : symbol(s);
    }
    case "mtext":
    case "ms": {
      const s = plainText(node);
      return s.trim() ? `\\text{${s.replace(/[{}\\]/g, "")}}` : " ";
    }
    case "mspace":
      return " ";
    case "msup":
      return `${group(L(0))}^${group(L(1))}`;
    case "msub":
      return `${group(L(0))}_${group(L(1))}`;
    case "msubsup":
      return `${group(L(0))}_${group(L(1))}^${group(L(2))}`;
    case "mfrac":
      return node.a.linethickness === "0" ? `\\binom{${L(0)}}{${L(1)}}` : `\\frac{${L(0)}}{${L(1)}}`;
    case "msqrt":
      return `\\sqrt{${c.map(latex).join("").trim()}}`;
    case "mroot":
      return `\\sqrt[${L(1)}]{${L(0)}}`;
    case "munder":
    case "mover":
    case "munderover": {
      const base = L(0);
      const mark = node.t === "munder" ? null : plainText(c[node.t === "mover" ? 1 : 2] || "").trim();
      if (node.t === "mover" && ACCENTS[mark]) return `\\${ACCENTS[mark]}{${base}}`;
      if (node.t === "munder" && /^[_̲‗]$/.test(plainText(c[1] || "").trim())) return `\\underline{${base}}`;
      if (node.t === "munder" && /^[⏟︸]$/.test(plainText(c[1] || "").trim())) return `\\underbrace{${base}}`;
      if (node.t === "mover" && /^[⏞︷]$/.test(mark)) return `\\overbrace{${base}}`;
      const b = BIG.test(base) || /^[A-Za-z]+$/.test(base) ? base : group(base);
      if (node.t === "munder") return `${b}_${group(L(1))}`;
      if (node.t === "mover") return `${b}^${group(L(1))}`;
      return `${b}_${group(L(1))}^${group(L(2))}`;
    }
    case "mtable": {
      const rows = c.map((r) => (typeof r === "string" ? "" : r.c.map((d) => latex(d).trim()).join(" & ")));
      return `\\begin{matrix} ${rows.join(" \\\\ ")} \\end{matrix}`;
    }
    case "mtr":
    case "mlabeledtr":
      return c.map(latex).join(" & ");
    case "mtd":
      return c.map(latex).join("");
    case "mmultiscripts":
      return c.map(latex).join("");
    case "none":
    case "mprescripts":
      return "";
    default:
      return c.map(latex).join("");
  }
}

/** Tidies spacing: no space before a brace or after a backslash command that ends the formula. */
const tidy = (s) => s.replace(/\s+/g, " ").replace(/ ([}^_)\],])/g, "$1").replace(/([{(\[]) /g, "$1").trim();

const toLatex = (tree) => tidy(latex(tree));

// ------------------------------------------------------------ on the page, and back from the page's text

const MARK = "@@";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/**
 * A formula as it goes into a page: the MathML that draws it, with its LaTeX before and an end
 * mark after, both invisible (see `unmark`). Display formulas get a block of their own.
 */
function marked(tree) {
  const display = tree.a && tree.a.display === "block";
  const tex = toLatex(tree);
  const open = `<span class="tx">${MARK}${display ? "D" : "M"}:${b64(tex)}${MARK}</span>`;
  const close = `<span class="tx">${MARK}E${MARK}</span>`;
  const drawn = toMathml(tree);
  return display ? `<div class="formula">${open}${drawn}${close}</div>` : `${open}${drawn}${close}`;
}

/**
 * The text read from a page with formulas: each formula's letters in pieces (as a PDF reader
 * finds them) give way to its LaTeX, between $ signs ($$ for one on a line of its own).
 */
function unmark(text) {
  if (text.indexOf(MARK) < 0) return text;
  return text
    .replace(/@@([MD]):([A-Za-z0-9+/=\s]*?)@@[\s\S]*?@@E@@/g, (_, kind, data) => {
      let tex = "";
      try {
        tex = Buffer.from(data.replace(/\s+/g, ""), "base64").toString("utf8");
      } catch {
        tex = "";
      }
      return kind === "D" ? `\n$$${tex}$$\n` : ` $${tex}$ `;
    })
    .replace(/@@[MD]:[A-Za-z0-9+/=\s]*?@@|@@E@@/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?)])/g, "$1");
}

module.exports = { fromOmml, fromMathml, toMathml, toLatex, marked, unmark };

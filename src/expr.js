// A small, safe reader for maths typed as a result ("2x^2 - 4x + 1", "(x-2)^2 - 3", "sqrt(2)/2"):
// its own tokenizer and parser, never eval or new Function. Two expressions are the same when they
// give the same value at many points, small and large, positive and negative: "x^2-4x+1" and
// "(x-2)^2-3" are equal, "x^2+4x+1" is not. When too few points can be compared (a root or a
// logarithm defined only far out), the answer is "cannot tell", never "different".

const FUNCTIONS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
};
const CONSTANTS = { pi: Math.PI, π: Math.PI, e: Math.E };
const FRACTIONS = { "½": "(1/2)", "⅓": "(1/3)", "⅔": "(2/3)", "¼": "(1/4)", "¾": "(3/4)", "⅕": "(1/5)", "⅙": "(1/6)", "⅛": "(1/8)" };
const MOST = 400; // characters: a result, not an essay

/** Tokens: numbers, names, operators and brackets. Returns null for anything else. */
function tokens(text) {
  let src = String(text)
    .toLowerCase()
    .replace(/[½⅓⅔¼¾⅕⅙⅛]/g, (f) => FRACTIONS[f])
    .replace(/[−–]/g, "-")
    .replace(/[·×]/g, "*")
    .replace(/÷/g, "/")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/√/g, "sqrt")
    .replace(/\\left|\\right/g, "")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
    .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/\\pi/g, "pi")
    .replace(/[{}]/g, (b) => (b === "{" ? "(" : ")"))
    .replace(/\$/g, "");
  // |x| is abs(x), from the inside out.
  for (let k = 0; k < 10 && /\|[^|]+\|/.test(src); k++) src = src.replace(/\|([^|]+)\|/, "abs($1)");
  if (src.length > MOST) return null;
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+(?:[.,]\d+)?|[.,]\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[1].replace(",", ".")) });
      i += num[1].length;
      continue;
    }
    const name = /^[a-zA-Zπ]+/.exec(src.slice(i));
    if (name) {
      // "sqrtx" or "2pix": a known function or constant at the start, then single letters.
      let word = name[0];
      while (word) {
        const fn = Object.keys(FUNCTIONS).find((f) => word.startsWith(f));
        const k = !fn && Object.keys(CONSTANTS).find((f) => word.startsWith(f) && f !== "e");
        if (fn) {
          out.push({ t: "fn", v: fn });
          word = word.slice(fn.length);
        } else if (k) {
          out.push({ t: "const", v: k });
          word = word.slice(k.length);
        } else {
          out.push({ t: "name", v: word[0] });
          word = word.slice(1);
        }
      }
      i += name[0].length;
      continue;
    }
    if ("+-*/^()".includes(c)) {
      out.push({ t: c });
      i++;
      continue;
    }
    return null;
  }
  return out;
}

/**
 * Parses into a tree. Grammar: sum = product (("+"|"-") product)*; product = unary (("*"|"/"|implicit) unary)*;
 * unary = ("-"|"+") unary | power; power = atom ("^" unary)?; atom = number | name | fn atom | "(" sum ")".
 */
function parse(list) {
  let i = 0;
  const peek = () => list[i];
  const take = (t) => (list[i] && list[i].t === t ? list[i++] : null);
  let depth = 0;
  const sum = () => {
    if (++depth > 60) throw new Error("deep");
    let left = product();
    for (;;) {
      if (take("+")) left = ["+", left, product()];
      else if (take("-")) left = ["-", left, product()];
      else break;
    }
    depth--;
    return left;
  };
  const startsAtom = (tok) => tok && (tok.t === "num" || tok.t === "name" || tok.t === "const" || tok.t === "fn" || tok.t === "(");
  const product = () => {
    let left = unary();
    for (;;) {
      if (take("*")) left = ["*", left, unary()];
      else if (take("/")) left = ["/", left, unary()];
      else if (startsAtom(peek())) left = ["*", left, power()]; // 2x, 3(x+1), (x+1)(x-1)
      else break;
    }
    return left;
  };
  const unary = () => {
    if (take("-")) return ["neg", unary()];
    if (take("+")) return unary();
    return power();
  };
  const power = () => {
    const base = atom();
    if (take("^")) return ["^", base, unary()];
    return base;
  };
  // A function's argument: a bracket on its own (so sin(x)^2 is the square of sin x), else what follows.
  const argument = () => (peek() && peek().t === "(" ? atom() : power());
  const atom = () => {
    const tok = list[i++];
    if (!tok) throw new Error("end");
    if (tok.t === "num") return ["num", tok.v];
    if (tok.t === "name") return ["var", tok.v];
    if (tok.t === "const") return ["num", CONSTANTS[tok.v]];
    if (tok.t === "fn") {
      // sin^2 x and sin²x: the square of sin x.
      if (take("^")) {
        const exponent = unary();
        return ["^", ["fn", tok.v, argument()], exponent];
      }
      return ["fn", tok.v, argument()];
    }
    if (tok.t === "(") {
      const inner = sum();
      if (!take(")")) throw new Error("bracket");
      return inner;
    }
    throw new Error("token");
  };
  const tree = sum();
  if (i !== list.length) throw new Error("rest");
  return tree;
}

function evaluate(tree, vars) {
  const [op, a, b] = tree;
  switch (op) {
    case "num":
      return a;
    case "var":
      return a === "e" ? Math.E : Object.prototype.hasOwnProperty.call(vars, a) ? vars[a] : NaN;
    case "neg":
      return -evaluate(a, vars);
    case "fn":
      return FUNCTIONS[a](evaluate(b, vars));
    case "+":
      return evaluate(a, vars) + evaluate(b, vars);
    case "-":
      return evaluate(a, vars) - evaluate(b, vars);
    case "*":
      return evaluate(a, vars) * evaluate(b, vars);
    case "/":
      return evaluate(a, vars) / evaluate(b, vars);
    case "^":
      return Math.pow(evaluate(a, vars), evaluate(b, vars));
    default:
      return NaN;
  }
}

const namesOf = (tree, out = new Set()) => {
  if (tree[0] === "var" && tree[1] !== "e") out.add(tree[1]);
  for (const x of tree.slice(1)) if (Array.isArray(x)) namesOf(x, out);
  return out;
};

/** The tree of a typed expression, or null. "f(x) = …" and "y = …" count as what is after "=". */
function read(text) {
  const right = String(text || "").split("=").pop();
  const list = tokens(right);
  if (!list || !list.length) return null;
  try {
    return parse(list);
  } catch {
    return null;
  }
}

// Where the points are taken from, in turn: around zero, small and large, positive and negative.
const RANGES = [
  [-3, 3],
  [0.5, 10],
  [-10, -0.5],
  [10, 1000],
  [-1000, -10],
  [0.01, 1],
];

/**
 * Whether `typed` is the same expression as `expected`: true (the same value at twelve points,
 * within a millionth), false (a point where they differ, or where only the expected one has a
 * value), or null: it cannot tell (an expression that cannot be read, or too few points where
 * the expected one has a value). Variables are the letters in either.
 */
function compare(typed, expected) {
  const a = read(typed);
  const b = read(expected);
  if (!a || !b) return null;
  const names = [...new Set([...namesOf(a), ...namesOf(b)])];
  if (names.length > 10) return null;
  let compared = 0;
  // A fixed sequence of points: the same answer is always judged the same way.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 120 && compared < 12; k++) {
    const [lo, hi] = RANGES[k % RANGES.length];
    const vars = Object.fromEntries(names.map((n) => [n, Math.round((lo + random() * (hi - lo)) * 1000) / 1000 || 0.37]));
    const x = evaluate(b, vars);
    if (!Number.isFinite(x)) continue;
    const y = evaluate(a, vars);
    if (!Number.isFinite(y) || Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(x))) return false;
    compared++;
  }
  return compared >= 4 ? true : null;
}

/** The same expression? Only a sure yes is true. */
const same = (typed, expected) => compare(typed, expected) === true;

/**
 * Other ways to read what was typed, where the writing allows more than one: "1/2x" may be
 * 1/(2x), "e^2x" may be e^(2x), "2 x 3" may be 2 · 3. Each as text with brackets.
 */
function alternatives(text) {
  const src = String(text || "").split("=").pop().trim();
  const out = new Set();
  // a/bx: the rest of the term below the line.
  const below = src.replace(/\/\s*([0-9.,]+\s*[a-zA-Z(][a-zA-Z0-9^()]*)/, (m, rest) => `/(${rest})`);
  if (below !== src) out.add(below);
  // e^2x: the whole term in the exponent.
  const up = src.replace(/\^\s*([0-9.,]+\s*[a-zA-Z(][a-zA-Z0-9()]*)/, (m, rest) => `^(${rest})`);
  if (up !== src) out.add(up);
  // 2 x 3: "x" as "times".
  const times = src.replace(/(\d)\s+[x×]\s+(\d)/g, "$1*$2");
  if (times !== src) out.add(times);
  return [...out];
}

/** The value of a typed expression without variables ("3/4 + 1/8", "sqrt(2)/2"), or NaN. */
function value(text) {
  const tree = read(text);
  if (!tree || namesOf(tree).size) return NaN;
  return evaluate(tree, {});
}

module.exports = { same, compare, alternatives, value, read };

// Is the result right? Decided here, without a model, wherever that is safe: one number, or a
// set of numbers. Only the result counts: nobody is asked for the way to it.
//
// People write numbers in many ways ("21920.70", "21'920.70", "21 920,70", "CHF 21'920.70",
// "x = 3", "1.5·10^3", "3/4", "2 1/2", "√2", "±2", "4,646 / -0,646"). A typed text is read in
// every way it can reasonably be meant; it is right when one of those readings is the expected
// value. This file can say "right" for certain. It cannot say "wrong" for certain (there is
// always one more way to write a number), so a "wrong" from here gets a second look elsewhere.

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

/** The same text in plain characters: one kind of minus, no thousands apostrophes, no subscript digits. */
function plain(text) {
  return String(text)
    .replace(/[−–—]/g, "-")
    .replace(/['’ʼ‘`]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/[₀-₉]/g, (c) => String(SUBSCRIPTS.indexOf(c)))
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/[·×⋅]/g, "*")
    .replace(/÷/g, "/");
}

/** Every value the digits of one written number can stand for, and how many decimals were written. */
function literal(digits) {
  const out = new Set();
  let places = 0;
  const add = (text) => {
    const v = Number(text);
    if (Number.isFinite(v)) out.add(v);
  };
  const dots = (digits.match(/\./g) || []).length;
  const commas = (digits.match(/,/g) || []).length;
  if (dots && commas) {
    // Both: the one that comes last is the decimal sign.
    const decimal = digits.lastIndexOf(".") > digits.lastIndexOf(",") ? "." : ",";
    places = digits.length - 1 - digits.lastIndexOf(decimal);
    add(digits.split(decimal === "." ? "," : ".").join("").replace(",", "."));
  } else if (dots + commas > 1) {
    add(digits.replace(/[.,]/g, "")); // "1.234.567": groups of thousands
  } else if (dots + commas === 1) {
    const [head, tail] = digits.split(/[.,]/);
    places = tail.length;
    add((head || "0") + "." + tail);
    // "21.920" or "1,234" can also be thousands: both readings are kept.
    if (tail.length === 3 && head.length >= 1 && head.length <= 3 && head !== "0") add(head + tail);
  } else {
    add(digits);
  }
  return { values: [...out], places };
}

/**
 * Reads one number, or a small calculation that stands for one ("3/4", "2 1/2", "√2",
 * "1,5*10^3", "2^3", "π/2"), from the start of `text`, and stops where something else begins
 * (a unit, a word). Returns { values, places } with every value it can stand for, or null.
 */
function read(text) {
  let s = plain(text).trim();
  let at = 0;
  let places = 0;
  const skip = () => {
    while (s[at] === " ") at++;
  };
  const combine = (a, b, fn) => {
    const out = [];
    for (const x of a) for (const y of b) if (out.length < 12) out.push(fn(x, y));
    return out.filter(Number.isFinite);
  };
  function primary() {
    skip();
    const rest = s.slice(at);
    let m;
    if ((m = rest.match(/^(sqrt|wurzel)\s*\(/i))) {
      at += m[0].length;
      const inner = sum();
      skip();
      if (s[at] === ")") at++;
      return inner && inner.map(Math.sqrt).filter(Number.isFinite);
    }
    if (rest[0] === "√") {
      at++;
      const inner = primary();
      return inner && inner.map(Math.sqrt).filter(Number.isFinite);
    }
    if ((m = rest.match(/^(pi\b|π)/i))) {
      at += m[0].length;
      return [Math.PI];
    }
    if (rest[0] === "(") {
      at++;
      const inner = sum();
      skip();
      if (s[at] === ")") at++;
      return inner;
    }
    // Digits with their separators. A space counts as a thousands separator only before a group of three.
    if ((m = rest.match(/^(\d{1,3}(?: \d{3})+(?:[.,]\d+)?(?!\d)|\d[\d.,]*|[.,]\d+)/))) {
      let digits = m[0].replace(/ /g, "").replace(/[.,]+$/, "");
      at += m[0].replace(/[.,]+$/, "").length;
      const lit = literal(digits);
      places = Math.max(places, lit.places);
      let values = lit.values;
      // "1.5e3"
      const e = s.slice(at).match(/^e([+-]?\d+)(?![a-z])/i);
      if (e) {
        at += e[0].length;
        values = values.map((v) => v * 10 ** Number(e[1]));
      }
      // "2 1/2": a whole number and a fraction
      const mixed = s.slice(at).match(/^ (\d+)\/(\d+)(?![\d.,])/);
      if (mixed && /^\d+$/.test(digits) && Number(mixed[2]) > Number(mixed[1])) {
        at += mixed[0].length;
        values = values.map((v) => v + Number(mixed[1]) / Number(mixed[2]));
      }
      if (s[at] === "%" || s.slice(at, at + 2) === " %") {
        at += s[at] === "%" ? 1 : 2;
        // "12 %" may answer a question whose result is 0.12.
        values = [...values, ...values.map((v) => v / 100)];
      }
      return values;
    }
    return null;
  }
  function unary() {
    skip();
    if (s[at] === "-" || s[at] === "+") {
      const sign = s[at] === "-" ? -1 : 1;
      at++;
      const v = unary();
      return v && v.map((x) => sign * x);
    }
    return primary();
  }
  function power() {
    const base = unary();
    if (!base) return null;
    skip();
    if (s[at] === "^" || s.slice(at, at + 2) === "**") {
      const back = at;
      at += s[at] === "^" ? 1 : 2;
      const exp = unary();
      if (!exp) return (at = back), base;
      return combine(base, exp, (a, b) => Math.pow(a, b));
    }
    return base;
  }
  function product() {
    let left = power();
    if (!left) return null;
    for (;;) {
      skip();
      const back = at;
      let op = s[at];
      // "1,5 x 10^3"
      if (/^x\s*10\s*\^/i.test(s.slice(at))) op = "*";
      // "2√2", "3π": a number right in front of a root or of pi multiplies it
      else if (/^(√|sqrt|wurzel|π|pi\b)/i.test(s.slice(at))) (op = "*"), at--;
      else if (op !== "*" && op !== "/" && op !== ":") return left;
      at++;
      const right = power();
      if (!right) return (at = back), left;
      left = combine(left, right, op === "*" ? (a, b) => a * b : (a, b) => a / b);
    }
  }
  function sum() {
    let left = product();
    if (!left) return null;
    for (;;) {
      skip();
      const back = at;
      const op = s[at];
      if (op !== "+" && op !== "-") return left;
      at++;
      const right = product();
      if (!right) return (at = back), left;
      left = combine(left, right, op === "+" ? (a, b) => a + b : (a, b) => a - b);
    }
  }
  // Start at the first thing a number can begin with: "CHF 21 920.70", "about 7".
  const start = s.search(/[-+]?\s*(\d|[.,]\d|√|\(|sqrt|wurzel|pi\b|π)/i);
  if (start < 0) return null;
  s = s.slice(start);
  const values = sum();
  return values && values.length ? { values, places } : null;
}

/** Every value a piece of text with one number in it can stand for. */
const readings = (piece) => (read(piece) || { values: [] }).values;

/** The part of an answer that holds the result: after the last "=", "≈" or arrow if there is one. */
const resultPart = (text) => plain(text).split(/[=≈→⇒]|->|=>/).pop();

function near(value, expected, tolerance) {
  // An expected value like 1.41421356 is itself rounded: a millionth of it is not a difference.
  return Math.abs(value - expected) <= Math.max(tolerance || 0, Math.abs(expected) * 1e-6, 1e-12);
}

/**
 * One number. Right when it is within the tolerance that came with the question, or when it is
 * the expected value rounded the way the person wrote it (4.65 for 4.646, 21921 for 21920.70),
 * as long as the rounding changes it by less than two percent.
 */
function numberRight(typed, expected, tolerance = 0) {
  return signs(resultPart(typed)).some((piece) => {
    const got = read(piece);
    if (!got) return false;
    const rounded = Math.round(expected * 10 ** got.places) / 10 ** got.places;
    return got.values.some((v) => near(v, expected, tolerance) || (near(v, rounded, 0) && Math.abs(v - expected) <= Math.abs(expected) * 0.02));
  });
}

/** "±2" is two answers: "+2" and "-2". */
function signs(piece) {
  const at = piece.search(/±|\+\/-|\+-/);
  if (at < 0) return [piece];
  const rest = piece.slice(at).replace(/^(±|\+\/-|\+-)/, "");
  return [piece.slice(0, at) + "+" + rest, piece.slice(0, at) + "-" + rest];
}

/** The ways an answer that names several numbers can be cut into pieces of one number each. */
function pieces(typed, count) {
  const clean = plain(typed)
    .replace(/[{}[\]]/g, " ")
    .replace(/[a-zA-Z]\w*\s*∈/g, " ")
    // "x1 =", "x_2=", "t ="
    .replace(/[a-zA-Z]+\s*_?\s*\d*\s*[=≈]/g, " ; ");
  const words = /;|\||\n|∨|\bor\b|\band\b|\boder\b|\bund\b|\bet\b|\bou\b/i;
  const cut = (text, re) =>
    text
      .split(re)
      .map((p) => p.trim())
      .filter((p) => /\d|π|pi\b/i.test(p))
      .flatMap(signs);
  const ways = [];
  for (const text of [clean, clean.replace(/[()]/g, " ")]) {
    ways.push(cut(text, words));
    ways.push(cut(text, new RegExp(words.source + "|,\\s+", "i")));
    ways.push(cut(text, new RegExp(words.source + "|\\s+/\\s+", "i")));
    ways.push(cut(text, new RegExp(words.source + "|,\\s+|\\s+/\\s+", "i")));
    ways.push(cut(text, new RegExp(words.source + "|,|\\s+", "i")));
    ways.push(cut(text, new RegExp(words.source + "|\\s+", "i")));
  }
  return ways.filter((w) => w.length === count);
}

/** Several numbers, in any order: every expected value is named once, and nothing else. */
function numbersRight(typed, expected, tolerance = 0) {
  if (expected.length === 1) return numberRight(typed, expected[0], tolerance);
  return pieces(typed, expected.length).some((way) => {
    const left = [...expected];
    for (const piece of way) {
      const at = left.findIndex((e) => numberRight(piece, e, tolerance));
      if (at < 0) return false;
      left.splice(at, 1);
    }
    return left.length === 0;
  });
}

/** Several numbers in their order: a point "(2 | -3)" is not "(-3 | 2)". */
function numbersInOrder(typed, expected, tolerance = 0) {
  if (expected.length === 1) return numberRight(typed, expected[0], tolerance);
  return pieces(typed, expected.length).some((way) => way.every((piece, i) => numberRight(piece, expected[i], tolerance)));
}

/** How a number is shown as the expected result: no trailing noise, at most six decimals. */
function show(value) {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(value * 1e6) / 1e6);
}

module.exports = { readings, numberRight, numbersRight, numbersInOrder, show };

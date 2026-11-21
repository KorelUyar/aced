// Is the result right? Decided here, without a model, wherever that is safe: one number, or a
// set of numbers. Only the result counts: nobody is asked for the way to it.
//
// People write numbers in many ways ("21920.70", "21'920.70", "21 920,70", "CHF 21'920.70",
// "x = 3", "1.5·10^3", "3/4"). A typed text is read in every way it can reasonably be meant;
// it is right when one of those readings is the expected value.

const SPACES = /[\s   ]/g;
const APOSTROPHES = /['’ʼ‘`]/g;

/** Every value a piece of text with one number in it can stand for. */
function readings(piece) {
  let s = String(piece).replace(/[−–—]/g, "-").replace(APOSTROPHES, "").trim();
  // "1.5·10^3", "1.5 x 10^-3", "1.5e3"
  let power = 0;
  const sci = s.match(/(?:[x×·*]\s*10\s*\^?\s*|e)\s*\(?\s*([+-]?\d+)\s*\)?\s*$/i);
  if (sci && /\d/.test(s.slice(0, sci.index))) {
    power = Number(sci[1]);
    s = s.slice(0, sci.index);
  }
  const percent = /%/.test(s);
  // A fraction: "3/4", "-7 / 2"
  const fraction = s.match(/(-?\s*\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/);
  if (fraction) {
    const a = readings(fraction[1])[0];
    const b = readings(fraction[2])[0];
    return b ? [(a / b) * 10 ** power] : [];
  }
  const m = s.replace(SPACES, " ").match(/-?\s*\d[\d .,]*|-?\s*[.,]\d+/);
  if (!m) return [];
  const negative = m[0].trim().startsWith("-");
  let digits = m[0].replace(/^-\s*/, "").trim().replace(/[.,]+$/, "");
  // A space between groups of digits is a thousands separator ("21 920,70"), unless what
  // follows is not a group of three: then the number ended before it.
  digits = digits.replace(/ (?=\d{3}(?:\D|$))/g, "").split(" ")[0];
  const out = new Set();
  const add = (text) => {
    const v = Number(text);
    if (Number.isFinite(v)) out.add((negative ? -v : v) * 10 ** power);
  };
  const dots = (digits.match(/\./g) || []).length;
  const commas = (digits.match(/,/g) || []).length;
  if (dots && commas) {
    // Both: the one that comes last is the decimal sign.
    const decimal = digits.lastIndexOf(".") > digits.lastIndexOf(",") ? "." : ",";
    add(digits.split(decimal === "." ? "," : ".").join("").replace(",", "."));
  } else if (dots + commas > 1) {
    add(digits.replace(/[.,]/g, "")); // "1.234.567": groups of thousands
  } else if (dots + commas === 1) {
    const [head, tail] = digits.split(/[.,]/);
    add(head + "." + tail);
    // "21.920" or "1,234" can also be thousands: both readings are kept.
    if (tail.length === 3 && head.length >= 1 && head.length <= 3 && head !== "0") add(head + tail);
  } else {
    add(digits);
  }
  const values = [...out];
  // "12 %" may answer a question whose result is 0.12.
  return percent ? [...values, ...values.map((v) => v / 100)] : values;
}

const decimalsTyped = (piece) => {
  const m = String(piece).replace(APOSTROPHES, "").match(/\d[.,](\d+)\s*(?:%|[a-zA-Z°€$]|$)/);
  return m ? m[1].length : 0;
};

/** The part of an answer that holds the result: after the last "=" or "≈" if there is one. */
const resultPart = (text) => String(text).split(/[=≈]/).pop();

function near(value, expected, tolerance) {
  return Math.abs(value - expected) <= Math.max(tolerance || 0, Math.abs(expected) * 1e-9, 1e-12);
}

/**
 * One number. Right when it is within the tolerance that came with the question, or when it is
 * the expected value rounded the way the person wrote it (21921 for 21920.70), as long as the
 * rounding changes less than half a percent.
 */
function numberRight(typed, expected, tolerance = 0) {
  const piece = resultPart(typed);
  const values = readings(piece);
  if (!values.length) return false;
  const places = decimalsTyped(piece);
  const rounded = Math.round(expected * 10 ** places) / 10 ** places;
  return values.some(
    (v) => near(v, expected, tolerance) || (near(v, rounded, 0) && Math.abs(v - expected) <= Math.abs(expected) * 0.005),
  );
}

/** The pieces of an answer that names several numbers: "x1 = 1; x2 = 3", "1 und 3", "{1, 3}", "1,5 / 3". */
function pieces(typed, count) {
  const clean = String(typed)
    .replace(/[{}[\]()]/g, " ")
    // "x1 =", "x_2=", "t ="
    .replace(/[a-zA-Z]+\s*_?\s*\d*\s*[=≈]/g, " ; ");
  const split = (re) => clean.split(re).map((p) => p.trim()).filter((p) => /\d/.test(p));
  const ways = [split(/;|\||\n|\bor\b|\band\b|\boder\b|\bund\b|\bet\b|\bou\b/i), split(/;|\||\n|,\s+|\bor\b|\band\b|\boder\b|\bund\b/i), split(/[;|\n,]|\s+|\bor\b|\band\b|\boder\b|\bund\b/i)];
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

/** How a number is shown as the expected result: no trailing noise, at most six decimals. */
function show(value) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

module.exports = { readings, numberRight, numbersRight, show };

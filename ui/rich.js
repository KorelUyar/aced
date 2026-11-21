// Text written by the model, with its formulas drawn by KaTeX. Formulas come as LaTeX between
// $ and $ (or $$ and $$). Everything else is shown as plain text, never as HTML.
import katex from "./vendor/katex/katex.mjs";
import { html } from "./vendor/htm-preact.js";

const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^\n$]+?)(?<!\s)\$/g;

function draw(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", output: "htmlAndMathml" });
  } catch {
    return null;
  }
}

export function Rich({ text }) {
  const parts = [];
  let last = 0;
  const source = String(text ?? "");
  for (const m of source.matchAll(MATH)) {
    if (m.index > last) parts.push(source.slice(last, m.index));
    const display = m[1] !== undefined || m[2] !== undefined;
    const drawn = draw(m[1] ?? m[2] ?? m[3] ?? m[4], display);
    // A formula KaTeX cannot read is shown as it was written.
    parts.push(drawn ? html`<span class=${display ? "math block" : "math"} dangerouslySetInnerHTML=${{ __html: drawn }}></span>` : m[0]);
    last = m.index + m[0].length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return html`<span class="rich">${parts}</span>`;
}

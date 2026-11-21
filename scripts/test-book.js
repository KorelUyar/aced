// Checks the book panel (ui/book.js) in the real app, in a hidden window:
//
//   node_modules/.bin/electron scripts/test-book.js [folder with PDFs] [--shots=folder]
//
// The app is started with an empty scratch folder, test books are put into its library, and
// the panel is mounted over the app's own page (so its CSP and its aced-book:// address apply).
// The books are made here, from our own text:
// - "outlined": every letter a filled shape, printed to PDF by Chromium (how a book saved from
//   a web reader looks: no text, thousands of paths, large pages)
// - scans in the codecs scanned books use: JPEG 2000, JBIG2 (plain and with shared symbols)
//   and fax coding (CCITT G4). Their pictures are the small files in scripts/fixtures/book:
//   one page of our own text drawn with Pillow, coded with Pillow (JPEG 2000, G4) and jbig2enc.
// - "long": 500 pages of three sizes, each with a square whose colour tells its number, a link
//   and a script that must stay dead
// - a PDF with a password, a file that is no PDF, a PDF cut off in the middle, a missing file
// Every PDF in the folder given is tried as well (first page, a jump, scrolling, zoom).
// `--shots` saves a picture of the panel for each book.
const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quiet, hideWindowsOf, hiddenWindow, sleep } = require("./hidden");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== __filename && !a.endsWith("test-book.js"));
const folder = args.length ? path.resolve(args[args.length - 1]) : null;
const shotsArg = process.argv.find((a) => a.startsWith("--shots="));
const shots = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "aced-book-"));
app.setPath("userData", userData);
quiet();
const mainFile = path.join(__dirname, "..", "main.js");
const window = hideWindowsOf(mainFile);
require(mainFile);

// ------------------------------------------------------------ making PDFs

/** A PDF from its objects (numbered from 1; object 1 is the catalog). */
function pdf(objects, trailer = "") {
  const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), Buffer.from(data), Buffer.from("\nendstream")]);

/** A scanned book: `count` pages that all show the same picture. `extra` objects follow (the first is object 6). */
function scanPdf(count, { w, h, dpi }, dict, data, extra = []) {
  const [pw, ph] = [((w * 72) / dpi).toFixed(2), ((h * 72) / dpi).toFixed(2)];
  const first = 6 + extra.length;
  const pages = Array.from({ length: count }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im 4 0 R >> >> /Contents 3 0 R >>`);
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${pages.map((_, i) => `${first + i} 0 R`).join(" ")}] >>`,
    stream("", `q ${pw} 0 0 ${ph} 0 0 cm /Im Do Q`),
    stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ${dict}`, data),
    "null",
    ...extra,
    ...pages,
  ]);
}

const SIZES = { a4: [595, 842], wide: [792, 612], tall: [600, 1200] };
const sizeOf = (n) => (n % 7 === 0 ? "tall" : n % 5 === 0 ? "wide" : "a4");
/** The colour of the square on page n of the long book; `pageOf` reads the number back from a pixel. */
const colourOf = (n) => [(n % 16) * 16 + 8, (Math.floor(n / 16) % 16) * 16 + 8, (Math.floor(n / 256) % 16) * 16 + 8];

/**
 * Pages of three sizes with real text (a standard font that is not in the file). Page 1 has a
 * link over all of it, and the file asks for a script to run when it is opened.
 * `encrypt(objectNumber, data)` may scramble the page contents (for the PDF with a password);
 * page `lost` is not a page at all (a damaged spot in an otherwise good file).
 */
function longPdf(count, { trailer = "", extra = [], encrypt = (_n, data) => data, lost = 0 } = {}) {
  const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", ...extra];
  const kids = [];
  for (let n = 1; n <= count; n++) {
    const [w, h] = SIZES[sizeOf(n)];
    const [r, g, b] = colourOf(n).map((v) => (v / 255).toFixed(4));
    const lines = Array.from({ length: 12 }, (_, i) => `BT /F1 13 Tf ${w * 0.1} ${h * 0.6 - i * 22} Td (Line ${i + 1} of page ${n}: a parabola opens upwards when a is positive.) Tj ET`).join("\n");
    const content = `${r} ${g} ${b} rg ${w * 0.1} ${h * 0.7} ${w * 0.25} ${h * 0.2} re f\n0 g BT /F1 40 Tf ${w * 0.42} ${h * 0.78} Td (Page ${n}) Tj ET\n${lines}`;
    const number = objects.length + 1;
    kids.push(`${number} 0 R`);
    const link = n === 1 ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 ${w} ${h}] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/left-the-app) >> >>]` : "";
    objects.push(n === lost ? "42" : `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${number + 1} 0 R${link} >>`);
    objects.push(stream("", encrypt(number + 1, Buffer.from(content, "latin1"))));
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\('script ran'\\);) >> >>";
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(" ")}] >>`;
  return pdf(objects, trailer);
}

/**
 * Two pages that need what is vendored beside pdf.js: Japanese text in a font that is not in
 * the file (its codes are only understood with Adobe's character maps), and a CMYK colour.
 */
function specialPdf() {
  const text = (words) => Buffer.from(words, "utf16le").swap16().toString("hex");
  const lines = ["二次関数", "放物線の頂点", "判別式と解の個数", "平方完成の手順"].map((words, i) => `BT /F1 ${i ? 34 : 54} Tf 60 ${700 - i * 90} Td <${text(words)}> Tj ET`).join("\n");
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R >>",
    stream("", lines),
    stream("", "1 0 0 0 k 100 300 400 400 re f"),
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [8 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 9 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 90 >>",
  ]);
}

/** The same kind of book, readable only with a password (the standard handler, RC4 with 128 bits). */
function lockedPdf(password) {
  const md5 = (...parts) => crypto.createHash("md5").update(Buffer.concat(parts)).digest();
  const rc4 = (key, data) => {
    const s = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 255;
      [s[i], s[j]] = [s[j], s[i]];
    }
    const out = Buffer.alloc(data.length);
    for (let n = 0, i = 0, j = 0; n < data.length; n++) {
      i = (i + 1) & 255;
      j = (j + s[i]) & 255;
      [s[i], s[j]] = [s[j], s[i]];
      out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
  };
  const twenty = (key, data) => Array.from({ length: 20 }, (_, i) => i).reduce((d, i) => rc4(key.map((b) => b ^ i), d), data);
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const padded = (word) => Buffer.concat([Buffer.from(word, "latin1"), padding]).subarray(0, 32);
  const fifty = (hash) => Array.from({ length: 50 }).reduce((h) => md5(h), hash);
  const id = md5(Buffer.from("aced test book"));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-3904);
  const owner = twenty(fifty(md5(padded(password + " (owner)"))), padded(password));
  const key = fifty(md5(padded(password), owner, permissions, id));
  const user = Buffer.concat([twenty(key, md5(padding, id)), Buffer.alloc(16)]);
  const encrypt = (number, data) => rc4(md5(key, Buffer.from([number & 255, (number >> 8) & 255, (number >> 16) & 255, 0, 0])), data);
  return longPdf(3, {
    extra: [`<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> >>`],
    trailer: `/Encrypt 4 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] `,
    encrypt,
  });
}

// A stroke font of our own, so that a book without text can be made here: points on a grid
// 4 wide and 6 high, strokes separated by "|". Each letter becomes one filled shape (its
// strokes as boxes, their ends as discs).
const O = "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0";
const P = "0,6 0,0 3,0 4,1 4,2 3,3 0,3";
const STROKES = {
  A: "0,6 2,0 4,6|1,4 3,4", B: "0,0 0,6 3,6 4,5 4,4 3,3 0,3|0,0 3,0 4,1 4,2 3,3", C: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5", D: "0,0 0,6 3,6 4,5 4,1 3,0 0,0",
  E: "4,0 0,0 0,6 4,6|0,3 3,3", F: "4,0 0,0 0,6|0,3 3,3", G: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3", H: "0,0 0,6|4,0 4,6|0,3 4,3", I: "2,0 2,6|1,0 3,0|1,6 3,6",
  J: "3,0 3,5 2,6 1,6 0,5", K: "0,0 0,6|4,0 0,3 4,6", L: "0,0 0,6 4,6", M: "0,6 0,0 2,3 4,0 4,6", N: "0,6 0,0 4,6 4,0", O, P, Q: `${O}|2,4 4,6`, R: `${P}|2,3 4,6`,
  S: "4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5", T: "0,0 4,0|2,0 2,6", U: "0,0 0,5 1,6 3,6 4,5 4,0", V: "0,0 2,6 4,0", W: "0,0 1,6 2,3 3,6 4,0", X: "0,0 4,6|4,0 0,6",
  Y: "0,0 2,3 4,0|2,3 2,6", Z: "0,0 4,0 0,6 4,6", 0: `${O}|1,5 3,1`, 1: "1,1 2,0 2,6|1,6 3,6", 2: "0,1 1,0 3,0 4,1 4,2 0,6 4,6", 3: "0,0 4,0 2,2 3,2 4,3 4,5 3,6 1,6 0,5",
  4: "3,6 3,0 0,4 4,4", 5: "4,0 0,0 0,2 3,2 4,3 4,5 3,6 1,6 0,5", 6: "3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3", 7: "0,0 4,0 1,6",
  8: "1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0|1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3", 9: "1,6 3,6 4,5 4,1 3,0 1,0 0,1 0,2 1,3 4,3",
  ".": "2,6 2,6", ",": "2,6 1,7", ":": "2,2 2,2|2,5 2,5", "=": "0,2 4,2|0,4 4,4", "+": "2,1 2,5|0,3 4,3", "-": "0,3 4,3", "(": "3,0 2,1 2,5 3,6", ")": "1,0 2,1 2,5 1,6", "/": "0,6 4,0",
};
function shapeOf(strokes, r = 0.4) {
  const f = (v) => +v.toFixed(3);
  const k = 0.5523 * r;
  const disc = (x, y) => `M${f(x + r)} ${f(y)}C${f(x + r)} ${f(y - k)} ${f(x + k)} ${f(y - r)} ${f(x)} ${f(y - r)}C${f(x - k)} ${f(y - r)} ${f(x - r)} ${f(y - k)} ${f(x - r)} ${f(y)}C${f(x - r)} ${f(y + k)} ${f(x - k)} ${f(y + r)} ${f(x)} ${f(y + r)}C${f(x + k)} ${f(y + r)} ${f(x + r)} ${f(y + k)} ${f(x + r)} ${f(y)}Z`;
  let d = "";
  for (const stroke of strokes.split("|")) {
    const points = stroke.split(" ").map((p) => p.split(",").map(Number));
    points.forEach(([x, y], i) => {
      d += disc(x, y);
      if (!i) return;
      const [px, py] = points[i - 1];
      const length = Math.hypot(x - px, y - py);
      if (!length) return;
      const [nx, ny] = [(-(y - py) / length) * r, ((x - px) / length) * r];
      d += `M${f(px + nx)} ${f(py + ny)}L${f(x + nx)} ${f(y + ny)}L${f(x - nx)} ${f(y - ny)}L${f(px - nx)} ${f(py - ny)}Z`;
    });
  }
  return d;
}
const SENTENCES = [
  "A quadratic function has the form f(x) = ax2 + bx + c, where a is not zero.",
  "Its graph is a parabola that opens upwards when a is positive and downwards when a is negative.",
  "The vertex form f(x) = a(x - d)2 + e shows the vertex s(d, e) at a glance.",
  "Completing the square turns the general form into the vertex form.",
  "The discriminant d = b2 - 4ac tells how many zeros the function has.",
  "The axis of symmetry runs through the vertex, parallel to the y-axis, at x = -b / (2a).",
  "Shifting the graph by d to the right replaces x with x - d in the equation.",
  "Read the task twice, name the unknown, and write down what is given before any calculation.",
];
let printing = false; // while the window that prints the book below is open
/** A book of `count` large pages on which every letter is a shape, printed to PDF by Chromium. */
async function outlinedPdf(count) {
  const [w, h, unit, perLine] = [1240, 1754, 2.6, 64];
  const pages = [];
  let paths = 0;
  for (let n = 0; n < count; n++) {
    const words = Array.from({ length: 60 }, (_, i) => SENTENCES[(n * 3 + i * 5) % SENTENCES.length]).join(" ").toUpperCase().split(" ");
    const lines = [`${n + 1}  FUNCTIONS`, ""];
    for (const word of words) {
      if ((lines[lines.length - 1] + " " + word).length > perLine) lines.push("");
      lines[lines.length - 1] = (lines[lines.length - 1] + " " + word).trim();
    }
    let uses = "";
    lines.slice(0, 52).forEach((line, row) => {
      [...line].forEach((ch, col) => {
        if (!STROKES[ch]) return;
        paths++;
        uses += `<use href="#g${ch.charCodeAt(0)}" transform="translate(${(110 + col * 6 * unit).toFixed(1)} ${(120 + row * 11.5 * unit).toFixed(1)}) scale(${unit})"/>`;
      });
    });
    pages.push(`<svg viewBox="0 0 ${w} ${h}">${uses}</svg>`);
  }
  const defs = Object.entries(STROKES).map(([ch, strokes]) => `<path id="g${ch.charCodeAt(0)}" d="${shapeOf(strokes)}"/>`).join("");
  const file = path.join(userData, "outlined.html");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>@page{size:${w}pt ${h}pt;margin:0}html,body{margin:0}svg{display:block;width:${w}pt;height:${h}pt;break-after:page}</style><svg width="0" height="0" style="position:absolute"><defs>${defs}</defs></svg>${pages.join("")}`);
  printing = true;
  const printer = hiddenWindow(900, 700, { sandbox: true, javascript: false });
  await printer.loadFile(file);
  const data = await printer.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
  printer.destroy();
  printing = false;
  return { data, paths: Math.round(paths / count) };
}

// ------------------------------------------------------------ in the app's page

/** Runs in the app's page: mounts the panel over it and gives the test its hands and eyes. */
async function pageSide() {
  const { html, render } = await import("./bits.js");
  const { Book } = await import("./book.js");
  const host = document.createElement("aside");
  host.className = "side";
  Object.assign(host.style, { position: "fixed", zIndex: 1000, left: "20px", top: "20px", width: "600px", height: "760px", margin: 0 });
  document.body.append(host);
  let props = {};
  let log = [];
  const show = (next) => {
    props = { ...props, ...next };
    // like the exam screen: what the panel reports comes back as its `page`
    render(html`<${Book} ...${props} onPage=${(n) => (log.push(n), show({ page: n }))} />`, host);
  };
  const box = () => host.querySelector(".book-page");
  const leaf = (n) => host.querySelector(`.leaf[data-page="${n}"]`);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Waits until what is in view is drawn, or cannot be. With `page`: until that page is the one on top. */
  const settled = async (page = 0, ms = 20000) => {
    const end = performance.now() + ms;
    if (!page) await pause(80); // a scroll or a click only shows with the next frame
    while (performance.now() < end) {
      const b = box();
      if (b && b.dataset.state !== "loading" && (!page || b.dataset.state === "failed" || Number(b.dataset.page) === page)) return b.dataset.state;
      await pause(page ? 4 : 20);
    }
    return "timeout";
  };
  /**
   * A grid of pixels of a page's picture: the share that is not white, how far the lightest
   * and the darkest are apart (0 on a page that came out empty), and one pixel's colour.
   */
  const look = (n, at) => {
    const canvas = leaf(n) && leaf(n).querySelector("canvas");
    if (!canvas || !canvas.width) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    let seen = 0;
    let [light, dark] = [0, 765];
    for (let y = 2; y < canvas.height; y += 5) {
      for (let x = 2; x < canvas.width; x += 5) {
        const i = (y * canvas.width + x) * 4;
        const sum = data[i] + data[i + 1] + data[i + 2];
        seen++;
        if (sum < 600) ink++;
        light = Math.max(light, sum);
        dark = Math.min(dark, sum);
      }
    }
    const p = at ? (Math.round(canvas.height * at[1]) * canvas.width + Math.round(canvas.width * at[0])) * 4 : 0;
    return { ink: ink / seen, contrast: light - dark, pixel: [data[p], data[p + 1], data[p + 2]], width: canvas.width, height: canvas.height };
  };
  window.__book = {
    /** Opens a book; resolves to the state and to how long it took until the page asked for was drawn. */
    async open(material, page) {
      render(null, host);
      props = {};
      log = [];
      const start = performance.now();
      show({ material, page, jump: 0 });
      const state = await settled(page);
      return { state, ms: Math.round(performance.now() - start) };
    },
    /** Asks for a page the way a step in the plan does. */
    async jump(page, more = {}) {
      const same = box() && Number(box().dataset.page) === page;
      const start = performance.now();
      show({ ...more, page, jump: props.jump + 1 });
      const state = await settled(same ? 0 : page);
      return { state, ms: Math.round(performance.now() - start), sheet: leaf(page) ? leaf(page).dataset.state : "none" };
    },
    /**
     * Scrolls on step by step, like a person reading fast. Tells how many pictures were alive
     * at most, how long the page's own thread was stuck at worst, and after how many of the
     * steps the view was not yet drawn when the next one came.
     */
    async travel(steps, by, wait) {
      const most = { canvases: 0, leaves: 0, megapixels: 0, stuck: 0, behind: 0 };
      let last = performance.now();
      const clock = setInterval(() => {
        most.stuck = Math.max(most.stuck, Math.round(performance.now() - last - 4));
        last = performance.now();
      }, 4);
      for (let i = 0; i < steps; i++) {
        box().scrollTop += by;
        await pause(wait);
        if (box().dataset.state === "loading") most.behind++;
        const pictures = [...host.querySelectorAll("canvas")];
        most.canvases = Math.max(most.canvases, pictures.length);
        most.leaves = Math.max(most.leaves, host.querySelectorAll(".leaf").length);
        most.megapixels = Math.max(most.megapixels, Math.round(pictures.reduce((sum, c) => sum + c.width * c.height, 0) / 1e5) / 10);
      }
      clearInterval(clock);
      return { ...most, state: await settled() };
    },
    /** Clicks a zoom button `times` times; resolves to how long the new pictures took. */
    async zoom(selector, times) {
      const start = performance.now();
      for (let i = 0; i < times; i++) host.querySelector(selector).click();
      while (box().dataset.state === "loading" && performance.now() - start < 20000) await pause(4);
      return Math.round(performance.now() - start);
    },
    close: () => render(null, host),
    resize(width) {
      host.style.width = `${width}px`;
    },
    settled,
    pause,
    look,
    log: () => log.slice(),
    scrollTo(y) {
      box().scrollTop = y;
    },
    scrollBy(dy) {
      box().scrollTop += dy;
    },
    click: (selector) => host.querySelector(selector).click(),
    /** Where things are, as the person would see them. */
    facts() {
      const b = box();
      const top = (n) => (leaf(n) ? Math.round(leaf(n).getBoundingClientRect().top - b.getBoundingClientRect().top) : null);
      const leaves = [...host.querySelectorAll(".leaf")];
      return {
        state: b.dataset.state,
        page: Number(b.dataset.page),
        top: top(Number(b.dataset.page)),
        head: host.querySelector(".side-head").textContent.replace(/\s+/g, " ").trim(),
        pager: (host.querySelector(".pager") || { textContent: "" }).textContent.replace(/\s+/g, " ").trim(),
        zoom: (host.querySelector(".zoom small") || { textContent: "" }).textContent,
        note: [...b.querySelectorAll("p")].map((p) => p.textContent).join(" | "),
        scrollTop: b.scrollTop,
        height: b.clientHeight,
        wider: b.scrollWidth - b.clientWidth,
        leaves: leaves.length,
        canvases: host.querySelectorAll("canvas").length,
        megapixels: [...host.querySelectorAll("canvas")].reduce((sum, c) => sum + c.width * c.height, 0) / 1e6,
        live: host.querySelectorAll("a, iframe, embed, object, input, .annotationLayer, .textLayer").length,
        shapes: leaves.map((l) => `${l.dataset.page}:${l.dataset.state}`).join(" "),
        headFits: host.querySelector(".side-head").scrollWidth <= host.querySelector(".side-head").clientWidth,
        smallPrint: [...host.querySelectorAll(".side-head small")].filter((el) => el.offsetWidth > 0).length,
        rect: (({ left, top: y, width, height }) => ({ x: left, y, width, height }))(host.getBoundingClientRect()),
        ratio: window.devicePixelRatio,
      };
    },
    topOf: (n) => (leaf(n) ? leaf(n).offsetTop : null),
    /** How far below the top of the view a page starts. */
    below: (n) => (leaf(n) ? leaf(n).getBoundingClientRect().top - box().getBoundingClientRect().top : null),
    sizeOf: (n) => (leaf(n) ? [leaf(n).offsetWidth, leaf(n).offsetHeight] : null),
  };
  return true;
}

// ------------------------------------------------------------ the checks

const failures = [];
let checks = 0;
const check = (ok, what, detail = "") => {
  checks++;
  if (!ok) failures.push(`${what}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const lines = [];
const note = (text) => (lines.push(text), console.log(text));

app.whenReady().then(async () => {
  const win = await window;
  const SCALE = 2; // a Retina screen
  win.setContentSize(680 * SCALE, 800 * SCALE);
  const errors = [];
  // (the missing file further down is meant to fail to load)
  win.webContents.on("console-message", (e) => e.level === "error" && /book|pdf/i.test(e.message + e.sourceId) && !/Failed to load resource/.test(e.message) && errors.push(e.message));
  // what a link or a script in a PDF could do if it were alive: leave the page, open a window
  let left = 0;
  win.webContents.on("will-navigate", () => left++);
  win.webContents.on("did-create-window", () => left++);
  app.on("browser-window-created", () => !printing && left++);
  const js = (code) => win.webContents.executeJavaScript(code);
  const call = (name, ...values) => js(`window.__book.${name}(${values.map((v) => JSON.stringify(v)).join(", ")})`);
  const facts = () => call("facts");
  const memory = () => {
    const tab = app.getAppMetrics().find((m) => m.pid === win.webContents.getOSProcessId());
    return tab ? Math.round(tab.memory.workingSetSize / 1024) : 0;
  };
  setTimeout(() => {
    console.log("FAIL: the run took longer than five minutes");
    app.exit(1);
  }, 300000).unref();

  await new Promise((done) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", done) : done()));
  win.webContents.setZoomFactor(SCALE);
  await js(`(${pageSide})()`);

  // Books go into the library once the app has swept it (it removes what no exam uses when it starts).
  const library = path.join(userData, "library");
  fs.mkdirSync(library, { recursive: true });
  const add = (data) => {
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    fs.writeFileSync(path.join(library, `${hash}.pdf`), data);
    return hash;
  };
  const link = (file) => {
    const hasher = crypto.createHash("sha256");
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(1 << 22);
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length)) > 0; ) hasher.update(buffer.subarray(0, n));
    fs.closeSync(fd);
    const hash = hasher.digest("hex");
    if (!fs.existsSync(path.join(library, `${hash}.pdf`))) fs.symlinkSync(file, path.join(library, `${hash}.pdf`));
    return hash;
  };
  const material = (title, hash, pages, offset = 0) => ({ id: title, hash, title, pages, offset, type: "pdf" });
  const open = (m, page = 1) => call("open", m, page);
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { rect } = await facts();
    const area = { x: Math.round(rect.x * SCALE), y: Math.round(rect.y * SCALE), width: Math.round(rect.width * SCALE), height: Math.round(rect.height * SCALE) };
    await win.webContents.capturePage(area, { stayHidden: true });
    await sleep(300);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage(area, { stayHidden: true })).toPNG());
  };
  const GAP = 12; // the field above a page that was jumped to (see ui/book.js)
  const atTop = (f) => f.top !== null && Math.abs(f.top - (f.page === 1 ? 14 : GAP)) <= 2;

  try {
    // The CSP the panel runs under: nothing may be evaluated, nothing comes from elsewhere.
    const csp = (fs.readFileSync(path.join(__dirname, "..", "ui", "index.html"), "utf8").match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || "";
    check(/script-src 'self'(;|$)/.test(csp) && !/unsafe-eval|https?:|\*/.test(csp), "the CSP allows scripts from the app only", csp);

    // ---- letters as shapes
    const outlined = await outlinedPdf(5);
    let m = material("Outlined book", add(outlined.data), 5);
    let run = await open(m);
    let f = await facts();
    let seen = await call("look", 1);
    check(run.state === "shown" && seen && seen.ink > 0.01 && seen.ink < 0.6, "letters as shapes: the first page is drawn", { state: run.state, seen });
    check(f.pager.includes("/ 5"), "letters as shapes: five pages", f.pager);
    const sheet = await call("sizeOf", 1);
    check(seen && sheet && f.ratio === SCALE && Math.abs(seen.width - sheet[0] * SCALE) <= 2, "the picture is as sharp as the screen", { picture: seen && seen.width, sheet, ratio: f.ratio });
    let jumped = await call("jump", 4);
    f = await facts();
    seen = await call("look", 4);
    check(jumped.state === "shown" && f.page === 4 && atTop(f) && seen && seen.ink > 0.01, "letters as shapes: a jump to page 4", { f, seen });
    note(`letters as shapes   ${outlined.paths} shapes a page, ${(outlined.data.length / 1e6).toFixed(1)} MB: first page after ${run.ms} ms, jump to page 4 after ${jumped.ms} ms`);
    await shot("outlined");

    // ---- scanned books
    const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "book", name));
    const SCAN = { w: 1240, h: 1754, dpi: 150 };
    const bilevel = "/ColorSpace /DeviceGray /BitsPerComponent 1";
    const scans = {
      "JPEG 2000": scanPdf(3, SCAN, "/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode", fixture("scan.jp2")),
      JBIG2: scanPdf(3, SCAN, `${bilevel} /Filter /JBIG2Decode`, fixture("scan.jb2")),
      "JBIG2 with symbols": scanPdf(3, SCAN, `${bilevel} /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 6 0 R >>`, fixture("scan-symbols.jb2"), [stream("", fixture("scan-symbols.globals"))]),
      "CCITT G4": scanPdf(3, SCAN, `${bilevel} /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${SCAN.w} /Rows ${SCAN.h} /BlackIs1 true >>`, fixture("scan.g4")),
    };
    const scanned = {};
    for (const [codec, data] of Object.entries(scans)) {
      m = material(`Scan, ${codec}`, (scanned[codec] = add(data)), 3);
      run = await open(m);
      seen = await call("look", 1);
      // dark letters on light paper: a picture that was not decoded is all white or all black
      check(run.state === "shown" && seen && seen.ink > 0.01 && seen.ink < 0.3, `scan in ${codec}: the first page is drawn`, { state: run.state, seen });
      jumped = await call("jump", 3);
      f = await facts();
      seen = await call("look", 3);
      check(jumped.state === "shown" && f.page === 3 && seen && seen.ink > 0.01 && seen.ink < 0.3, `scan in ${codec}: page 3 after a jump`, { f, seen });
      note(`scan, ${(codec + ":").padEnd(19)} first page after ${run.ms} ms, jump to page 3 after ${jumped.ms} ms`);
      if (codec === "JPEG 2000") await shot("scan");
    }

    // ---- what else is vendored beside pdf.js: character maps and colour profiles
    run = await open(material("Other scripts, other colours", add(specialPdf()), 2));
    seen = await call("look", 1);
    check(run.state === "shown" && seen && seen.ink > 0.004, "Japanese text in a font that is not in the file is drawn", { state: run.state, seen });
    await shot("japanese");
    await call("jump", 2);
    seen = await call("look", 2, [0.5, 0.4]);
    check(seen && seen.pixel[0] < 110 && seen.pixel[2] > 140, "a CMYK colour comes out as cyan", seen);

    // ---- a long book: jumping, scrolling, zoom, what stays in memory
    const long = longPdf(500);
    m = material("Long book", add(long), 500, 10);
    const pageOf = (pixel) => (pixel[0] >> 4) + ((pixel[1] >> 4) << 4) + ((pixel[2] >> 4) << 8);
    const square = [0.225, 0.2];
    run = await open(m);
    seen = await call("look", 1, square);
    check(run.state === "shown" && seen && pageOf(seen.pixel) === 1, "long book: opens at page 1", { state: run.state, seen });
    check((await facts()).live === 0, "nothing in the panel can be clicked or typed into");

    jumped = await call("jump", 415);
    f = await facts();
    seen = await call("look", 415, square);
    check(jumped.state === "shown" && jumped.sheet === "drawn" && f.page === 415 && atTop(f), "a jump puts page 415 at the top", { jumped, f });
    check(seen && pageOf(seen.pixel) === 415, "what is drawn there is page 415", seen);
    check(f.pager.includes("p. 405") && f.pager.includes("415/500"), "the head tells the printed page and the place in the file", f.pager);
    check((await call("log")).length === 0, "a jump the app asked for is not reported back as scrolling", await call("log"));
    note(`long book           500 pages of three sizes: first page after ${run.ms} ms, jump to page 415 after ${jumped.ms} ms`);

    // pages of other sizes around it are measured only now: the page asked for must stay put
    await sleep(500);
    f = await facts();
    check(f.page === 415 && atTop(f), "page 415 stays at the top while its neighbours are measured", f);
    const [a4, wide, tall] = [await call("sizeOf", 416), await call("sizeOf", 415), await call("sizeOf", 413)];
    check(wide && a4 && tall && wide[1] < wide[0] && a4[1] > a4[0] && tall[1] > a4[1] * 1.3 && wide[0] === a4[0], "pages of different sizes each fill the width", { a4, wide, tall });

    // the same page again, after scrolling a little: back to its top
    await call("scrollBy", 180);
    await sleep(250);
    check(!atTop(await facts()), "scrolling moves the page");
    await call("jump", 415);
    f = await facts();
    check(f.page === 415 && atTop(f), "asking for the same page again scrolls back to its top", f);

    // scrolling: the page on top is reported, once, and the panel does not pull back to its top
    const before = (await call("log")).length;
    const target = (await call("topOf", 417)) + 300;
    await call("scrollTo", (await call("topOf", 416)) + 100);
    await sleep(150);
    await call("scrollTo", target);
    await call("settled");
    await sleep(300);
    f = await facts();
    const log = (await call("log")).slice(before);
    check(f.page === 417 && log[log.length - 1] === 417, "scrolling reports the page that fills the view", { page: f.page, log });
    check(log.every((n, i) => n !== log[i - 1]) && log.length <= 3, "each page is reported once", log);
    check(Math.abs(f.scrollTop - target) < 2, "what is reported does not move the view", { scrollTop: f.scrollTop, target });
    check(f.pager.includes("417/500"), "the head follows", f.pager);

    // the buttons in the head
    await call("click", ".pager .mini.flip");
    await call("settled");
    f = await facts();
    check(f.page === 418 && atTop(f) && (await call("log")).pop() === 418, "the next button goes to the top of the next page", f);
    await call("click", ".pager .mini");
    await call("settled");
    f = await facts();
    check(f.page === 417 && atTop(f), "the back button goes to the top of the page before", f);

    // zoom
    const plain = await call("look", 417);
    await call("click", ".zoom .mini:last-child");
    await call("settled");
    f = await facts();
    let zoomed = await call("look", 417);
    check(zoomed && plain && Math.abs(zoomed.width / plain.width - 1.25) < 0.01 && f.zoom === "125%", "zooming in draws a larger picture", { plain: plain && plain.width, zoomed: zoomed && zoomed.width, zoom: f.zoom });
    check(f.wider > 100 && f.page === 417 && atTop(f), "the zoomed page is wider than the panel and stays in place", f);
    await call("click", ".zoom .mini:last-child");
    await call("click", ".zoom .mini:last-child");
    await call("settled");
    f = await facts();
    zoomed = await call("look", 417);
    check(zoomed && Math.abs(zoomed.width / plain.width - 2) < 0.01 && f.zoom === "200%", "zoom goes up to twice the width", { zoomed: zoomed && zoomed.width, zoom: f.zoom });
    check(pageOf((await call("look", 417, square)).pixel) === 417, "the zoomed picture is the same page");
    await shot("long-zoomed");
    for (let i = 0; i < 3; i++) await call("click", ".zoom .mini");
    await call("settled");
    f = await facts();
    check(f.zoom === "100%" && f.wider <= 0 && (await call("look", 417)).width === plain.width, "zooming out comes back to the width of the panel", f);

    // the panel made narrower and wider again, as when the divider is dragged
    await call("resize", 440);
    await call("settled");
    f = await facts();
    let size = await call("sizeOf", 417);
    seen = await call("look", 417);
    check(f.page === 417 && atTop(f) && size[0] < 420 && seen && Math.abs(seen.width - size[0] * SCALE) <= 2, "a narrower panel: the page keeps its place and is drawn anew for that width", { f, size, seen });
    await call("scrollBy", Math.round(size[1] * 0.5));
    await sleep(200);
    const part = (await call("below", 417)) / size[1];
    await call("resize", 600);
    await call("settled");
    size = await call("sizeOf", 417);
    const partNow = (await call("below", 417)) / size[1];
    check(part < -0.4 && Math.abs(partNow - part) < 0.01, "a wider panel: the same part of the page stays in view", { part, partNow, size });
    await call("resize", 320);
    await call("settled");
    f = await facts();
    check(f.state === "shown" && f.headFits && f.smallPrint === 0, "in the narrowest panel the head fits, without its small print", f);
    await shot("narrow");
    await call("resize", 600);
    await call("jump", 417);

    // a long way through the book: few pictures are kept, whatever was passed
    const memoryBefore = memory();
    let most = await call("travel", 160, 520, 35);
    f = await facts();
    seen = await call("look", f.page, square);
    check(most.state === "shown" && f.page > 480 && seen && pageOf(seen.pixel) === f.page, "after a long scroll the page in view is drawn, and is the right one", { most, page: f.page, seen });
    check(most.canvases <= 8 && most.leaves <= 9, "only the pages around the view are kept", most);
    note(`long book           ${f.page - 417} pages scrolled: at most ${most.canvases} pictures alive (${most.megapixels} megapixels), renderer ${memoryBefore} MB before and ${memory()} MB after`);
    // a pull on the scroll bar: far away at once
    await call("scrollTo", 0);
    await call("settled");
    f = await facts();
    check(f.page === 1 && f.state === "shown" && pageOf((await call("look", 1, square)).pixel) === 1, "back at the start in one move", f);

    // another book in the same panel, the way a step that is in another book asks for it
    jumped = await call("jump", 2, { material: material("Another book", scanned.JBIG2, 3) });
    f = await facts();
    seen = await call("look", 2);
    check(jumped.state === "shown" && f.page === 2 && f.head.startsWith("Another book") && f.pager.includes("/ 3") && f.leaves <= 3 && seen && seen.ink > 0.01, "another book takes over the panel", { f, seen });
    jumped = await call("jump", 120, { material: m });
    f = await facts();
    check(jumped.state === "shown" && f.page === 120 && pageOf((await call("look", 120, square)).pixel) === 120, "and back to the first book, at another page", f);
    await call("jump", 1);

    // another screen: sharper or coarser pictures
    win.webContents.setZoomFactor(1);
    await sleep(600);
    await call("settled");
    seen = await call("look", 1);
    check(seen && Math.abs(seen.width - (await call("sizeOf", 1))[0]) <= 2, "on a coarser screen the pictures are drawn anew", seen && seen.width);
    win.webContents.setZoomFactor(SCALE);
    await sleep(600);
    await call("settled");
    await call("click", `.leaf[data-page="1"]`);
    await sleep(200);
    check(left === 0, "the link and the script in the PDF did nothing", { left });

    // ---- books that cannot be shown
    run = await open(material("Locked", add(lockedPdf("open sesame")), 3));
    f = await facts();
    check(run.state === "failed" && /password/i.test(f.note) && f.leaves === 0 && f.pager === "", "a PDF with a password: a sentence says so", f);
    await shot("locked");
    run = await open(material("No PDF", add(Buffer.from("%PDF-1.7\n" + "this is not a book at all\n".repeat(200))), 3));
    f = await facts();
    check(run.state === "failed" && /damaged/i.test(f.note) && f.leaves === 0, "a damaged file: a sentence says so", f);
    run = await open(material("Gone", "0".repeat(64), 3));
    f = await facts();
    check(run.state === "failed" && f.note.length > 10 && f.leaves === 0, "a file that is gone: a sentence says so", f);
    // cut off in the middle: what is left of it is shown, the pages that are lost say so
    run = await open(material("Cut off", add(long.subarray(0, Math.floor(long.length * 0.5))), 500), 2);
    f = await facts();
    seen = await call("look", 2, square);
    const whole = run.state === "shown" && seen && pageOf(seen.pixel) === 2;
    check(whole || (run.state === "failed" && f.note.length > 10), "a file cut off in the middle: page 2 or a sentence", { state: run.state, f });
    if (whole) {
      const lost = await call("jump", 480);
      f = await facts();
      check(lost.state === "failed" && f.note.length > 10, "a file cut off in the middle: a page that is lost says so", { lost, f });
    }
    // one damaged spot: the pages before it are there, the page itself says that it cannot be shown
    run = await open(material("Damaged spot", add(longPdf(6, { lost: 4 })), 6), 3);
    f = await facts();
    seen = await call("look", 3, square);
    check(run.state === "shown" && seen && pageOf(seen.pixel) === 3, "a damaged spot: the page before it is drawn", { state: run.state, f, seen });
    jumped = await call("jump", 4);
    f = await facts();
    check(jumped.state === "failed" && f.shapes.includes("4:failed") && f.shapes.includes("3:drawn") && f.note.length > 10, "a damaged spot: the page itself says that it cannot be shown", { jumped, f });
    await shot("lost-page");

    // ---- the person's own books
    const own = folder ? fs.readdirSync(folder).filter((name) => name.toLowerCase().endsWith(".pdf")).sort() : [];
    for (const name of own) {
      const file = path.join(folder, name);
      const title = path.basename(name, path.extname(name));
      const megabytes = (fs.statSync(file).size / 1e6).toFixed(1);
      const hash = link(file);
      // how many pages it has is not known here: the panel finds out and tells in its head
      run = await open(material(title, hash, 1));
      f = await facts();
      if (run.state === "failed" && f.leaves === 0) {
        check(f.note.length > 10 && f.pager === "", `${name}: cannot be opened, and a sentence says so`, f);
        note(`${name} (${megabytes} MB): "${f.note}" after ${run.ms} ms`);
        continue;
      }
      const count = Number((f.pager.match(/(\d+)$/) || [])[1]) || 0;
      seen = await call("look", 1);
      check(run.state === "shown" && count > 0 && seen, `${name}: opens`, { state: run.state, pager: f.pager, seen });
      let line = `${name} (${megabytes} MB, ${count} pages): first page after ${run.ms} ms`;
      const page = count >= 415 ? 415 : Math.ceil(count / 2);
      jumped = await call("jump", page, { material: material(title, hash, count) });
      f = await facts();
      seen = await call("look", page);
      check(jumped.state === "shown" && jumped.sheet === "drawn" && f.page === page && (atTop(f) || page === count) && seen && seen.contrast > 60, `${name}: page ${page} is drawn`, { jumped, page: f.page, top: f.top, seen });
      await shot(title.replace(/[^\w-]+/g, "-").toLowerCase());
      if (page > 1) line += `, page ${page} after ${jumped.ms} ms`;
      if (count > 3) {
        const other = page > 200 ? page - 200 : 1;
        jumped = await call("jump", other);
        f = await facts();
        seen = await call("look", other);
        check(jumped.state === "shown" && jumped.sheet === "drawn" && f.page === other && seen && seen.contrast > 60, `${name}: a jump to page ${other}`, { jumped, page: f.page, seen });
        line += `, jump to page ${other} after ${jumped.ms} ms`;
        const steps = Math.min(120, count * 2);
        most = await call("travel", steps, 500, 50);
        f = await facts();
        seen = await call("look", f.page);
        check(most.state === "shown" && f.page !== other && seen && seen.contrast > 60 && (await call("log")).pop() === f.page, `${name}: scrolling on, page ${f.page} is drawn and reported`, { most, f, seen });
        check(most.canvases <= 8, `${name}: only the pages around the view are kept`, most);
        line += `; ${f.page - other} pages scrolled in ${steps} steps: ${most.behind} times the view was not drawn 50 ms after a step, the page's thread was stuck ${most.stuck} ms at worst, at most ${most.canvases} pictures alive (${most.megapixels} megapixels)`;
      }
      const narrow = await call("look", (await facts()).page);
      const zoomMs = await call("zoom", ".zoom .mini:last-child", 2);
      f = await facts();
      zoomed = await call("look", f.page);
      check(zoomed && narrow && zoomed.width > narrow.width * 1.4 && zoomed.contrast > 60, `${name}: zoom draws a larger picture`, { narrow: narrow && narrow.width, zoomed: zoomed && zoomed.width });
      line += `; zoom to 150% after ${zoomMs} ms; renderer ${memory()} MB`;
      await shot(`${title.replace(/[^\w-]+/g, "-").toLowerCase()}-zoomed`);
      await call("zoom", ".zoom .mini", 2);
      note(line);
    }

    await call("close");
    check(errors.length === 0, "no errors in the page", errors.slice(0, 3));
  } catch (err) {
    failures.push(`the run stopped: ${err && err.stack ? err.stack.split("\n").slice(0, 4).join(" ") : err}`);
  }

  fs.rmSync(userData, { recursive: true, force: true });
  if (failures.length) {
    console.log(`FAILED: ${failures.length} of ${checks} checks`);
    for (const failure of failures) console.log(" -", failure);
    app.exit(1);
  } else {
    console.log(`ok: ${checks} checks`);
    app.exit(0);
  }
});

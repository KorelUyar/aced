// PowerPoint (.pptx, .ppsx, .potx) to pages: one page per slide, as large as the slide, with
// its text boxes, pictures and tables where the slide has them, and formulas. The AI reads
// slide N as page N.
const X = require("./xml");
const zip = require("./zip");
const M = require("./math");
const { relsOf, mainPart } = require("./docx");
const { esc, documentOf, picture } = require("./page");

const EMU_PER_PT = 12700;
const coded = (code) => Object.assign(new Error(code), { code });

function convert(file) {
  const archive = zip.open(file);
  try {
    return read(archive);
  } finally {
    archive.close();
  }
}

function read(archive) {
  const pres = mainPart(archive, "ppt/presentation.xml");
  if (!archive.has(pres)) throw coded("damaged");
  const rels = relsOf(archive, pres);
  const root = X.parse(archive.text(pres));
  const size = X.first(root, "sldSz");
  const W = Number(X.attr(size, "cx")) / EMU_PER_PT || 720;
  const H = Number(X.attr(size, "cy")) / EMU_PER_PT || 540;
  let pictureBytes = 0;
  let missing = 0;

  const slides = [];
  for (const id of X.all(X.first(root, "sldIdLst"), "sldId")) {
    // Each entry has an id of its own and one ("r:id") that names the slide's part.
    const rid = Object.entries(id.attrs).find(([k]) => /:id$/.test(k));
    const rel = rid && rels.get(rid[1]);
    if (rel && rel.target && archive.has(rel.target)) slides.push(rel.target);
  }

  // Placeholders without a place of their own take it from the slide's layout, or the layout's master.
  const placesCache = new Map();
  function places(part) {
    if (placesCache.has(part)) return placesCache.get(part);
    const map = new Map();
    placesCache.set(part, map);
    if (!archive.has(part)) return map;
    const tree = X.parse(archive.text(part));
    for (const sp of X.all(tree, "sp")) {
      const ph = X.first(X.kid(sp, "nvSpPr"), "ph");
      const xfrm = X.first(X.kid(sp, "spPr"), "xfrm");
      if (!ph || !xfrm) continue;
      const box = boxOf(xfrm);
      const type = X.attr(ph, "type") || "body";
      if (X.attr(ph, "idx")) map.set("idx:" + X.attr(ph, "idx"), box);
      if (!map.has("type:" + type)) map.set("type:" + type, box);
    }
    const parent = [...relsOf(archive, part).values()].find((r) => /slide(Layout|Master)$/.test(r.type) && r.target !== part);
    if (parent && parent.target) {
      for (const [k, v] of places(parent.target)) if (!map.has(k)) map.set(k, v);
    }
    return map;
  }

  function boxOf(xfrm) {
    const off = X.kid(xfrm, "off");
    const ext = X.kid(xfrm, "ext");
    return {
      x: Number(X.attr(off, "x") || 0) / EMU_PER_PT,
      y: Number(X.attr(off, "y") || 0) / EMU_PER_PT,
      w: Number(X.attr(ext, "cx") || 0) / EMU_PER_PT,
      h: Number(X.attr(ext, "cy") || 0) / EMU_PER_PT,
    };
  }

  function slideHtml(part, number) {
    const slideRels = relsOf(archive, part);
    const layout = [...slideRels.values()].find((r) => /slideLayout$/.test(r.type));
    const inherited = layout && layout.target ? places(layout.target) : new Map();
    const tree = X.parse(archive.text(part));
    const shapes = [];

    const image = (rId) => {
      const rel = slideRels.get(rId);
      if (!rel || !rel.target || !archive.has(rel.target) || pictureBytes > 60 * 1024 * 1024) {
        missing++;
        return "";
      }
      try {
        const bytes = archive.read(rel.target, 24 * 1024 * 1024);
        pictureBytes += bytes.length;
        const tag = picture(bytes, rel.target, "", "width:100%;height:100%;object-fit:contain");
        if (!tag) missing++;
        return tag || "";
      } catch {
        missing++;
        return "";
      }
    };

    function paragraphs(txBody, placeholder) {
      const out = [];
      const base = placeholder === "title" || placeholder === "ctrTitle" ? 30 : placeholder === "subTitle" ? 20 : 18;
      const counters = [];
      for (const p of X.kids(txBody, "p")) {
        const pPr = X.kid(p, "pPr");
        const lvl = Number(X.attr(pPr, "lvl") || 0);
        let html = "";
        let size = 0;
        for (const r of X.kids(p)) {
          if (r.local === "r" || r.local === "fld") {
            const rPr = X.kid(r, "rPr");
            let t = esc(X.text(X.kid(r, "t")));
            const sz = Number(X.attr(rPr, "sz") || 0);
            if (sz) size = Math.max(size, sz / 100);
            if (X.attr(rPr, "b") === "1") t = `<b>${t}</b>`;
            if (X.attr(rPr, "i") === "1") t = `<i>${t}</i>`;
            const baseline = Number(X.attr(rPr, "baseline") || 0);
            if (baseline > 0) t = `<sup>${t}</sup>`;
            if (baseline < 0) t = `<sub>${t}</sub>`;
            html += t;
          } else if (r.local === "br") html += "<br>";
          else if (r.local === "AlternateContent" || r.local === "m" || r.local === "oMathPara" || r.local === "oMath") {
            // A formula (PowerPoint keeps Word's format for it inside a newer element).
            const math = X.first(r, "oMathPara") || X.first(r, "oMath") || (r.local === "oMath" || r.local === "oMathPara" ? r : null);
            // In the line, at the size of the slide's text (a formula of its own would be body-sized).
            if (math) html += M.marked({ ...M.fromOmml(math), a: {} });
            else html += X.kids(X.kid(r, "Fallback") || r).map((k) => (k.local === "r" ? esc(X.text(X.kid(k, "t"))) : "")).join("");
          }
        }
        if (!html.trim()) {
          out.push('<p class="gap"></p>');
          continue;
        }
        // Bullets and numbers as the slide shows them, where the slide says so.
        let mark = "";
        if (X.kid(pPr, "buAutoNum")) {
          counters[lvl] = (counters[lvl] || Number(X.attr(X.kid(pPr, "buAutoNum"), "startAt") || 1) - 1) + 1;
          const scheme = X.attr(X.kid(pPr, "buAutoNum"), "type") || "arabicPeriod";
          const n = counters[lvl];
          const letter = String.fromCharCode(96 + (((n - 1) % 26) + 1));
          mark = /alphaLc/.test(scheme) ? letter : /alphaUc/.test(scheme) ? letter.toUpperCase() : String(n);
          mark += /Paren(R|Both)/.test(scheme) ? ")" : /Period/.test(scheme) ? "." : "";
        } else if (X.kid(pPr, "buChar")) mark = X.attr(X.kid(pPr, "buChar"), "char") || "•";
        else if (!X.kid(pPr, "buNone") && placeholder === "body" && lvl >= 0) mark = "•";
        const fontSize = size || Math.max(10, base - lvl * 2);
        out.push(`<p style="font-size:${fontSize}pt;margin-left:${lvl * 18 + (mark ? 16 : 0)}pt${mark ? ";text-indent:-14pt" : ""}">${mark ? `<span>${esc(mark)}</span>&nbsp;` : ""}${html}</p>`);
      }
      return out.join("");
    }

    function table(tbl) {
      return `<table>${X.kids(tbl, "tr")
        .map((tr) => `<tr>${X.kids(tr, "tc").filter((tc) => !["1", "true"].includes(X.attr(tc, "hMerge")) && !["1", "true"].includes(X.attr(tc, "vMerge"))).map((tc) => {
          const span = Number(X.attr(tc, "gridSpan") || 1);
          const rows = Number(X.attr(tc, "rowSpan") || 1);
          return `<td${span > 1 ? ` colspan="${span}"` : ""}${rows > 1 ? ` rowspan="${rows}"` : ""}>${paragraphs(X.kid(tc, "txBody"), "cell")}</td>`;
        }).join("")}</tr>`)
        .join("")}</table>`;
    }

    // `map` turns a box inside a group into the slide's own measures.
    function walk(tree, map) {
      for (const node of X.kids(tree)) {
        if (node.local === "AlternateContent") {
          walk(X.kid(node, "Choice") || X.kid(node, "Fallback") || node, map);
          continue;
        }
        if (node.local === "grpSp") {
          const xfrm = X.first(X.kid(node, "grpSpPr"), "xfrm");
          if (!xfrm) {
            walk(node, map);
            continue;
          }
          const outer = map(boxOf(xfrm));
          const chOff = X.kid(xfrm, "chOff");
          const chExt = X.kid(xfrm, "chExt");
          const cx = Number(X.attr(chOff, "x") || 0) / EMU_PER_PT;
          const cy = Number(X.attr(chOff, "y") || 0) / EMU_PER_PT;
          const cw = Number(X.attr(chExt, "cx") || 0) / EMU_PER_PT || outer.w || 1;
          const ch = Number(X.attr(chExt, "cy") || 0) / EMU_PER_PT || outer.h || 1;
          const sx = outer.w / cw || 1;
          const sy = outer.h / ch || 1;
          walk(node, (b) => ({ x: outer.x + (b.x - cx) * sx, y: outer.y + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy }));
          continue;
        }
        if (!["sp", "pic", "graphicFrame", "cxnSp"].includes(node.local)) continue;
        const nv = X.kid(node, "nvSpPr") || X.kid(node, "nvPicPr") || X.kid(node, "nvGraphicFramePr");
        const ph = X.first(nv, "ph");
        const phType = ph ? X.attr(ph, "type") || "body" : null;
        const xfrm = X.first(X.kid(node, "spPr"), "xfrm") || X.kid(node, "xfrm");
        let box = xfrm ? boxOf(xfrm) : ph ? inherited.get("idx:" + X.attr(ph, "idx")) || inherited.get("type:" + phType) : null;
        if (!box) box = phType === "title" || phType === "ctrTitle" ? { x: W * 0.06, y: H * 0.05, w: W * 0.88, h: H * 0.16 } : { x: W * 0.06, y: H * 0.25, w: W * 0.88, h: H * 0.68 };
        box = map(box);
        let inner = "";
        if (node.local === "sp") inner = paragraphs(X.kid(node, "txBody"), phType);
        else if (node.local === "pic") inner = image(X.attr(X.first(node, "blip"), "embed"));
        else if (node.local === "graphicFrame") {
          const tbl = X.first(node, "tbl");
          if (tbl) inner = table(tbl);
          else if (X.first(node, "chart")) inner = '<p class="note">[chart]</p>';
          else {
            const blip = X.first(node, "blip");
            if (blip) inner = image(X.attr(blip, "embed"));
          }
        }
        if (!inner) continue;
        shapes.push(`<div class="shape" style="left:${box.x.toFixed(1)}pt;top:${box.y.toFixed(1)}pt;width:${Math.max(1, box.w).toFixed(1)}pt;height:${Math.max(1, box.h).toFixed(1)}pt">${inner}</div>`);
      }
    }
    walk(X.first(tree, "spTree"), (b) => b);
    return `<section class="slide" aria-label="${number}">${shapes.join("")}</section>`;
  }

  const body = slides.map((part, i) => slideHtml(part, i + 1)).join("");
  const css = `
    .slide { position: relative; width: ${W}pt; height: ${H}pt; overflow: hidden; break-after: page; background: #fff; }
    .slide:last-child { break-after: auto; }
    .shape { position: absolute; overflow: visible; }
    .shape p { margin: 0 0 4pt; line-height: 1.2; }
    .shape p.gap { height: 6pt; margin: 0; }
    .shape table { font-size: 12pt; width: 100%; }
  `;
  return { html: documentOf({ body: body || '<p class="note">No slides.</p>', size: `${W}pt ${H}pt`, margin: "0", css }), slides: slides.length, missingPictures: missing };
}

module.exports = { convert, read };

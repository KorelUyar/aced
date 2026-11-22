// Makes sample files of every kind Aced reads, on this Mac, with maths in them: numbered
// exercises and formulas. Office and OpenDocument files are written here as the XML their
// programs write; old Word files and RTF come from macOS's textutil, HEIC and TIFF from sips
// and tiffutil, screenshots from a hidden page. Also the hostile kind: a zip bomb, XML with an
// external entity, a drawing with a script, a web page with a picture from a server, a picture
// with a huge number of pixels. Nothing personal goes into any of them.
//
//   const { make } = require("./fixtures/formats"); await make(folder, { server })
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

// ------------------------------------------------------------ a small zip writer

function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, { store = false, raw } = {}] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = raw || (store ? data : zlib.deflateRawSync(data));
    const method = raw || !store ? 8 : 0;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const size = raw ? 0x7fffffff : data.length; // a bomb claims a size, any size
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(nameBytes.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// A small PNG: a red square, for pictures inside documents.
function png(width = 40, height = 30, rgb = [200, 40, 30]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A real PNG of 20000 × 20000 pixels (400 megapixels, black and white): a few hundred kilobytes that would decode to more than a gigabyte. */
function hugePng() {
  const width = 20000;
  const height = 20000;
  const row = Buffer.alloc(1 + width / 8); // filter byte, then one bit per pixel
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ------------------------------------------------------------ Word with formulas (OMML)

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const mr = (t) => `<m:r><m:t>${t}</m:t></m:r>`;
const run = (t, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (content, { style, num, pageBreakBefore } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${num ? `<w:numPr><w:ilvl w:val="${num[1] || 0}"/><w:numId w:val="${num[0]}"/></w:numPr>` : ""}${pageBreakBefore ? "<w:pageBreakBefore/>" : ""}</w:pPr>${content}</w:p>`;
const math = (inner) => `<m:oMath>${inner}</m:oMath>`;
const sup = (base, s) => `<m:sSup><m:e>${base}</m:e><m:sup>${s}</m:sup></m:sSup>`;
const frac = (n, d) => `<m:f><m:num>${n}</m:num><m:den>${d}</m:den></m:f>`;
const sqrt = (x) => `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${x}</m:e></m:rad>`;

/** A worksheet in Word: numbered exercises (Word's own numbering), formulas, a table, a picture, two pages. */
function docx({ secret } = {}) {
  const body = [
    para(run("Arbeitsblatt 7: Quadratische Gleichungen"), { style: "Heading1" }),
    para(run("Löse die folgenden Aufgaben. Schreibe den Lösungsweg auf.")),
    para(run("Löse die Gleichung ") + math(sup(mr("x"), mr("2")) + mr("−5x+6=0")) + run("."), { num: [1] }),
    para(run("Berechne ") + math(frac(mr("3a+1"), sqrt(mr("a")))) + run(" für a = 4."), { num: [1] }),
    para(run("Zeige, dass ") + math(mr("x=") + frac(mr("−b±") + sqrt(sup(mr("b"), mr("2")) + mr("−4ac")), mr("2a"))) + run(" die Lösungen sind."), { num: [1] }),
    `<w:tbl><w:tr><w:tc><w:p>${run("x")}</w:p></w:tc><w:tc><w:p>${run("y")}</w:p></w:tc></w:tr><w:tr><w:tc><w:p>${run("2")}</w:p></w:tc><w:tc><w:p>${run("0")}</w:p></w:tc></w:tr><w:tr><w:tc><w:p>${run("3")}</w:p></w:tc><w:tc><w:p>${run("0")}</w:p></w:tc></w:tr></w:tbl>`,
    para(`<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="952500"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`),
    para(run("Teil B: Textaufgaben"), { style: "Heading2", pageBreakBefore: true }),
    para(run("Ein Rechteck hat die Fläche 24 cm² und den Umfang 20 cm. Bestimme die Seiten."), { num: [1] }),
    para(run("Die Summe ") + math(`<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${mr("k=1")}</m:sub><m:sup>${mr("n")}</m:sup><m:e>${mr("k")}</m:e></m:nary>` + mr("=") + frac(mr("n(n+1)"), mr("2"))) + run(" gilt für alle n."), { num: [1] }),
    para(run("Finde die Nullstellen von ") + math(mr("f(x)=") + sup(mr("x"), mr("3")) + mr("−4x")) + run("."), { num: [1, 0] }),
    para(run("graphisch"), { num: [1, 1] }),
    para(run("rechnerisch" + (secret ? " &xxe;" : "")), { num: [1, 1] }),
  ].join("");
  const doctype = secret ? `<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file://${secret}">]>` : "";
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${doctype}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;
  return zipOf([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdWeb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:9/remote.png" TargetMode="External"/></Relationships>`],
    ["word/document.xml", document],
    ["word/numbering.xml", numbering],
    ["word/styles.xml", styles],
    ["word/media/image1.png", png()],
  ]);
}

/** A Word file whose document part unpacks to 400 MB of nothing: a zip bomb. */
function zipBomb() {
  const zeros = Buffer.alloc(16 * 1024 * 1024);
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const parts = [];
  deflate.on("data", (d) => parts.push(d));
  for (let i = 0; i < 25; i++) deflate.write(zeros);
  return new Promise((resolve) => {
    deflate.end(() => {
      const raw = Buffer.concat(parts);
      resolve(
        zipOf([
          ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
          ["word/document.xml", Buffer.alloc(0), { raw }],
        ]),
      );
    });
  });
}

// ------------------------------------------------------------ Excel

function xlsx() {
  const strings = ["Nr", "Aufgabe", "Punkte", "Anteil", "Abgabe", "Lineare Gleichungen", "Quadratische Gleichungen", "Bruchgleichungen", "Textaufgabe Zinsen", "Kapital", "Zinssatz", "Jahre", "Endkapital"];
  const s = (i) => `t="s"><v>${i}</v>`;
  const row = (r, cells) => `<row r="${r}">${cells.map(([ref, inner]) => `<c r="${ref}" ${inner}</c>`).join("")}</row>`;
  const sheet1 = [
    row(1, [["A1", s(0)], ["B1", s(1)], ["C1", s(2)], ["D1", s(3)], ["E1", s(4)]]),
    row(2, [["A2", "><v>1</v>"], ["B2", s(5)], ["C2", "><v>4</v>"], ["D2", 's="1"><v>0.1</v>'], ["E2", 's="2"><v>46361</v>']]),
    row(3, [["A3", "><v>2</v>"], ["B3", s(6)], ["C3", "><v>6</v>"], ["D3", 's="1"><v>0.15</v>'], ["E3", 's="2"><v>46362</v>']]),
    row(4, [["A4", "><v>3</v>"], ["B4", s(7)], ["C4", "><v>5</v>"], ["D4", 's="1"><v>0.125</v>'], ["E4", 's="2"><v>46363</v>']]),
    row(5, [["A5", "><v>4</v>"], ["B5", s(8)], ["C5", "><v>8</v>"], ["D5", 's="1"><v>0.2</v>'], ["E5", 's="2"><v>46364</v>']]),
    row(6, [["B6", 't="inlineStr"><is><t>Total</t></is>'], ["C6", "><f>SUM(C2:C5)</f><v>23</v>"]]),
  ].join("");
  const sheet2 = [
    row(1, [["A1", s(9)], ["B1", s(10)], ["C1", s(11)], ["D1", s(12)]]),
    row(2, [["A2", 's="3"><v>5000</v>'], ["B2", 's="1"><v>0.025</v>'], ["C2", "><v>8</v>"], ["D2", 's="3"><f>A2*(1+B2)^C2</f><v>6092.0145</v>']]),
    row(3, [["A3", 's="3"><v>12000</v>'], ["B3", 's="1"><v>0.031</v>'], ["C3", "><v>5</v>"], ["D3", 's="3"><f>A3*(1+B3)^C3</f><v>13979.5823</v>']]),
  ].join("");
  const ws = (data) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`;
  return zipOf([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Aufgaben" sheetId="1" r:id="rId1"/><sheet name="Zinseszins" sheetId="2" r:id="rId2"/><sheet name="Hilfsblatt" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`],
    ["xl/styles.xml", `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00 &quot;CHF&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`],
    ["xl/worksheets/sheet1.xml", ws(sheet1)],
    ["xl/worksheets/sheet2.xml", ws(sheet2)],
    ["xl/worksheets/sheet3.xml", ws(row(1, [["A1", 't="inlineStr"><is><t>versteckt</t></is>']]))],
  ]);
}

/** A sheet of 5000 rows by 60 columns: more than is printed. */
function bigXlsx() {
  const rows = [];
  for (let r = 1; r <= 5000; r++) {
    const cells = [];
    for (let c = 0; c < 60; c++) cells.push(`<c r="${colName(c)}${r}"><v>${r * 100 + c}</v></c>`);
    rows.push(`<row r="${r}">${cells.join("")}</row>`);
  }
  return zipOf([
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Messwerte" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:BH5000"/><sheetData>${rows.join("")}</sheetData></worksheet>`],
  ]);
}
const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// ------------------------------------------------------------ PowerPoint

function pptx() {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"';
  const shape = (x, y, w, h, paras, ph) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
  const ap = (t, lvl = 0) => `<a:p><a:pPr lvl="${lvl}"/><a:r><a:rPr lang="de-CH" sz="2400"/><a:t>${t}</a:t></a:r></a:p>`;
  const slide = (content) => `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${content}</p:spTree></p:cSld></p:sld>`;
  const s1 = slide(shape(457200, 274638, 8229600, 1143000, ap("Kapitel 5: Exponentialfunktionen"), "title") + shape(457200, 1600200, 8229600, 4525963, ap("Wachstum mit dem Faktor q pro Schritt") + ap("Übung 12: Bakterien verdoppeln sich stündlich.", 1), "body"));
  const formula = `<a:p><a:r><a:t>Formel: </a:t></a:r><mc:AlternateContent><mc:Choice Requires="a14"><a14:m><m:oMathPara><m:oMath><m:r><m:t>N(t)=</m:t></m:r><m:sSub><m:e><m:r><m:t>N</m:t></m:r></m:e><m:sub><m:r><m:t>0</m:t></m:r></m:sub></m:sSub><m:r><m:t>·</m:t></m:r><m:sSup><m:e><m:r><m:t>2</m:t></m:r></m:e><m:sup><m:r><m:t>t</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback><a:r><a:t>N(t) = N0 · 2^t</a:t></a:r></mc:Fallback></mc:AlternateContent></a:p>`;
  const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="3600000"/><a:ext cx="6000000" cy="1200000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>t (h)</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>N(t)</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>3</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>800</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const s2 = slide(shape(457200, 274638, 8229600, 1143000, ap("Halbwertszeit"), "title") + shape(457200, 1600200, 8229600, 1800000, ap("Übung 13: Ein Medikament zerfällt mit 20 % pro Stunde.") + formula, "body") + table);
  const s3 = slide(shape(457200, 274638, 8229600, 1143000, ap("Übung 14: Logarithmus"), "title") + `<p:pic><p:nvPicPr><p:cNvPr id="5" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr></p:pic>`);
  const rel = (target, type = "slide") => `<Relationship Id="rId${target}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="slides/slide${target}.xml"/>`;
  return zipOf([
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`],
    ["ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1)}${rel(2)}${rel(3)}</Relationships>`],
    ["ppt/slides/slide1.xml", s1],
    ["ppt/slides/slide2.xml", s2],
    ["ppt/slides/slide3.xml", s3],
    ["ppt/slides/_rels/slide3.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`],
    ["ppt/media/image1.png", png(120, 90, [30, 90, 200])],
  ]);
}

// ------------------------------------------------------------ OpenDocument

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:math="http://www.w3.org/1998/Math/MathML" office:version="1.3"';
const odfZip = (mimetype, content, more = []) =>
  zipOf([
    ["mimetype", mimetype, { store: true }],
    ["META-INF/manifest.xml", `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/></manifest:manifest>`],
    ["content.xml", content],
    ...more,
  ]);

function odt() {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:automatic-styles><text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/></text:list-style><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text>
    <text:h text:outline-level="1">Übungsblatt Potenzen</text:h>
    <text:p>Vereinfache die Terme. <text:span text:style-name="T1">Ohne Taschenrechner.</text:span></text:p>
    <text:list text:style-name="L1">
      <text:list-item><text:p>Vereinfache <draw:frame><draw:object xlink:href="./Object 1"/></draw:frame>.</text:p></text:list-item>
      <text:list-item><text:p>Berechne 2 hoch 10.</text:p></text:list-item>
    </text:list>
    <table:table><table:table-row><table:table-cell><text:p>n</text:p></table:table-cell><table:table-cell><text:p>2^n</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>10</text:p></table:table-cell><table:table-cell><text:p>1024</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body></office:document-content>`;
  const formula = `<?xml version="1.0" encoding="UTF-8"?><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mfrac><msup><mi>a</mi><mn>5</mn></msup><msup><mi>a</mi><mn>2</mn></msup></mfrac></mrow><annotation encoding="StarMath 5.0">{a^5} over {a^2}</annotation></semantics></math>`;
  return odfZip("application/vnd.oasis.opendocument.text", content, [["Object 1/content.xml", formula]]);
}

function ods() {
  const cell = (v, type = "string") => (type === "float" ? `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>` : `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`);
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:body><office:spreadsheet><table:table table:name="Messreihe">
    <table:table-row>${cell("Versuch")}${cell("Zeit (s)")}${cell("Weg (m)")}</table:table-row>
    <table:table-row>${cell(1, "float")}${cell(2.5, "float")}${cell(31.25, "float")}</table:table-row>
    <table:table-row>${cell(2, "float")}${cell(3, "float")}${cell(45, "float")}</table:table-row>
    <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
  </table:table></office:spreadsheet></office:body></office:document-content>`;
  return odfZip("application/vnd.oasis.opendocument.spreadsheet", content);
}

function odp() {
  const frame = (y, cls, text) => `<draw:frame presentation:class="${cls}" svg:x="2cm" svg:y="${y}cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>${text}</text:p></draw:text-box></draw:frame>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:body><office:presentation>
    <draw:page draw:name="1">${frame(1, "title", "Vektoren")}${frame(5, "outline", "Übung 21: Addiere die Vektoren (1, 2) und (3, −1).")}</draw:page>
    <draw:page draw:name="2">${frame(1, "title", "Skalarprodukt")}${frame(5, "outline", "Übung 22: Berechne das Skalarprodukt von (2, 0) und (1, 1).")}</draw:page>
  </office:presentation></office:body></office:document-content>`;
  const styles = `<?xml version="1.0"?><office:document-styles ${ODF_NS}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles></office:document-styles>`;
  return odfZip("application/vnd.oasis.opendocument.presentation", content, [["styles.xml", styles]]);
}

// ------------------------------------------------------------ e-book, web page, drawing, notebook

function epub() {
  const chapter = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title><script>document.title="x"</script></head><body><h1>${title}</h1>${body}</body></html>`;
  return zipOf([
    ["mimetype", "application/epub+zip", { store: true }],
    ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
    ["OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Kleine Geometrie</dc:title></metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/fig.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`],
    ["OEBPS/text/ch1.xhtml", chapter("Kapitel 1: Dreiecke", `<p>Im rechtwinkligen Dreieck gilt <math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msup><mi>c</mi><mn>2</mn></msup></math>.</p><p><img src="../images/fig.png" alt="Dreieck"/></p><p>Aufgabe 1.4: Berechne die Hypotenuse für a = 3 und b = 4.</p>`)],
    ["OEBPS/text/ch2.xhtml", chapter("Kapitel 2: Kreise", `<p>Aufgabe 2.1: Berechne den Umfang eines Kreises mit r = 5 cm.</p><img src="https://127.0.0.1:9/tracker.png"/>`)],
    ["OEBPS/images/fig.png", png(80, 60, [40, 160, 60])],
  ]);
}

const html = (remote) => `<!doctype html><html><head><meta charset="utf-8"><title>Übungen online</title><script>document.body.innerHTML = "SCRIPT RAN"</script><link rel="stylesheet" href="${remote}/style.css"></head>
<body onload="document.body.innerHTML='ONLOAD RAN'"><h1>Übungen 3.1: Funktionen</h1><p>Aufgabe 3.1.4: Bestimme den Definitionsbereich von f(x) = 1/(x − 2).</p>
<img src="${remote}/remote.png" alt="vom Server"><img src="bild.png" alt="daneben gespeichert"><iframe src="${remote}/frame.html"></iframe>
<p style="background:url(${remote}/bg.png)">Aufgabe 3.1.5: Skizziere den Graphen.</p><meta http-equiv="refresh" content="0;url=${remote}/away"></body></html>`;

const svg = (remote) => `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="400" viewBox="0 0 600 400" onload="fetch('${remote}/onload')">
<script>fetch("${remote}/script")</script><image href="${remote}/remote.png" x="0" y="0" width="10" height="10"/>
<polygon points="100,320 500,320 300,60" fill="none" stroke="black" stroke-width="3"/><text x="230" y="370" font-family="Helvetica" font-size="28">Dreieck ABC, Aufgabe 9</text></svg>`;

const notebook = () =>
  JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Übung 6: Mittelwert\n", "Berechne den Mittelwert der Liste."] },
      { cell_type: "code", source: ["werte = [4, 8, 15, 16, 23, 42]\n", "print(sum(werte) / len(werte))"], outputs: [{ output_type: "stream", text: ["18.0\n"] }] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });

// ------------------------------------------------------------ iWork, as Pages writes it (text storage + preview)

/** Snappy without compression: one literal per chunk, the way iWork frames it. */
function snappyFrame(data) {
  const varint = (n) => {
    const out = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
    return Buffer.from(out);
  };
  const lit = data.length - 1;
  const tag = lit < 60 ? Buffer.from([lit << 2]) : Buffer.from([62 << 2, lit & 0xff, (lit >> 8) & 0xff, (lit >> 16) & 0xff]);
  const block = Buffer.concat([varint(data.length), tag, data]);
  const head = Buffer.from([0, block.length & 0xff, (block.length >> 8) & 0xff, (block.length >> 16) & 0xff]);
  return Buffer.concat([head, block]);
}
function protoField(field, value) {
  const varint = (n) => {
    const out = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    return Buffer.from(out);
  };
  if (typeof value === "number") return Buffer.concat([varint(field * 8), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
function pages(previewJpg) {
  const storage = Buffer.concat([protoField(1, 0), protoField(3, "Übungen zur Wahrscheinlichkeit\u2029Aufgabe 5: Ein Würfel wird zweimal geworfen. Wie gross ist die Wahrscheinlichkeit für eine Doppelsechs?\u2029Aufgabe 6: Ziehe zwei Karten.")]);
  const info = Buffer.concat([protoField(1, 1), protoField(2, Buffer.concat([protoField(1, 2001), protoField(3, storage.length)]))]);
  const lenPrefix = (b) => Buffer.concat([Buffer.from([b.length]), b]);
  const iwa = snappyFrame(Buffer.concat([lenPrefix(info), storage]));
  return zipOf([
    ["Index/Document.iwa", iwa],
    ["Metadata/Properties.plist", "<plist/>"],
    ["preview.jpg", previewJpg],
  ]);
}

// ------------------------------------------------------------ all of them

/**
 * Writes every sample into `dir` and returns their paths by name. `remote` is the address of a
 * local server that counts requests (for the hostile files); `secret` a file an external
 * entity points to; `shots`: screenshots made by the caller (PNG buffers, pages of a worksheet).
 */
async function make(dir, { remote = "http://127.0.0.1:9", secret, shots = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  const put = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    out[name] = file;
    return file;
  };
  put("Arbeitsblatt 7.docx", docx());
  put("Noten.xlsx", xlsx());
  put("Messwerte gross.xlsx", bigXlsx());
  put("Exponentialfunktionen.pptx", pptx());
  put("Potenzen.odt", odt());
  put("Messreihe.ods", ods());
  put("Vektoren.odp", odp());
  put("Geometrie.epub", epub());
  put("Übungen online.html", html(remote));
  put("bild.png", png(60, 40, [10, 120, 200]));
  put("Dreieck.svg", svg(remote));
  put("Mittelwert.ipynb", notebook());
  put("Punkte.csv", "Aufgabe;Punkte;Note\n1;4;5,5\n2;6;4,5\n3;5;6\n");
  put("Werte.tsv", "x\tf(x)\n1\t2\n2\t5\n3\t10\n");
  put("Lernziele.txt", "Lernziele Mathematik\n\n- Ich kann quadratische Gleichungen lösen (Aufgaben 1–3).\n- Ich kann Brüche vereinfachen.\n");
  put("Notizen.md", "# Notizen zu Kapitel 4\n\n1. Mitternachtsformel: $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$\n2. Diskriminante $D = b^2 - 4ac$\n\n| D | Lösungen |\n|---|---|\n| > 0 | 2 |\n| = 0 | 1 |\n");
  put("Formelsammlung.tex", "\\section{Ableitungen}\n$(x^n)' = n x^{n-1}$\\\\\nAufgabe 8: Leite $f(x) = 3x^4$ ab.\n");
  put("Daten.json", JSON.stringify({ aufgabe: 10, werte: [1, 4, 9, 16] }, null, 2));
  put("folge.py", "# Aufgabe 11: Fibonacci\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nprint(fib(10))\n");
  put("ohne Endung", "Aufgabe 12: Eine Textdatei ohne Endung.\n");
  // Word formats macOS writes itself.
  const source = put("worksheet-source.html", `<html><head><meta charset="utf-8"></head><body><h1>Übungsblatt Prozent</h1><p>Aufgabe 1: Berechne 15 % von 240.</p><p>Aufgabe 2: Ein Preis steigt von 80 auf 92 CHF. Um wie viel Prozent?</p><table border="1"><tr><td>Grundwert</td><td>Prozentsatz</td></tr><tr><td>240</td><td>15 %</td></tr></table><p><img src="bild.png"></p></body></html>`);
  for (const [name, format] of [["Prozent.doc", "doc"], ["Prozent.rtf", "rtf"], ["Prozent (textutil).odt", "odt"], ["Prozent (textutil).docx", "docx"]]) {
    execFileSync("/usr/bin/textutil", ["-convert", format, "-output", path.join(dir, name), source]);
    out[name] = path.join(dir, name);
  }
  fs.rmSync(source);
  delete out["worksheet-source.html"];
  // Pictures: the caller's screenshots as PNG, HEIC, JPEG, TIFF (one file, two pages), GIF, BMP.
  shots.forEach((shot, i) => put(`Bildschirmfoto ${i + 1}.png`, shot));
  if (shots.length) {
    const first = out["Bildschirmfoto 1.png"];
    for (const [ext, format] of [["heic", "heic"], ["jpg", "jpeg"], ["gif", "gif"], ["bmp", "bmp"], ["tiff", "tiff"]]) {
      const target = path.join(dir, `Foto.${ext}`);
      execFileSync("/usr/bin/sips", ["-s", "format", format, first, "--out", target], { stdio: "ignore" });
      out[`Foto.${ext}`] = target;
    }
    if (shots.length > 1) {
      const second = path.join(dir, "zwei.tiff");
      execFileSync("/usr/bin/sips", ["-s", "format", "tiff", out["Bildschirmfoto 2.png"], "--out", second], { stdio: "ignore" });
      execFileSync("/usr/bin/tiffutil", ["-cat", out["Foto.tiff"], second, "-out", path.join(dir, "Scan zwei Seiten.tiff")], { stdio: "ignore" });
      fs.rmSync(second);
      out["Scan zwei Seiten.tiff"] = path.join(dir, "Scan zwei Seiten.tiff");
    }
    put("Wahrscheinlichkeit.pages", pages(fs.readFileSync(out["Foto.jpg"])));
  }
  // Hostile files.
  put("Bombe.docx", await zipBomb());
  if (secret) put("Entity.docx", docx({ secret }));
  put("Riesig.png", hugePng());
  put("Archiv.zip", zipOf([["a.txt", "Aufgabe"]]));
  put("Programm.exe", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0x40]));
  return out;
}

module.exports = { make, zipOf, png, hugePng, docx, xlsx, pptx, odt, ods, odp, epub, pages, snappyFrame };

Third-party files, copied here by scripts/vendor.js:

htm-preact.js        htm 3.1.1 with Preact built in. htm: Apache-2.0 (htm-LICENSE.txt).
                     Preact: MIT, Copyright (c) 2015-present Jason Miller.
archivo*.woff2       Archivo, Copyright 2020 The Archivo Project Authors.
                     SIL Open Font License 1.1 (archivo-LICENSE.txt).
katex/               KaTeX 0.19 (module, stylesheet, fonts). MIT (katex/LICENSE.txt).
pdfjs/               pdf.js 6.5 (module and worker): draws the book inside the app.
                     Apache-2.0 (pdfjs/LICENSE.txt). With it come four folders of pdf.js's own,
                     each with the licence files of what is in it:
  standard_fonts/    Fonts for PDFs that name a standard font without carrying it.
                     Liberation Sans: GPL v2 with font exceptions (LICENSE_LIBERATION).
                     Foxit fonts: BSD 3-clause, PDFium Authors (LICENSE_FOXIT).
  wasm/              Decoders for the pictures in scanned books, each as WebAssembly and as
                     plain JavaScript (*_nowasm_fallback.js, used where WebAssembly may not run).
                     OpenJPEG for JPEG 2000: BSD 2-clause (LICENSE_OPENJPEG, LICENSE_PDFJS_OPENJPEG).
                     PDFium's JBIG2 and fax decoders: BSD 3-clause (LICENSE_JBIG2), built by
                     Mozilla under Apache-2.0 (LICENSE_PDFJS_JBIG2).
                     qcms for colour profiles: MIT (LICENSE_QCMS, LICENSE_PDFJS_QCMS).
                     pdf.js also has quickjs, which runs scripts found in a PDF. It is left out.
  iccs/              A CMYK colour profile: CC0 (iccs/LICENSE).
  cmaps/             Adobe's character maps for East Asian fonts: BSD 3-clause (cmaps/LICENSE).

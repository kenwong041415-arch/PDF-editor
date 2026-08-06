"use strict";

/*
 * Fully client-side PDF word editor.
 *
 *   - pdf.js renders each page to a canvas and extracts text items with their
 *     positions (in PDF user-space coordinates).
 *   - The user clicks a text item and retypes it; edits are recorded.
 *   - On download, pdf-lib opens the ORIGINAL bytes, covers each edited item's
 *     rectangle with its sampled background colour, and draws the new text at
 *     the same baseline. The font used for that text is picked in this order:
 *       1. The document's own embedded font for that item, reused directly --
 *          pdf.js exposes the real PDF font name (e.g. "CIDFont+F1") via
 *          each item's loaded font object even when a PDF's font *resource*
 *          name gives no hint of it; pdf-lib's low-level object graph is then
 *          used to pull the actual font program bytes out of the source PDF,
 *          and fontkit embeds them for pdf-lib to draw with -- an exact
 *          match, not an approximation.
 *       2. If that font can't be reused (not embedded, corrupt, or missing a
 *          glyph the replacement text needs), fall back to a standard font
 *          matched to the original style (serif/mono, bold, italic).
 *     Replacement text is measured against the *original* text's true
 *     on-page width (not just the font's natural glyph advances) to correct
 *     for any custom kerning already baked into the source PDF, so an edit
 *     isn't shrunk to fit based on a false "too wide" reading. A thin ruled
 *     line just below the baseline (e.g. a blank-field underline) is
 *     detected from the rendered canvas and redrawn after covering, since
 *     the cover rectangle would otherwise erase it.
 *
 * Nothing is uploaded anywhere -- all processing happens in this browser tab.
 */

const {
  PDFDocument, StandardFonts, rgb,
  PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream,
} = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

// --- State -------------------------------------------------------------
const state = {
  pdfDoc: null,        // pdf.js document
  masterBytes: null,   // Uint8Array of the original file (for pdf-lib)
  name: "document.pdf",
  page: 0,             // 0-indexed
  pageCount: 0,
  zoom: 1.5,
  edits: new Map(),    // key `${page}:${index}` -> edit record
  // current render context:
  viewport: null,
  items: [],           // text items on the current page
  pdfPage: null,       // current pdf.js Page object (for font lookups)
};

// --- Element refs ------------------------------------------------------
const el = (id) => document.getElementById(id);
const uploadScreen = el("upload-screen");
const editorScreen = el("editor-screen");
const dropzone = el("dropzone");
const fileInput = el("file-input");
const canvas = el("page-canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const overlay = el("overlay");
const pageStage = el("page-stage");
const pageIndicator = el("page-indicator");
const zoomIndicator = el("zoom-indicator");
const topbarActions = el("topbar-actions");
const docname = el("docname");

// --- Small UI helpers --------------------------------------------------
function toast(msg, ms = 2200) {
  const t = el("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), ms);
}
function spinner(show, text = "Working…") {
  el("spinner-text").textContent = text;
  el("spinner").hidden = !show;
}

// --- Load a file -------------------------------------------------------
async function openFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    toast("Please choose a PDF file.");
    return;
  }
  spinner(true, "Opening PDF…");
  try {
    const buf = await file.arrayBuffer();
    state.masterBytes = new Uint8Array(buf);
    // pdf.js may detach its input buffer, so hand it an independent copy.
    state.pdfDoc = await pdfjsLib.getDocument({ data: state.masterBytes.slice() }).promise;
    state.name = file.name;
    state.pageCount = state.pdfDoc.numPages;
    state.page = 0;
    state.edits.clear();
    enterEditor();
    await renderPage(0);
    updateEditCount();
    toast(`Loaded ${file.name} (${state.pageCount} pages)`);
  } catch (err) {
    console.error(err);
    toast("Could not open PDF: " + err.message);
  } finally {
    spinner(false);
  }
}

function enterEditor() {
  uploadScreen.hidden = true;
  editorScreen.hidden = false;
  topbarActions.hidden = false;
  docname.textContent = state.name;
}

function resetToUpload() {
  editorScreen.hidden = true;
  uploadScreen.hidden = false;
  topbarActions.hidden = true;
  fileInput.value = "";
  state.pdfDoc = null;
  state.edits.clear();
}

// --- Render a page -----------------------------------------------------
async function renderPage(pageNo) {
  state.page = pageNo;
  const page = await state.pdfDoc.getPage(pageNo + 1);
  state.pdfPage = page;
  const viewport = page.getViewport({ scale: state.zoom });
  state.viewport = viewport;

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  pageStage.style.width = canvas.width + "px";
  pageStage.style.height = canvas.height + "px";

  await page.render({ canvasContext: ctx, viewport }).promise;

  const textContent = await page.getTextContent();
  state.items = textContent.items
    .map((item, index) => ({ item, index, styles: textContent.styles }))
    .filter((r) => r.item.str && r.item.str.trim() !== "");

  buildOverlay();
  updateIndicators();
}

// Convert an item's PDF-space transform to canvas pixel geometry.
function pixelBox(item) {
  const tx = pdfjsLib.Util.transform(state.viewport.transform, item.transform);
  const fontH = Math.hypot(tx[2], tx[3]);
  const left = tx[4];
  const baseline = tx[5];
  const width = item.width * state.zoom;
  return { left, top: baseline - fontH, width, height: fontH };
}

function buildOverlay() {
  overlay.innerHTML = "";
  for (const rec of state.items) {
    const key = `${state.page}:${rec.index}`;
    const box = pixelBox(rec.item);
    const div = document.createElement("div");
    div.className = "span-box";
    div.style.left = box.left + "px";
    div.style.top = box.top + "px";
    div.style.width = Math.max(box.width, 6) + "px";
    div.style.height = box.height + "px";
    div.title = rec.item.str;

    const edit = state.edits.get(key);
    if (edit) {
      div.classList.add("edited");
      // Live preview: cover old glyphs and show the new text.
      const prev = document.createElement("div");
      prev.style.position = "absolute";
      prev.style.left = box.left + "px";
      prev.style.top = box.top + "px";
      prev.style.height = box.height + "px";
      prev.style.minWidth = box.width + "px";
      prev.style.display = "flex";
      prev.style.alignItems = "center";
      prev.style.whiteSpace = "pre";
      prev.style.fontSize = box.height * 0.82 + "px";
      prev.style.lineHeight = box.height + "px";
      prev.style.background = cssRgb(edit.bg);
      prev.style.color = cssRgb(edit.color);
      prev.style.pointerEvents = "none";
      prev.style.fontFamily = edit.fontFamily;
      prev.textContent = edit.newText;
      overlay.appendChild(prev);
    }

    div.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(rec, box);
    });
    overlay.appendChild(div);
  }
}

function cssRgb(c) {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

// --- Colour sampling from a rendered canvas ---------------------------
// Estimates the background (page/fill) colour just outside a text box and the
// ink colour as the pixel inside the box that differs most from the background.
function sampleColors(context, cnv, box) {
  const L = Math.max(0, Math.round(box.left));
  const T = Math.max(0, Math.round(box.top));
  const W = Math.min(cnv.width - L, Math.round(box.width) || 1);
  const H = Math.min(cnv.height - T, Math.round(box.height) || 1);

  let bg = [1, 1, 1];
  const probe = (px, py) => {
    const x = Math.min(cnv.width - 1, Math.max(0, Math.round(px)));
    const y = Math.min(cnv.height - 1, Math.max(0, Math.round(py)));
    return context.getImageData(x, y, 1, 1).data;
  };
  const votes = {};
  for (const [px, py] of [
    [L - 3, T + H / 2], [L + W + 2, T + H / 2],
    [L + W / 2, T - 3], [L + W / 2, T + H + 2],
  ]) {
    const d = probe(px, py);
    const k = `${d[0]},${d[1]},${d[2]}`;
    votes[k] = (votes[k] || 0) + 1;
  }
  const bgKey = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  if (bgKey) bg = bgKey.split(",").map((n) => +n / 255);

  let color = [0, 0, 0];
  if (W > 0 && H > 0) {
    const img = context.getImageData(L, T, W, H).data;
    const bgb = bg.map((v) => v * 255);
    let best = -1;
    const stepX = Math.max(1, Math.floor(W / 30));
    const stepY = Math.max(1, Math.floor(H / 10));
    for (let y = 0; y < H; y += stepY) {
      for (let x = 0; x < W; x += stepX) {
        const i = (y * W + x) * 4;
        const dr = img[i] - bgb[0], dg = img[i + 1] - bgb[1], db = img[i + 2] - bgb[2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist > best) { best = dist; color = [img[i] / 255, img[i + 1] / 255, img[i + 2] / 255]; }
      }
    }
    // If the "ink" barely differs from the background, keep a safe black.
    if (best < 900) color = [0, 0, 0];
  }
  return { bg, color };
}

// Detect a thin dark ruled line (e.g. a blank-field underline) sitting just
// below a text item -- the same vertical zone a cover rectangle needs to
// reach to blank out descenders, so a plain redaction-style cover would
// erase it. There's no API to enumerate a PDF's vector drawings from the
// browser (unlike PyMuPDF's get_drawings()), so this scans the rendered
// canvas instead, looking for a long, mostly-uniform dark strip just below
// the baseline.
//
// Such a line commonly extends beyond the edited text on one or both sides
// (e.g. a signature blank drawn wider than the label it sits under), so this
// scans a wider strip than the text's own box and reports the actual
// contiguous dark run found, rather than assuming the line spans exactly the
// text's width -- both to catch lines that only partly overlap the text, and
// so the caller redraws the line at its true extent, not the text's. Returns
// {y, x0, x1, color} in canvas pixel space, or null.
function detectRuledLineRow(context, cnv, box) {
  const baselineY = Math.round(box.top + box.height);
  const scanRows = Math.max(1, Math.round(box.height * 0.3));
  const padX = Math.min(box.width * 0.5, 90);
  const L = Math.max(0, Math.round(box.left - padX));
  const R = Math.min(cnv.width, Math.round(box.left + box.width + padX));
  const W = R - L;
  if (W < 6) return null;

  const minRunLen = Math.max(20, box.width * 0.3);
  for (let dy = 0; dy <= scanRows; dy++) {
    const y = baselineY + dy;
    if (y < 0 || y >= cnv.height) continue;
    const row = context.getImageData(L, y, W, 1).data;

    // Find the longest contiguous run of dark pixels in this row.
    let runStart = -1, bestStart = -1, bestLen = 0, curLen = 0;
    for (let x = 0; x <= W; x++) {
      const dark = x < W && (() => {
        const i = x * 4;
        return 0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2] < 180;
      })();
      if (dark) {
        if (runStart === -1) runStart = x;
        curLen++;
      } else {
        if (curLen > bestLen) { bestLen = curLen; bestStart = runStart; }
        runStart = -1;
        curLen = 0;
      }
    }

    // Require a genuinely long run -- a ruled line -- rather than the
    // scattered, narrow strokes a letter's descenders make.
    if (bestLen > minRunLen) {
      let sumR = 0, sumG = 0, sumB = 0;
      for (let x = bestStart; x < bestStart + bestLen; x++) {
        const i = x * 4;
        sumR += row[i]; sumG += row[i + 1]; sumB += row[i + 2];
      }
      return {
        y,
        x0: L + bestStart,
        x1: L + bestStart + bestLen,
        color: [sumR / bestLen / 255, sumG / bestLen / 255, sumB / bestLen / 255],
      };
    }
  }
  return null;
}

// Convert a detected line's canvas-pixel geometry to PDF space using a
// pdf.js viewport's own coordinate mapping (handles rotation etc.).
function ruledLineToPdfSpace(viewport, line) {
  const [x0, y] = viewport.convertToPdfPoint(line.x0, line.y);
  const [x1] = viewport.convertToPdfPoint(line.x1, line.y);
  return { x0, x1, y, color: line.color };
}

// --- Font-style matching ----------------------------------------------
function fontInfo(rec) {
  const style = rec.styles && rec.styles[rec.item.fontName];
  const family = ((style && style.fontFamily) || "").toLowerCase();
  const name = (rec.item.fontName || "").toLowerCase() + " " + family;
  const mono = /mono|courier|consol/.test(name);
  const serif = /serif|times|roman|georgia|garamond|minion/.test(name) && !/sans/.test(family);
  const bold = /bold|black|heavy|semibold/.test(name);
  const italic = /italic|oblique/.test(name);

  let key, css;
  if (mono) {
    key = bold && italic ? "CourierBoldOblique" : bold ? "CourierBold" : italic ? "CourierOblique" : "Courier";
    css = "monospace";
  } else if (serif) {
    key = bold && italic ? "TimesRomanBoldItalic" : bold ? "TimesRomanBold" : italic ? "TimesRomanItalic" : "TimesRoman";
    css = "Georgia, 'Times New Roman', serif";
  } else {
    key = bold && italic ? "HelveticaBoldOblique" : bold ? "HelveticaBold" : italic ? "HelveticaOblique" : "Helvetica";
    css = "Helvetica, Arial, sans-serif";
  }
  return { key, css, bold, italic };
}

// Real PDF font name (e.g. "CIDFont+F1") behind a pdf.js text item, straight
// from the loaded font object pdf.js parsed -- independent of the item's own
// internal alias and of whatever the PDF's font *resource* name happens to
// look like. Used at download time to pull the exact font out of the source
// PDF instead of approximating it. Returns null if unavailable.
function getRealFontName(pdfPage, item) {
  try {
    const fontObj = pdfPage && pdfPage.commonObjs.get(item.fontName);
    return (fontObj && fontObj.name) || null;
  } catch (e) {
    return null;
  }
}

// --- Editing -----------------------------------------------------------
function openEditor(rec, box) {
  const existing = overlay.querySelector(".span-editor");
  if (existing) existing.remove();

  const key = `${state.page}:${rec.index}`;
  const current = state.edits.get(key);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "span-editor";
  input.value = current ? current.newText : rec.item.str;
  input.style.left = box.left + "px";
  input.style.top = box.top + "px";
  input.style.minWidth = Math.max(box.width, 40) + "px";
  input.style.height = box.height + "px";
  input.style.fontSize = Math.max(box.height * 0.72, 10) + "px";
  overlay.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const newText = input.value;
    input.remove();
    if (newText === rec.item.str && !current) return;
    recordEdit(rec, box, newText);
    buildOverlay();
    updateEditCount();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    input.remove();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

// Build and store an edit record for one text item.
function recordEdit(rec, box, newText) {
  const key = `${state.page}:${rec.index}`;
  if (newText === rec.item.str) {
    state.edits.delete(key); // reverted to original
    return;
  }
  const { bg, color } = sampleColors(ctx, canvas, box);
  const line = detectRuledLineRow(ctx, canvas, box);
  const fi = fontInfo(rec);
  const t = rec.item.transform;
  const fontSize = Math.hypot(t[2], t[3]) || rec.item.height || 11;
  state.edits.set(key, {
    page: state.page,
    x: t[4],
    yBaseline: t[5],
    fontSize,
    width: rec.item.width,
    newText,
    origText: rec.item.str,
    bg,
    color,
    fontKey: fi.key,
    fontFamily: fi.css,
    realFontName: getRealFontName(state.pdfPage, rec.item),
    ruledLine: line ? ruledLineToPdfSpace(state.viewport, line) : null,
  });
}

function updateEditCount() {
  const n = state.edits.size;
  el("edit-count").textContent = n === 0 ? "No edits yet." : `${n} edit${n > 1 ? "s" : ""} pending.`;
  el("btn-reset").hidden = n === 0;
}

// --- Find & replace (all pages) ---------------------------------------
async function replaceAll() {
  const find = el("find-input").value;
  const replace = el("replace-input").value;
  const status = el("replace-status");
  if (!find) { status.textContent = "Enter text to find."; return; }

  spinner(true, "Searching all pages…");
  let count = 0;
  try {
    // Offscreen canvas for colour sampling on pages other than the current one.
    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d", { willReadFrequently: true });

    for (let p = 0; p < state.pageCount; p++) {
      const page = await state.pdfDoc.getPage(p + 1);
      const tc = await page.getTextContent();
      const matches = tc.items
        .map((item, index) => ({ item, index, styles: tc.styles }))
        .filter((r) => r.item.str && r.item.str.includes(find));
      if (matches.length === 0) continue;

      // Render this page once so we can sample colours.
      const vp = page.getViewport({ scale: 1.5 });
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      await page.render({ canvasContext: offCtx, viewport: vp }).promise;

      for (const rec of matches) {
        const newText = rec.item.str.split(find).join(replace);
        const box = offPixelBox(rec.item, vp);
        const { bg, color } = sampleColors(offCtx, off, box);
        const line = detectRuledLineRow(offCtx, off, box);
        const fi = fontInfo(rec);
        const t = rec.item.transform;
        const fontSize = Math.hypot(t[2], t[3]) || rec.item.height || 11;
        state.edits.set(`${p}:${rec.index}`, {
          page: p, x: t[4], yBaseline: t[5], fontSize, width: rec.item.width,
          newText, origText: rec.item.str, bg, color, fontKey: fi.key, fontFamily: fi.css,
          realFontName: getRealFontName(page, rec.item),
          ruledLine: line ? ruledLineToPdfSpace(vp, line) : null,
        });
        count++;
      }
    }
    status.textContent = `${count} replacement${count === 1 ? "" : "s"} queued.`;
    await renderPage(state.page);
    updateEditCount();
  } catch (err) {
    console.error(err);
    status.textContent = "Error: " + err.message;
  } finally {
    spinner(false);
  }
}

function offPixelBox(item, vp) {
  const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
  const fontH = Math.hypot(tx[2], tx[3]);
  return { left: tx[4], top: tx[5] - fontH, width: item.width * vp.scale, height: fontH };
}

// Pull an embedded font's raw program bytes out of the SOURCE pdf-lib
// document by matching a font resource's BaseFont name against the real PDF
// font name pdf.js reported for the edited item (see getRealFontName).
// Walks the low-level object graph directly since pdf-lib has no high-level
// "find this font" helper. Returns null (caller falls back) on any
// structural surprise -- a hand-written PDF's object graph can always defy
// this simple font dictionary shape (e.g. a Type3 font, or a font that lost
// its descriptor).
function findEmbeddedFontBytes(outDoc, pageIndex, realFontName) {
  try {
    const page = outDoc.getPages()[pageIndex];
    const resources = page.node.Resources();
    const fontDict = resources.lookup(PDFName.of("Font"), PDFDict);
    if (!fontDict) return null;
    const wanted = PDFName.of(realFontName).toString();

    for (const [, ref] of fontDict.entries()) {
      const fontObj = outDoc.context.lookup(ref, PDFDict);
      const baseFont = fontObj.get(PDFName.of("BaseFont"));
      if (!baseFont || baseFont.toString() !== wanted) continue;

      let descriptorEntry = fontObj.get(PDFName.of("FontDescriptor"));
      if (!descriptorEntry) {
        // Composite (Type0/CID) fonts carry their descriptor one level down.
        const descendants = fontObj.get(PDFName.of("DescendantFonts"));
        if (!descendants) continue;
        const descArr = outDoc.context.lookup(descendants, PDFArray);
        const descFontObj = outDoc.context.lookup(descArr.get(0), PDFDict);
        descriptorEntry = descFontObj.get(PDFName.of("FontDescriptor"));
      }
      if (!descriptorEntry) continue;

      const descDict = outDoc.context.lookup(descriptorEntry, PDFDict);
      for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
        const ffEntry = descDict.get(PDFName.of(key));
        if (!ffEntry) continue;
        const stream = outDoc.context.lookup(ffEntry, PDFRawStream);
        return decodePDFRawStream(stream).decode();
      }
      return null; // matched the font but it isn't embedded
    }
  } catch (e) {
    // Fall through to null -- caller falls back to a standard font.
  }
  return null;
}

// Choose (and cache) the font to draw replacement text with. Prefers the
// document's own embedded font when it covers every character being drawn;
// otherwise falls back to the closest-matching standard font.
async function pickFont(outDoc, fontCache, pageIndex, realFontName, fallbackKey, neededText) {
  if (realFontName) {
    const cacheKey = `${pageIndex}:${realFontName}`;
    if (!(cacheKey in fontCache.reuse)) {
      let entry = null;
      const bytes = findEmbeddedFontBytes(outDoc, pageIndex, realFontName);
      if (bytes) {
        try {
          entry = { fk: fontkit.create(bytes), embedded: await outDoc.embedFont(bytes, { subset: false }) };
        } catch (e) {
          entry = null; // not embeddable / corrupt font program
        }
      }
      fontCache.reuse[cacheKey] = entry;
    }
    const entry = fontCache.reuse[cacheKey];
    if (entry && Array.from(neededText).every((ch) => entry.fk.hasGlyphForCodePoint(ch.codePointAt(0)))) {
      return entry.embedded;
    }
  }
  if (!fontCache.fallback[fallbackKey]) {
    fontCache.fallback[fallbackKey] = await outDoc.embedFont(StandardFonts[fallbackKey]);
  }
  return fontCache.fallback[fallbackKey];
}

// --- Build & download the edited PDF -----------------------------------
async function download() {
  if (state.edits.size === 0) {
    toast("No edits yet — download would be unchanged.");
  }
  spinner(true, "Building edited PDF…");
  try {
    const outDoc = await PDFDocument.load(state.masterBytes);
    outDoc.registerFontkit(fontkit);
    const pages = outDoc.getPages();
    const fontCache = { reuse: {}, fallback: {} };
    let skipped = 0;

    for (const edit of state.edits.values()) {
      const page = pages[edit.page];
      try {
        // 1. Cover the original glyphs with the sampled background colour.
        const pad = edit.fontSize * 0.12;
        page.drawRectangle({
          x: edit.x - pad,
          y: edit.yBaseline - edit.fontSize * 0.26,
          width: (edit.width || edit.fontSize) + pad * 2,
          height: edit.fontSize * 1.2,
          color: rgb(edit.bg[0], edit.bg[1], edit.bg[2]),
        });

        // 2. Draw the replacement text, shrinking to fit the original width.
        if (edit.newText) {
          const font = await pickFont(outDoc, fontCache, edit.page, edit.realFontName, edit.fontKey, edit.newText);
          let size = edit.fontSize;
          let w = font.widthOfTextAtSize(edit.newText, size);
          if (edit.origText) {
            // The original text may itself already be kerned tighter or
            // looser than this font's natural spacing (common in filled form
            // fields sized to fit a printed box) -- e.g. a run whose true
            // on-page width is 169pt can measure as 183pt using the font's
            // own natural advances. Scale our estimate by that same ratio so
            // a same-length or slightly-longer edit isn't shrunk based on a
            // false "too wide" reading caused purely by the mismatch, rather
            // than by the edit actually being longer.
            try {
              const origNatural = font.widthOfTextAtSize(edit.origText, size);
              if (origNatural > 0 && edit.width > 0) w *= edit.width / origNatural;
            } catch (e) {
              // Original text has a character this font can't encode for
              // measurement purposes (only possible for the standard-font
              // fallback) -- fall back to the uncorrected estimate.
            }
          }
          if (edit.width > 0 && w > edit.width) size = Math.max(4, size * (edit.width / w));
          page.drawText(edit.newText, {
            x: edit.x,
            y: edit.yBaseline,
            size,
            font,
            color: rgb(edit.color[0], edit.color[1], edit.color[2]),
          });
        }

        // 3. Restore a ruled line (e.g. a blank-field underline) that step 1
        // covered over.
        if (edit.ruledLine) {
          const rl = edit.ruledLine;
          page.drawRectangle({
            x: Math.min(rl.x0, rl.x1),
            y: rl.y - 0.4,
            width: Math.abs(rl.x1 - rl.x0),
            height: 0.8,
            color: rgb(rl.color[0], rl.color[1], rl.color[2]),
          });
        }
      } catch (editErr) {
        // A single edit failing (typically a character neither the original
        // font nor the standard-font fallback can encode, e.g. CJK) must not
        // discard every other edit -- skip just this one and keep going.
        console.error("Skipping one edit:", editErr);
        skipped++;
      }
    }

    const bytes = await outDoc.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.name.replace(/\.pdf$/i, "") + "-edited.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(
      skipped > 0
        ? `Downloaded — ${skipped} edit${skipped > 1 ? "s" : ""} skipped (unsupported characters)`
        : "Downloaded edited PDF",
      skipped > 0 ? 5000 : 2200
    );
  } catch (err) {
    console.error(err);
    toast("Could not build PDF: " + err.message);
  } finally {
    spinner(false);
  }
}

// --- Navigation & zoom -------------------------------------------------
function updateIndicators() {
  pageIndicator.textContent = `${state.page + 1} / ${state.pageCount}`;
  zoomIndicator.textContent = Math.round(state.zoom * 66.7) + "%";
}
function goPage(delta) {
  const next = state.page + delta;
  if (next < 0 || next >= state.pageCount) return;
  spinner(true, "Loading page…");
  renderPage(next).finally(() => spinner(false));
}
function changeZoom(delta) {
  const next = Math.min(3.0, Math.max(0.75, state.zoom + delta));
  if (next === state.zoom) return;
  state.zoom = next;
  spinner(true);
  renderPage(state.page).finally(() => spinner(false));
}

// --- Wiring ------------------------------------------------------------
function init() {
  dropzone.addEventListener("click", (e) => {
    if (e.target.tagName !== "LABEL") fileInput.click();
  });
  fileInput.addEventListener("change", () => openFile(fileInput.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
  );
  ["dragleave", "dragend"].forEach((ev) =>
    dropzone.addEventListener(ev, () => dropzone.classList.remove("dragover"))
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    openFile(e.dataTransfer.files[0]);
  });

  el("btn-prev").addEventListener("click", () => goPage(-1));
  el("btn-next").addEventListener("click", () => goPage(1));
  el("btn-zoom-in").addEventListener("click", () => changeZoom(0.25));
  el("btn-zoom-out").addEventListener("click", () => changeZoom(-0.25));
  el("btn-replace").addEventListener("click", replaceAll);
  el("btn-download").addEventListener("click", download);
  el("btn-close").addEventListener("click", resetToUpload);
  el("btn-reset").addEventListener("click", () => {
    state.edits.clear();
    renderPage(state.page);
    updateEditCount();
    toast("All edits discarded");
  });

  document.addEventListener("keydown", (e) => {
    if (editorScreen.hidden) return;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    if (e.key === "ArrowLeft") goPage(-1);
    else if (e.key === "ArrowRight") goPage(1);
  });
}

document.addEventListener("DOMContentLoaded", init);

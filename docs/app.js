"use strict";

/*
 * Fully client-side PDF word editor.
 *
 *   - pdf.js renders each page to a canvas and extracts text items with their
 *     positions (in PDF user-space coordinates).
 *   - The user clicks a text item and retypes it; edits are recorded.
 *   - On download, pdf-lib opens the ORIGINAL bytes, covers each edited item's
 *     rectangle with its sampled background colour, and draws the new text at
 *     the same baseline using a standard font matched to the original style.
 *
 * Nothing is uploaded anywhere -- all processing happens in this browser tab.
 */

const { PDFDocument, StandardFonts, rgb } = PDFLib;
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
    div.title = "Click to edit";

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
        const fi = fontInfo(rec);
        const t = rec.item.transform;
        const fontSize = Math.hypot(t[2], t[3]) || rec.item.height || 11;
        state.edits.set(`${p}:${rec.index}`, {
          page: p, x: t[4], yBaseline: t[5], fontSize, width: rec.item.width,
          newText, origText: rec.item.str, bg, color, fontKey: fi.key, fontFamily: fi.css,
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

// --- Build & download the edited PDF -----------------------------------
async function download() {
  if (state.edits.size === 0) {
    toast("No edits yet — download would be unchanged.");
  }
  spinner(true, "Building edited PDF…");
  try {
    const outDoc = await PDFDocument.load(state.masterBytes);
    const pages = outDoc.getPages();
    const fontCache = {};
    const getFont = async (name) => {
      if (!fontCache[name]) fontCache[name] = await outDoc.embedFont(StandardFonts[name]);
      return fontCache[name];
    };

    for (const edit of state.edits.values()) {
      const page = pages[edit.page];
      const font = await getFont(edit.fontKey);

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
        let size = edit.fontSize;
        const w = font.widthOfTextAtSize(edit.newText, size);
        if (edit.width > 0 && w > edit.width) size = Math.max(4, size * (edit.width / w));
        page.drawText(edit.newText, {
          x: edit.x,
          y: edit.yBaseline,
          size,
          font,
          color: rgb(edit.color[0], edit.color[1], edit.color[2]),
        });
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
    toast("Downloaded edited PDF");
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

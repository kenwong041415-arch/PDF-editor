"use strict";

// --- Application state -------------------------------------------------
const state = {
  docId: null,
  name: "",
  pageCount: 0,
  page: 0,
  zoom: 2.0,
  spans: [],
  pageWidth: 0,   // PDF points
  pageHeight: 0,
};

// --- Element refs ------------------------------------------------------
const el = (id) => document.getElementById(id);
const uploadScreen = el("upload-screen");
const editorScreen = el("editor-screen");
const dropzone = el("dropzone");
const fileInput = el("file-input");
const pageImage = el("page-image");
const overlay = el("overlay");
const pageStage = el("page-stage");
const pageIndicator = el("page-indicator");
const zoomIndicator = el("zoom-indicator");
const topbarActions = el("topbar-actions");
const docname = el("docname");

// --- Helpers -----------------------------------------------------------
function toast(msg, ms = 2200) {
  const t = el("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res;
}

// --- Upload ------------------------------------------------------------
async function uploadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    toast("Please choose a PDF file.");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  toast("Uploading…");
  try {
    const res = await api("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    state.docId = data.doc_id;
    state.name = data.name;
    state.pageCount = data.page_count;
    state.page = 0;
    enterEditor();
    await loadPage(0);
    toast(`Loaded ${data.name} (${data.page_count} pages)`);
  } catch (err) {
    toast("Upload failed: " + err.message);
  }
}

function enterEditor() {
  uploadScreen.hidden = true;
  editorScreen.hidden = false;
  topbarActions.hidden = false;
  docname.textContent = state.name;
}

// --- Page rendering ----------------------------------------------------
async function loadPage(pageNo) {
  state.page = pageNo;
  pageStage.classList.add("loading");
  overlay.innerHTML = "";
  try {
    const res = await api(`/api/${state.docId}/page/${pageNo}?zoom=${state.zoom}`);
    const info = await res.json();
    state.spans = info.spans;
    state.pageWidth = info.width;
    state.pageHeight = info.height;

    // Load the rendered image, then size the overlay to match.
    await new Promise((resolve, reject) => {
      pageImage.onload = resolve;
      pageImage.onerror = reject;
      pageImage.src = `/api/${state.docId}/page/${pageNo}/image?zoom=${state.zoom}&t=${Date.now()}`;
    });
    pageStage.style.width = pageImage.naturalWidth + "px";
    pageStage.style.height = pageImage.naturalHeight + "px";
    renderSpans();
    updateIndicators();
  } catch (err) {
    toast("Could not load page: " + err.message);
  } finally {
    pageStage.classList.remove("loading");
  }
}

// Scale from PDF points to rendered pixels.
function scale() {
  return pageImage.naturalWidth / state.pageWidth;
}

function renderSpans() {
  overlay.innerHTML = "";
  const s = scale();
  for (const span of state.spans) {
    const [x0, y0, x1, y1] = span.bbox;
    const box = document.createElement("div");
    box.className = "span-box";
    box.style.left = x0 * s + "px";
    box.style.top = y0 * s + "px";
    box.style.width = (x1 - x0) * s + "px";
    box.style.height = (y1 - y0) * s + "px";
    box.title = "Click to edit";
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(span, box);
    });
    overlay.appendChild(box);
  }
}

// --- Inline editing ----------------------------------------------------
function openEditor(span, box) {
  // Remove any existing editor.
  const existing = overlay.querySelector(".span-editor");
  if (existing) existing.remove();

  const s = scale();
  const [x0, y0, x1, y1] = span.bbox;
  const height = (y1 - y0) * s;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "span-editor";
  input.value = span.text;
  input.style.left = x0 * s + "px";
  input.style.top = y0 * s + "px";
  input.style.minWidth = Math.max((x1 - x0) * s, 40) + "px";
  input.style.height = height + "px";
  input.style.fontSize = Math.max(height * 0.72, 10) + "px";

  overlay.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const cleanup = () => input.remove();

  const commit = async () => {
    if (done) return;
    done = true;
    const newText = input.value;
    cleanup();
    if (newText === span.text) return;
    await saveEdit(span, newText);
  };
  const cancel = () => {
    if (done) return;
    done = true;
    cleanup();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

async function saveEdit(span, newText) {
  toast("Saving…", 1200);
  try {
    await api(`/api/${state.docId}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_no: state.page,
        span_id: span.id,
        new_text: newText,
      }),
    });
    await loadPage(state.page); // re-render to reflect the change
    toast("Saved");
  } catch (err) {
    toast("Edit failed: " + err.message);
  }
}

// --- Find & replace ----------------------------------------------------
async function replaceAll() {
  const find = el("find-input").value;
  const replace = el("replace-input").value;
  const status = el("replace-status");
  if (!find) { status.textContent = "Enter text to find."; return; }
  status.textContent = "Working…";
  try {
    const res = await api(`/api/${state.docId}/replace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ find, replace }),
    });
    const data = await res.json();
    status.textContent = `${data.replacements} replacement(s) made.`;
    await loadPage(state.page);
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }
}

// --- Navigation & zoom -------------------------------------------------
function updateIndicators() {
  pageIndicator.textContent = `${state.page + 1} / ${state.pageCount}`;
  zoomIndicator.textContent = Math.round(state.zoom * 50) + "%";
}

function goPage(delta) {
  const next = state.page + delta;
  if (next < 0 || next >= state.pageCount) return;
  loadPage(next);
}

function changeZoom(delta) {
  const next = Math.min(4.0, Math.max(0.5, state.zoom + delta));
  if (next === state.zoom) return;
  state.zoom = next;
  loadPage(state.page);
}

async function download() {
  window.location.href = `/api/${state.docId}/download`;
}

// --- Wiring ------------------------------------------------------------
function init() {
  // Upload interactions
  dropzone.addEventListener("click", (e) => {
    if (e.target.tagName !== "LABEL") fileInput.click();
  });
  fileInput.addEventListener("change", () => uploadFile(fileInput.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "dragend"].forEach((ev) =>
    dropzone.addEventListener(ev, () => dropzone.classList.remove("dragover"))
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    uploadFile(e.dataTransfer.files[0]);
  });

  // Editor controls
  el("btn-prev").addEventListener("click", () => goPage(-1));
  el("btn-next").addEventListener("click", () => goPage(1));
  el("btn-zoom-in").addEventListener("click", () => changeZoom(0.25));
  el("btn-zoom-out").addEventListener("click", () => changeZoom(-0.25));
  el("btn-replace").addEventListener("click", replaceAll);
  el("btn-download").addEventListener("click", download);

  // Keyboard nav
  document.addEventListener("keydown", (e) => {
    if (editorScreen.hidden) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.key === "ArrowLeft") goPage(-1);
    else if (e.key === "ArrowRight") goPage(1);
  });
}

document.addEventListener("DOMContentLoaded", init);

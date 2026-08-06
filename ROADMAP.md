# Implementation Plan — From single editor to an all-in-one PDF platform

## Context

Today the repo is **one tool**: a browser-based PDF word editor (`docs/app.js`, 802 lines)
that does click-to-edit and find & replace. It works, and it has a real differentiator —
**the file never leaves the user's device**.

The goal is a Smallpdf-style all-in-one platform. Smallpdf offers ~30 tools but gates them:
**2 tasks/day and 5 MB max on the free tier, then US$12/month**. Their processing is
server-side, so every file is uploaded.

That gap is the opportunity, and it also sets our hard constraint: **if we start uploading
files, we lose the only thing that makes us different.** This plan therefore builds the
widest platform that is genuinely achievable with zero uploads, and is explicit about
which Smallpdf tools that rules out.

## Guiding constraints

1. **No uploads.** Everything runs in the browser. This is the product, not an implementation detail.
2. **No new backend.** Static hosting (GitHub Pages) must remain sufficient.
3. **Don't regress the editor.** The text editor is working, hard-won, and stays the flagship tool.

---

## Scope decision: what we build, what we don't

Verified against the **already-vendored** `pdf-lib` build (spike run against a real 8-page
PDF — merge, extract, delete, rotate, save all confirmed working, rotation verified to
persist at 90°/180°):

**Tier 1 — build now, no new dependency**
Merge · Split · Extract pages · Delete pages · Rotate · Organize/reorder · Page numbers ·
Watermark · Crop · PDF→JPG/PNG · Images→PDF · Sign · Edit text *(done)* · Redact ·
Fill & flatten forms

**Tier 2 — build later, needs one new library each**
- **Compress** — moderate difficulty: re-encode embedded images via canvas, rebuild with pdf-lib. Won't match commercial compressors; set expectations.
- **Protect / Unlock (password)** — `pdf-lib` has **no encryption support** (confirmed). Needs a fork (`pdf-lib-with-encrypt`) or a small companion lib.
- **OCR** — `tesseract.js` is genuinely client-side but ships ~10 MB of WASM. Must be lazy-loaded, never in the base bundle.

**Out of scope — cannot be done client-side without betraying the constraint**
PDF→Word/Excel/PPT · Office→PDF · AI summarize / chat / translate · HTML→PDF

These are the tools that would require a server. Recommendation: **don't build them**, and
say so plainly on the site — "we don't do these, because doing them would mean uploading
your file." That is a stronger position than a half-answer. Revisit only if you later decide
a hybrid model is worth the hosting cost, privacy exposure, and diluted pitch.

---

## Architecture

### The problem with the current code

`docs/app.js` is a single flat script in global scope. It grabs editor DOM elements at load
(`const canvas = el("page-canvas")`, lines 57–69), keeps one `state` object with
edit-specific fields, and `init()` wires up specific buttons. `docs/index.html` is a single
hardcoded layout (`#upload-screen` + `#editor-screen`) with no routing. Adding a second tool
to this as-is means it becomes unmaintainable fast.

But roughly a third of it is already tool-agnostic and should be **reused, not rewritten**:

| Reusable today | Location |
|---|---|
| `toast()`, `spinner()` | `docs/app.js:72,79` |
| `openFile()` — load + validate a PDF | `docs/app.js:85` |
| `renderPage()` — render a page to canvas | `docs/app.js:130` |
| Blob → download plumbing | inside `download()`, `docs/app.js:641` |
| `sampleColors()` — background/ink detection | `docs/app.js:214` — reusable by redact & watermark |
| `getRuledLines()` — walks pdf.js operator list for real vector geometry | `docs/app.js:294` — reusable wherever page structure matters |

### Target structure

```
docs/
  index.html          shell: topbar + <main id="tool-root"> + tool picker
  core/
    state.js          per-tool document state (load, pages, dirty)
    pdfio.js          openFile, save/download, page render  (from app.js)
    ui.js             toast, spinner, dropzone, thumbnail grid
    router.js         hash routing: #/merge, #/split, ...
  tools/
    edit-text.js      existing editor, adapted to the Tool interface
    organize.js       reorder / rotate / delete  (one UI)
    merge.js  split.js  extract.js  rotate.js
    to-image.js  from-image.js
    page-numbers.js  watermark.js  crop.js  sign.js
  vendor/             pdf.js, pdf-lib, fontkit (+ tesseract later, lazy)
```

**Tool interface** — every tool is a module exporting the same shape, so the shell can host
any of them without special-casing:

```js
export default {
  id: "merge",
  name: "Merge PDF",
  accepts: "multiple",        // "single" | "multiple"
  mount(root, ctx) {},        // render UI into root; ctx = { state, ui, pdfio }
  unmount() {},               // clean up listeners
  async run() {},             // do the work, return Blob
};
```

### Routing and hosting

Hash routing (`#/merge`) — works on GitHub Pages with no server config, gives every tool a
shareable URL, and keeps a single entry point.

### Bundle size — the constraint that shapes delivery

`docs/standalone.html` is **already 2.7 MB** with four vendored libraries. Twenty tools plus
tesseract would make the single-file build unusable. So the two targets diverge:

- **Hosted site** = primary. All tools, vendor libs lazy-loaded per tool (fontkit only for
  text editing, tesseract only for OCR). Most tools need only pdf-lib.
- **`standalone.html`** = an offline **core-tools** build (page ops + editor). Explicitly not
  every tool. `build_standalone.py` takes a tool allowlist.

---

## Phases

### Phase 0 — Platform skeleton *(no new user-facing tools)*

The enabling refactor. Nothing ships to users, everything after depends on it.

1. Extract `core/` modules from `docs/app.js` — move, don't rewrite.
2. Define the Tool interface + shell + hash router; home page = tool picker grid.
3. Port the existing editor to `tools/edit-text.js` as the first conforming tool.
4. Teach `build_standalone.py` to bundle a tool allowlist.
5. **Add a real regression suite** (see below).

**Why the test suite belongs here, not later:** this session shipped four rounds of
regressions (font substitution, width mis-measurement, two ruled-line failures) that were
only caught by manually eyeballing rendered output. That does not scale to twenty tools. The
harness already exists in ad-hoc form — the Playwright drive-the-browser scripts and the
PyMuPDF "render and verify the output pixel/coordinate data" checks used throughout. Commit
them as `tests/`, one spec per tool: drive the real UI, then verify the produced PDF with an
independent library. There are currently **zero committed tests**.

### Phase 1 — Page operations *(highest value per unit of work)*

Six Smallpdf tools share **one** UI: a thumbnail grid with select / drag / rotate / delete.
Build the grid once, and merge, split, extract, delete, rotate, and organize all follow.
All primitives verified working with the current pdf-lib.

### Phase 2 — Image tools
PDF→JPG/PNG (pdf.js render → `canvas.toBlob`) and Images→PDF (`embedJpg`/`embedPng`).
Straightforward; reuses `renderPage()`.

### Phase 3 — Document furniture
Page numbers, watermark, crop, sign (draw signature on canvas → embed as PNG). All pdf-lib
draw operations; sign reuses the overlay-placement pattern from the editor.

### Phase 4 — Harder tools
Compress; protect/unlock (new lib); fill & flatten forms (pdf-lib form API).

### Phase 5 — OCR *(optional, heavy)*
tesseract.js, lazy-loaded, with a clear "this downloads ~10 MB once" prompt.

---

## Verification

Per tool, before it ships:

1. **Drive the real UI headlessly** (Playwright + the vendored build, as used throughout this
   session) — upload, operate, download.
2. **Verify the output independently** with PyMuPDF — not "it didn't crash", but assert the
   actual result: page count, page order, rotation values, text content, coordinates.
3. **Run the full suite**, not just the new tool's spec — the recurring failure mode this
   session was fixing one case and breaking another.
4. **Confirm no network requests** in the browser devtools/trace. This is the product promise
   and deserves an automated assertion, not an assumption.

## Open decisions for you

1. **Confirm the no-server stance.** I've assumed pure client-side and dropped Office/AI
   conversion. If those tools are must-haves, that's a different product and I'd re-plan.
2. **Public site or internal tool?** Affects whether we invest in per-tool SEO landing pages.
   The architecture supports both; this only changes polish.
3. **The Python side** (`pdf_editor.py`, `app.py`, `cli.py`) — it can do things the browser
   can't (true redaction that removes glyphs, batch CLI). Proposal: keep it as the power/batch
   path, but stop developing the Flask UI, since the browser is the product.

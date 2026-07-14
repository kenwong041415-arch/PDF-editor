# PDF Word Editor

A tool for editing the actual words in a PDF. Click any word and retype it, or
do document-wide find-and-replace, keeping the original size, colour, and font
style (serif/mono, bold, italic).

It comes in two forms:

| | [Website](docs/) (browser-only) | [Local app / CLI](#python-app-interactive) (Python) |
|---|---|---|
| Runs | 100% in your browser, no server | Local Flask server / command line |
| Your file | never leaves your device | stays on your machine |
| Hosting | any static host (e.g. GitHub Pages) | run `python app.py` |
| Editing | overlays new text over the old glyphs | **true redaction** — removes old glyphs from the text layer |
| Best when | you want zero-install, shareable, private | you need a clean, searchable text layer |

![what it does](https://img.shields.io/badge/edit-real%20PDF%20text-2f6fed)

## Website (no install, runs in the browser)

The [`docs/`](docs/) folder is a fully self-contained static site — open
`docs/index.html` and everything (rendering, editing, saving) happens in your
browser. The `pdf.js` and `pdf-lib` libraries are vendored locally, so the page
makes **no external network requests** and your PDF is never uploaded anywhere.

Try it locally:

```bash
# any static file server works; for example:
python -m http.server -d docs 8000    # then open http://localhost:8000
```

**Host it on GitHub Pages:** in the repository settings, set Pages to serve from
the `/docs` folder of your default branch. The editor is then live at
`https://<user>.github.io/<repo>/`.

> **Note:** the browser version *covers* the original text and draws the new
> text on top, so the visual result is correct but the original words remain in
> the PDF's hidden text layer (still copy/searchable underneath). When you need
> the old text genuinely removed, use the Python app below, which does true
> redaction.

## Features

- **Click-to-edit** — click any line of text on a page and edit it inline.
- **Find & replace** — replace every occurrence of a phrase across the whole document.
- **Style preservation** — keeps font size, colour, bold/italic, and serif vs. sans.
- **Background matching** — sampled fill so edits blend into coloured/shaded pages.
- **Real PDF output** — the result is a normal PDF, not a flattened image.
- **Three ways to use it** — a zero-install website, a local web app, and a CLI.

## Python app (interactive)

The Python app does **true redaction** — it removes the original glyphs from the
content stream and re-inserts your new text, so the output has a clean,
searchable text layer.

Requires Python 3.9+.

```bash
pip install -r requirements.txt
python app.py
```

Then open <http://127.0.0.1:5000> and:

1. Drop a PDF onto the page (or browse for one).
2. Click any word/line to edit it — press **Enter** to save, **Esc** to cancel.
3. Or use the **Find & Replace** panel in the sidebar.
4. Click **Download edited PDF** when you're done.

Navigate pages with the **‹ ›** buttons or the arrow keys; zoom with **− / +**.

Options:

```bash
python app.py --host 0.0.0.0 --port 8080   # bind address / port
python app.py --debug                       # Flask debug mode
```

## Command line (scripted / batch)

```bash
# Replace every "Draft" with "Final"
python cli.py input.pdf -o output.pdf --replace "Draft" "Final"

# Several replacements in one pass
python cli.py input.pdf -o output.pdf -r "2023" "2024" -r "foo" "bar"

# Inspect the editable text spans on a page (0-indexed)
python cli.py input.pdf --list-page 0
```

If `-o/--output` is omitted, the result is written to `<input>-edited.pdf`.

## How it works

`pdf_editor.py` contains the engine and is usable as a library:

```python
from pdf_editor import PDFDocument

doc = PDFDocument(open("input.pdf", "rb").read())
doc.replace_all("Draft", "Final")          # document-wide find/replace
spans = doc.spans(0)                         # editable spans on page 0
doc.edit_span(0, spans[0].id, "New text")   # edit one span in place
open("out.pdf", "wb").write(doc.to_bytes())
```

Editing a span:

1. A redaction annotation covers the original text's rectangle, filled with the
   detected background colour, and is applied — this genuinely deletes the old
   glyphs from the page content stream.
2. The replacement text is drawn at the original baseline using a base-14 font
   picked to match the original style, at the same size and colour. Overly wide
   replacements are shrunk to fit the available width.

## Limitations

PDF is a fixed-layout format with no concept of reflowing paragraphs, so a few
things are inherent to editing text in place:

- **No reflow.** Replacing a word with a much longer one can overlap following
  text (interactive edits shrink-to-fit within the line to reduce this; batch
  find/replace keeps the original size).
- **Fonts are remapped** to the base-14 set (Helvetica / Times / Courier
  families). Exotic embedded fonts won't be reproduced glyph-for-glyph, but
  weight and slant are preserved.
- Best results on digitally-generated PDFs. **Scanned image PDFs** have no text
  layer to edit — run OCR first if needed.
- Works one line/span at a time; it is not a full page-layout editor.

## Project layout

```
docs/                 Browser-only website (static, hostable on GitHub Pages)
  index.html            single-page UI
  app.js                client-side editor (pdf.js + pdf-lib)
  style.css
  vendor/               vendored pdf.js and pdf-lib (no CDN needed)

app.py                Flask web server for the Python app (REST API + UI)
pdf_editor.py         Core editing engine (PyMuPDF, true redaction)
cli.py                Command-line interface
templates/, static/   UI for the Flask app
requirements.txt
```

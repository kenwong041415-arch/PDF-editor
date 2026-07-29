#!/usr/bin/env python3
"""Bundle the docs/ site into a single self-contained HTML file.

Produces ``docs/standalone.html`` -- one file that inlines the CSS, the app
code, and the pdf.js / pdf-lib libraries, and runs the pdf.js worker from an
in-page Blob URL. It has no external dependencies and works straight from
``file://`` (just double-click it) as well as any static host.

Usage:
    python build_standalone.py
"""

import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
DOCS = ROOT / "docs"
OUT = DOCS / "standalone.html"


def main() -> None:
    css = (DOCS / "style.css").read_text()
    app = (DOCS / "app.js").read_text()
    pdfjs = (DOCS / "vendor" / "pdf.min.js").read_text()
    pdflib = (DOCS / "vendor" / "pdf-lib.min.js").read_text()
    worker = (DOCS / "vendor" / "pdf.worker.min.js").read_text()
    index = (DOCS / "index.html").read_text()

    # Inner <body> markup, minus the external <link>/<script> references.
    body = re.search(r"<body>(.*)</body>", index, re.S).group(1)
    body = re.sub(r"<link[^>]*>", "", body)
    body = re.sub(r"<script[^>]*></script>\s*", "", body)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S).strip()

    # Point the pdf.js worker at a Blob built from the inlined worker source.
    app = app.replace(
        'pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";',
        "pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(\n"
        "  new Blob([document.getElementById('pdfjs-worker').textContent],\n"
        "           { type: 'application/javascript' }));",
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>PDF Word Editor</title>
</head>
<body>
<style>
{css}
</style>

{body}

<script>{pdfjs}</script>
<script>{pdflib}</script>
<script id="pdfjs-worker" type="text/plain">{worker}</script>
<script>
{app}
</script>
</body>
</html>
"""
    OUT.write_text(html)
    print(f"wrote {OUT} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()

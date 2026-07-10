"""Flask web server for the PDF word editor.

Run:
    python app.py
Then open http://127.0.0.1:5000 in a browser.

Documents are held in memory keyed by an opaque id handed to the browser.
This is intended as a local, single-user tool.
"""

from __future__ import annotations

import secrets

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_file,
)

from pdf_editor import PDFDocument

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # 64 MB upload cap

# In-memory document store: doc_id -> PDFDocument
DOCUMENTS: dict[str, PDFDocument] = {}


def _get_doc(doc_id: str) -> PDFDocument:
    doc = DOCUMENTS.get(doc_id)
    if doc is None:
        abort(404, description="Document not found or session expired.")
    return doc


@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.route("/api/upload", methods=["POST"])
def upload() -> Response:
    file = request.files.get("file")
    if file is None or not file.filename:
        abort(400, description="No file provided.")
    if not file.filename.lower().endswith(".pdf"):
        abort(400, description="Only PDF files are supported.")
    data = file.read()
    try:
        doc = PDFDocument(data, name=file.filename)
    except Exception as exc:  # noqa: BLE001
        abort(400, description=f"Could not open PDF: {exc}")

    # Evict old docs to bound memory (keep the store small for a local tool).
    if len(DOCUMENTS) > 20:
        old_id, old_doc = next(iter(DOCUMENTS.items()))
        old_doc.close()
        DOCUMENTS.pop(old_id, None)

    doc_id = secrets.token_urlsafe(12)
    DOCUMENTS[doc_id] = doc
    return jsonify(
        {
            "doc_id": doc_id,
            "name": doc.name,
            "page_count": doc.page_count,
        }
    )


@app.route("/api/<doc_id>/page/<int:page_no>")
def page_info(doc_id: str, page_no: int) -> Response:
    doc = _get_doc(doc_id)
    if page_no < 0 or page_no >= doc.page_count:
        abort(404, description="Page out of range.")
    zoom = float(request.args.get("zoom", 2.0))
    zoom = max(0.5, min(zoom, 4.0))
    size = doc.page_size(page_no)
    return jsonify(
        {
            "page_no": page_no,
            "zoom": zoom,
            "width": size["width"],
            "height": size["height"],
            "spans": [s.as_dict() for s in doc.spans(page_no)],
        }
    )


@app.route("/api/<doc_id>/page/<int:page_no>/image")
def page_image(doc_id: str, page_no: int) -> Response:
    doc = _get_doc(doc_id)
    if page_no < 0 or page_no >= doc.page_count:
        abort(404, description="Page out of range.")
    zoom = float(request.args.get("zoom", 2.0))
    zoom = max(0.5, min(zoom, 4.0))
    png = doc.render_png(page_no, zoom=zoom)
    resp = Response(png, mimetype="image/png")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/<doc_id>/edit", methods=["POST"])
def edit(doc_id: str) -> Response:
    doc = _get_doc(doc_id)
    payload = request.get_json(silent=True) or {}
    page_no = payload.get("page_no")
    span_id = payload.get("span_id")
    new_text = payload.get("new_text", "")
    if not isinstance(page_no, int) or not isinstance(span_id, str):
        abort(400, description="page_no (int) and span_id (str) are required.")
    if page_no < 0 or page_no >= doc.page_count:
        abort(404, description="Page out of range.")
    try:
        updated = doc.edit_span(page_no, span_id, new_text)
    except KeyError as exc:
        abort(404, description=str(exc))
    return jsonify({"ok": True, "span": updated.as_dict()})


@app.route("/api/<doc_id>/replace", methods=["POST"])
def replace(doc_id: str) -> Response:
    doc = _get_doc(doc_id)
    payload = request.get_json(silent=True) or {}
    old = payload.get("find", "")
    new = payload.get("replace", "")
    if not old:
        abort(400, description="'find' text is required.")
    count = doc.replace_all(old, new)
    return jsonify({"ok": True, "replacements": count})


@app.route("/api/<doc_id>/download")
def download(doc_id: str) -> Response:
    doc = _get_doc(doc_id)
    data = doc.to_bytes()
    import io

    name = doc.name
    if name.lower().endswith(".pdf"):
        name = name[:-4]
    return send_file(
        io.BytesIO(data),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{name}-edited.pdf",
    )


@app.errorhandler(400)
@app.errorhandler(404)
def handle_error(err) -> Response:
    return jsonify({"error": getattr(err, "description", str(err))}), err.code


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="PDF word editor server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    print(f"\n  PDF word editor running at http://{args.host}:{args.port}\n")
    app.run(host=args.host, port=args.port, debug=args.debug)

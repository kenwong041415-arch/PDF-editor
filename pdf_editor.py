"""Core PDF text-editing logic built on PyMuPDF.

The editing model works at the *span* level (a run of same-styled text as
reported by PyMuPDF). To change a word we:

  1. Cover the original span's rectangle with a redaction annotation filled
     with the detected background colour, then apply it (this truly removes
     the old glyphs from the content stream, not just hides them).
  2. Re-insert the new text at the original baseline, at the same size and
     colour, using a font chosen in this order:
       a. The document's own embedded font for that span, reused directly
          -- an exact match, not an approximation. Many PDFs (especially
          ones produced by "print to PDF" pipelines) give embedded fonts
          generic resource names like "CIDFont+F1" that reveal nothing
          about the real typeface, so this is discovered by extracting the
          actual font program and checking it contains every character the
          replacement text needs.
       b. If that font can't be reused (not embedded, corrupt, or missing a
          needed glyph), fall back to a base-14 font chosen to match the
          original style (serif/mono, bold, italic).

This keeps the rest of the page byte-for-byte intact and produces a real,
searchable, selectable PDF -- not an image overlay.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, asdict
from typing import Any

import fitz  # PyMuPDF


# Style flag bits used by PyMuPDF spans (page.get_text("dict")).
FLAG_ITALIC = 1 << 1
FLAG_SERIF = 1 << 2
FLAG_MONO = 1 << 3
FLAG_BOLD = 1 << 4


@dataclass
class Span:
    """A single editable run of text on a page."""

    id: str          # stable id: "<block>-<line>-<span>"
    text: str
    bbox: list[float]  # [x0, y0, x1, y1] in PDF points
    origin: list[float]  # baseline origin [x, y]
    size: float
    color: list[float]  # rgb 0..1
    font: str
    flags: int

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _int_to_rgb(color: int) -> list[float]:
    """Convert a PyMuPDF sRGB integer to an (r, g, b) float triple 0..1."""
    r = (color >> 16) & 0xFF
    g = (color >> 8) & 0xFF
    b = color & 0xFF
    return [r / 255.0, g / 255.0, b / 255.0]


def _base14_font(font_name: str, flags: int) -> str:
    """Pick a base-14 font name that best matches the original span style.

    Embedded fonts usually cannot be re-used by name for insertion, so we map
    to one of the always-available base-14 fonts, preserving serif/mono and
    the bold/italic combination.
    """
    name = (font_name or "").lower()
    bold = bool(flags & FLAG_BOLD) or "bold" in name or "black" in name or "heavy" in name
    italic = bool(flags & FLAG_ITALIC) or "italic" in name or "oblique" in name

    is_mono = bool(flags & FLAG_MONO) or any(
        k in name for k in ("mono", "courier", "consol")
    )
    is_serif = bool(flags & FLAG_SERIF) or any(
        k in name for k in ("times", "serif", "roman", "georgia", "garamond", "minion")
    )

    if is_mono:
        base = "cour"
        return base + ("bi" if bold and italic else "b" if bold else "i" if italic else "")
    if is_serif:
        # Times family: tiro / tibo / tiit / tibi
        if bold and italic:
            return "tibi"
        if bold:
            return "tibo"
        if italic:
            return "tiit"
        return "tiro"
    # Helvetica family: helv / helvB / helvO / helvBO (I is treated as oblique)
    if bold and italic:
        return "helvBO"
    if bold:
        return "helvB"
    if italic:
        return "helvO"
    return "helv"


class PDFDocument:
    """Wraps a single open PDF and exposes span-level editing operations."""

    def __init__(self, data: bytes, name: str = "document.pdf"):
        self.name = name
        self.doc = fitz.open(stream=data, filetype="pdf")
        # Cache of (page_no, pdf_font_resource_name) -> (font_bytes, fitz.Font)
        # for embedded fonts we've already extracted, so a given original
        # font is only pulled out of the PDF once. A cached ``None`` means
        # "already tried, not reusable" so we don't retry.
        self._font_cache: dict[tuple[int, str], tuple[bytes, fitz.Font] | None] = {}
        self._font_counter = 0

    # -- introspection ---------------------------------------------------

    @property
    def page_count(self) -> int:
        return self.doc.page_count

    def page_size(self, page_no: int) -> dict[str, float]:
        page = self.doc[page_no]
        rect = page.rect
        return {"width": rect.width, "height": rect.height}

    def render_png(self, page_no: int, zoom: float = 2.0) -> bytes:
        """Render a page to PNG bytes at the given zoom factor."""
        page = self.doc[page_no]
        matrix = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        return pix.tobytes("png")

    def spans(self, page_no: int) -> list[Span]:
        """Return all editable text spans on a page in reading order."""
        page = self.doc[page_no]
        data = page.get_text("dict")
        out: list[Span] = []
        for b_i, block in enumerate(data.get("blocks", [])):
            if block.get("type", 0) != 0:  # 0 == text block
                continue
            for l_i, line in enumerate(block.get("lines", [])):
                for s_i, span in enumerate(line.get("spans", [])):
                    text = span.get("text", "")
                    if not text.strip():
                        continue
                    out.append(
                        Span(
                            id=f"{b_i}-{l_i}-{s_i}",
                            text=text,
                            bbox=list(span["bbox"]),
                            origin=list(span.get("origin", (span["bbox"][0], span["bbox"][3]))),
                            size=round(float(span.get("size", 11)), 2),
                            color=_int_to_rgb(int(span.get("color", 0))),
                            font=span.get("font", ""),
                            flags=int(span.get("flags", 0)),
                        )
                    )
        return out

    def _find_span(self, page_no: int, span_id: str) -> Span | None:
        for span in self.spans(page_no):
            if span.id == span_id:
                return span
        return None

    # -- background detection -------------------------------------------

    def _background_color(self, page_no: int, rect: fitz.Rect) -> tuple[float, float, float]:
        """Guess a span's background colour.

        Renders the span's region padded slightly outward and returns the most
        frequently occurring pixel colour. Because glyphs are sparse relative to
        the background, the mode reliably picks the true page/fill colour rather
        than the ink colour. Falls back to white on any failure.
        """
        page = self.doc[page_no]
        pad = 2.0
        clip = fitz.Rect(
            max(page.rect.x0, rect.x0 - pad),
            max(page.rect.y0, rect.y0 - pad),
            min(page.rect.x1, rect.x1 + pad),
            min(page.rect.y1, rect.y1 + pad),
        )
        try:
            pix = page.get_pixmap(clip=clip, alpha=False)
            n = pix.width * pix.height
            if n == 0:
                return (1.0, 1.0, 1.0)
            samples = pix.samples
            step = pix.n
            counts: dict[tuple[int, int, int], int] = {}
            for i in range(n):
                base = i * step
                key = (samples[base], samples[base + 1], samples[base + 2])
                counts[key] = counts.get(key, 0) + 1
            r, g, b = max(counts.items(), key=lambda kv: kv[1])[0]
            return (r / 255.0, g / 255.0, b / 255.0)
        except Exception:
            return (1.0, 1.0, 1.0)

    # -- font reuse --------------------------------------------------------

    def _original_font_bytes(self, page_no: int, pdf_font_name: str) -> tuple[bytes, fitz.Font] | None:
        """Extract and cache the real embedded font behind a span's PDF font
        resource name: its raw font-program bytes plus a ``fitz.Font`` for
        glyph/metrics checks. Returns None if the font isn't embedded or
        can't be read (e.g. a standard font referenced by name only, or a
        corrupt font program).

        Deliberately does NOT register the font on the page here -- applying
        a redaction resets a page's just-registered fonts, so registration
        must happen fresh, right before each ``insert_text`` call, via
        ``_pick_font``.
        """
        if not pdf_font_name:
            return None
        cache_key = (page_no, pdf_font_name)
        if cache_key in self._font_cache:
            return self._font_cache[cache_key]

        page = self.doc[page_no]
        xref = None
        for entry in page.get_fonts(full=True):
            if entry[3] == pdf_font_name:
                xref = entry[0]
                break

        result: tuple[bytes, fitz.Font] | None = None
        if xref is not None:
            try:
                _, _, _, buf = self.doc.extract_font(xref)
                if buf:
                    result = (buf, fitz.Font(fontbuffer=buf))
            except Exception:
                result = None

        self._font_cache[cache_key] = result
        return result

    def _pick_font(
        self, page: fitz.Page, page_no: int, pdf_font_name: str, flags: int, needed_text: str
    ) -> tuple[str, fitz.Font]:
        """Choose and register the font to draw replacement text with.

        Prefers the document's own embedded font (an exact match) when it
        covers every character in ``needed_text``; otherwise falls back to
        the closest-matching base-14 font. ``page`` must be the live page
        object *after* any redaction has already been applied this call.
        """
        original = self._original_font_bytes(page_no, pdf_font_name)
        if original is not None:
            buf, font_obj = original
            if all(font_obj.has_glyph(ord(ch)) for ch in needed_text):
                local_name = f"orig{self._font_counter}"
                self._font_counter += 1
                page.insert_font(fontname=local_name, fontbuffer=buf)
                return local_name, font_obj
        fallback_name = _base14_font(pdf_font_name, flags)
        return fallback_name, fitz.Font(fallback_name)

    # -- editing ---------------------------------------------------------

    def edit_span(self, page_no: int, span_id: str, new_text: str) -> Span:
        """Replace the text of a span with ``new_text`` in place.

        Returns the updated span (its new bbox/text) so the caller can refresh.
        Raises KeyError if the span id is not found.
        """
        span = self._find_span(page_no, span_id)
        if span is None:
            raise KeyError(f"span {span_id!r} not found on page {page_no}")

        page = self.doc[page_no]
        rect = fitz.Rect(*span.bbox)
        bg = self._background_color(page_no, rect)

        # 1. Remove the original glyphs.
        page.add_redact_annot(rect, fill=bg)
        # graphics=0 keeps images/vector art; we only want to drop covered text.
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

        # 2. Re-insert the replacement text at the original baseline. Font
        # selection happens here, after redaction: applying a redaction
        # resets any font just registered on the page, so it must be
        # (re-)registered fresh right before use.
        if new_text:
            fontname, font = self._pick_font(page, page_no, span.font, span.flags, new_text)
            color = tuple(span.color)
            size = span.size
            # Shrink to fit horizontally if the new text is much wider so it
            # does not overflow the redacted area / following text.
            available = rect.width if rect.width > 1 else page.rect.width
            text_width = font.text_length(new_text, fontsize=size)
            if text_width > available > 0 and text_width > 0:
                size = max(4.0, size * available / text_width)
            page.insert_text(
                fitz.Point(*span.origin),
                new_text,
                fontsize=size,
                fontname=fontname,
                color=color,
            )

        # Return the refreshed span info (best-effort re-read).
        updated = self._find_span(page_no, span_id)
        if updated is not None:
            return updated
        # After redaction span ids may shift; return a synthetic span.
        return Span(
            id=span_id,
            text=new_text,
            bbox=list(rect),
            origin=span.origin,
            size=span.size,
            color=span.color,
            font=span.font,
            flags=span.flags,
        )

    def replace_all(self, old: str, new: str, *, whole_page: bool = True) -> int:
        """Find/replace ``old`` with ``new`` across the whole document.

        Uses PyMuPDF text search to locate every occurrence, redacts each hit
        and re-inserts ``new`` at the matching baseline. Returns the count of
        replacements made.
        """
        if not old:
            return 0
        count = 0
        for page in self.doc:
            hits = page.search_for(old)
            if not hits:
                continue
            # Capture style from the spans overlapping each hit before redacting.
            styles: list[tuple[fitz.Rect, str, int, float, tuple]] = []
            data = page.get_text("dict")
            for hit in hits:
                style = self._style_at(data, hit)
                styles.append((hit, *style))
            for hit, font, flags, size, color in styles:
                bg = self._background_color(page.number, hit)
                page.add_redact_annot(hit, fill=bg)
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            # Font selection happens after redaction: applying a redaction
            # resets any font just registered on the page, so it must be
            # (re-)registered fresh right before use.
            for hit, font, flags, size, color in styles:
                if new:
                    fontname, _ = self._pick_font(page, page.number, font, flags, new)
                    origin = fitz.Point(hit.x0, hit.y1 - (hit.height * 0.2))
                    page.insert_text(
                        origin,
                        new,
                        fontsize=size,
                        fontname=fontname,
                        color=color,
                    )
                count += 1
        return count

    @staticmethod
    def _style_at(page_dict: dict, rect: fitz.Rect) -> tuple[str, int, float, tuple]:
        """Find the span style that best overlaps ``rect``. Defaults to Helvetica 11."""
        best = None
        best_area = 0.0
        for block in page_dict.get("blocks", []):
            if block.get("type", 0) != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    sr = fitz.Rect(span["bbox"])
                    inter = sr & rect
                    area = inter.width * inter.height if not inter.is_empty else 0.0
                    if area > best_area:
                        best_area = area
                        best = span
        if best is None:
            return ("", 0, 11.0, (0.0, 0.0, 0.0))
        return (
            best.get("font", ""),
            int(best.get("flags", 0)),
            round(float(best.get("size", 11)), 2),
            tuple(_int_to_rgb(int(best.get("color", 0)))),
        )

    # -- output ----------------------------------------------------------

    def to_bytes(self) -> bytes:
        """Serialise the current document state to PDF bytes."""
        buf = io.BytesIO()
        # garbage/deflate keep the output small and clean after edits.
        self.doc.save(buf, garbage=4, deflate=True)
        return buf.getvalue()

    def close(self) -> None:
        try:
            self.doc.close()
        except Exception:
            pass

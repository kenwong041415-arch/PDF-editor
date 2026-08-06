"""Command-line PDF word editor for scripted / headless find-and-replace.

Examples:
    # Replace every "Draft" with "Final" and write a new file
    python cli.py input.pdf -o output.pdf --replace "Draft" "Final"

    # Multiple replacements in one pass
    python cli.py input.pdf -o output.pdf -r "2023" "2024" -r "foo" "bar"

    # List the editable text spans on page 1 (0-indexed)
    python cli.py input.pdf --list-page 0
"""

from __future__ import annotations

import argparse
import sys

from pdf_editor import PDFDocument


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="Input PDF path")
    parser.add_argument("-o", "--output", help="Output PDF path (defaults to <input>-edited.pdf)")
    parser.add_argument(
        "-r",
        "--replace",
        nargs=2,
        action="append",
        metavar=("FIND", "REPLACE"),
        default=[],
        help="Replace all occurrences of FIND with REPLACE (repeatable)",
    )
    parser.add_argument(
        "--list-page",
        type=int,
        metavar="N",
        help="Print the editable text spans on page N (0-indexed) and exit",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.input, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        print(f"error: cannot read {args.input}: {exc}", file=sys.stderr)
        return 1

    doc = PDFDocument(data, name=args.input)

    if args.list_page is not None:
        if not (0 <= args.list_page < doc.page_count):
            print(f"error: page {args.list_page} out of range (0..{doc.page_count - 1})", file=sys.stderr)
            return 1
        for span in doc.spans(args.list_page):
            bbox = ", ".join(f"{v:.1f}" for v in span.bbox)
            print(f"[{span.id}] size={span.size} font={span.font!r} bbox=({bbox})  {span.text!r}")
        return 0

    if not args.replace:
        print("error: nothing to do -- pass --replace or --list-page", file=sys.stderr)
        return 1

    total = 0
    for find, repl in args.replace:
        n = doc.replace_all(find, repl)
        print(f"replaced {n:4d}x  {find!r} -> {repl!r}")
        total += n

    out = args.output
    if not out:
        base = args.input[:-4] if args.input.lower().endswith(".pdf") else args.input
        out = f"{base}-edited.pdf"
    with open(out, "wb") as fh:
        fh.write(doc.to_bytes())
    print(f"\n{total} total replacement(s) written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

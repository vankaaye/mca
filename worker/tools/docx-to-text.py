#!/usr/bin/env python3
"""
Turn a rule book .docx into text the assistant can actually read.

    python3 worker/tools/docx-to-text.py rules/book.docx > out.txt

Why this exists: the rule books are mostly tables — one column per grade — and
pdftotext flattens them into a bare list of values. "Finals Qualification / Top
4 teams / Top 4 teams / Top 4 teams" gives the model no way to tell which grade
each belongs to, and it guessed. It told a parent U11 A had no finals.

Tables come out as markdown here, headers intact, so every value stays attached
to its grade.
"""
import html
import re
import sys
import zipfile


def cell_text(cell_xml):
    # A cell holds paragraphs; keep them apart or list items run together
    paras = re.findall(r"<w:p[ >].*?</w:p>", cell_xml, re.S) or [cell_xml]
    out = []
    for p in paras:
        t = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S))
        t = html.unescape(re.sub(r"<[^>]+>", "", t)).strip()
        if t:
            out.append(t)
    # Pipes would break the markdown table they are about to sit in
    return " · ".join(out).replace("|", "/")


def table_to_markdown(table_xml):
    """
    Word tables in these books interleave two kinds of row: a single merged
    cell acting as a section heading ("No-Balls, Free Hit & Leg-Side Wides"),
    and ordinary rows beneath it. Treating the first row as a header and the
    rest as data made every heading a data row, so the whole of Detailed Rules
    read as if it sat under "Batter Retirement" — which is what the assistant
    then told people. Split on the heading rows instead.
    """
    rows = []
    for row_xml in re.findall(r"<w:tr[ >].*?</w:tr>", table_xml, re.S):
        cells = [cell_text(c) for c in re.findall(r"<w:tc>.*?</w:tc>", row_xml, re.S)]
        while len(cells) > 1 and cells[-1] == "":
            cells.pop()                      # merged cells leave empty tails
        if any(cells):
            rows.append(cells)
    if not rows:
        return ""

    width = max(len(r) for r in rows)
    if width == 1:
        return "\n".join(r[0] for r in rows)

    out = []
    block = []

    def flush():
        if not block:
            return
        w = max(len(r) for r in block)
        padded = [r + [""] * (w - len(r)) for r in block]
        # A first row of short labels is a header; otherwise label the columns
        # ourselves so no value is left floating without one.
        head = padded[0] if all(len(c) < 30 for c in padded[0]) else None
        body = padded[1:] if head else padded
        if head is None:
            head = ["Applies to"] + ["Rule"] * (w - 1)
        out.append("| " + " | ".join(head) + " |")
        out.append("| " + " | ".join("---" for _ in head) + " |")
        for r in body:
            out.append("| " + " | ".join(r) + " |")
        out.append("")
        block.clear()

    for r in rows:
        if len(r) == 1:                      # a section heading inside the table
            flush()
            out.append("### " + r[0])
            out.append("")
        else:
            block.append(r)
    flush()

    return "\n".join(out).strip()


def convert(path):
    xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf8")

    # Walk paragraphs and tables in document order so headings stay with their
    # tables. Splitting on one then the other loses the relationship.
    parts = []
    for m in re.finditer(r"<w:tbl>.*?</w:tbl>|<w:p[ >].*?</w:p>", xml, re.S):
        chunk = m.group(0)
        if chunk.startswith("<w:tbl>"):
            md = table_to_markdown(chunk)
            if md:
                parts.append("\n" + md + "\n")
        else:
            t = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", chunk, re.S))
            t = html.unescape(re.sub(r"<[^>]+>", "", t)).strip()
            if t:
                parts.append(t)

    text = "\n".join(parts)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: docx-to-text.py <file.docx>")
    sys.stdout.write(convert(sys.argv[1]))

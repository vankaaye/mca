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
    rows = []
    for row_xml in re.findall(r"<w:tr[ >].*?</w:tr>", table_xml, re.S):
        cells = [cell_text(c) for c in re.findall(r"<w:tc>.*?</w:tc>", row_xml, re.S)]
        if any(cells):
            rows.append(cells)
    if not rows:
        return ""

    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    # A single-cell row is a heading inside the table, not data
    if width == 1:
        return "\n".join(r[0] for r in rows)

    head, body = rows[0], rows[1:]
    lines = ["| " + " | ".join(head) + " |",
             "| " + " | ".join("---" for _ in head) + " |"]
    for r in body:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)


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

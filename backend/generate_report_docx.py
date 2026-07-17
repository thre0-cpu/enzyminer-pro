#!/usr/bin/env python3
"""Create a simple, portable DOCX from an EnzyMiner Markdown task report.

This intentionally uses only the Python standard library so report export does
not add a runtime package dependency. It supports the Markdown constructs used
by the editable report templates: headings, paragraphs, block quotes, ordered
and unordered lists, horizontal rules, inline emphasis/code, and pipe tables.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import zipfile
from pathlib import Path

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def x(value: object) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def strip_inline_markdown(value: str) -> str:
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"\1", value)
    value = re.sub(r"\*([^*]+)\*", r"\1", value)
    return value.replace("\\|", "|")


def run(text: str, *, bold: bool = False, italic: bool = False, code: bool = False) -> str:
    props = []
    if bold:
        props.append("<w:b/>")
    if italic:
        props.append("<w:i/>")
    if code:
        props.append('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>')
        props.append('<w:shd w:fill="EEF2F7"/>')
    rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
    space = ' xml:space="preserve"' if text[:1].isspace() or text[-1:].isspace() else ""
    return f"<w:r>{rpr}<w:t{space}>{x(text)}</w:t></w:r>"


def inline_runs(text: str) -> str:
    parts = []
    cursor = 0
    pattern = re.compile(r"(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)")
    for match in pattern.finditer(text):
        if match.start() > cursor:
            parts.append(run(text[cursor:match.start()]))
        token = match.group(0)
        if token.startswith("`"):
            parts.append(run(token[1:-1], code=True))
        elif token.startswith("**"):
            parts.append(run(token[2:-2], bold=True))
        else:
            parts.append(run(token[1:-1], italic=True))
        cursor = match.end()
    if cursor < len(text):
        parts.append(run(text[cursor:]))
    return "".join(parts) or run("")


def paragraph(text: str, style: str | None = None, *, quote: bool = False, list_kind: str | None = None) -> str:
    ppr = []
    if style:
        ppr.append(f'<w:pStyle w:val="{style}"/>')
    if quote:
        ppr.append('<w:ind w:left="480"/><w:shd w:fill="F8F1F9"/><w:pBdr><w:left w:val="single" w:sz="16" w:space="6" w:color="660874"/></w:pBdr>')
    if list_kind:
        # Use visible bullets/numbers instead of numbering.xml so the document
        # remains minimal and interoperable across Word/LibreOffice/WPS.
        ppr.append('<w:ind w:left="420" w:hanging="240"/>')
    properties = f"<w:pPr>{''.join(ppr)}</w:pPr>" if ppr else ""
    return f"<w:p>{properties}{inline_runs(text)}</w:p>"


def parse_table_cells(line: str) -> list[str]:
    line = line.strip().strip("|")
    cells = re.split(r"(?<!\\)\|", line)
    return [strip_inline_markdown(cell.strip()) for cell in cells]


def table_xml(lines: list[str]) -> str:
    rows = [parse_table_cells(line) for index, line in enumerate(lines) if index != 1]
    if not rows:
        return ""
    width_count = max(len(row) for row in rows)
    grid = "".join('<w:gridCol w:w="1800"/>' for _ in range(width_count))
    out = [
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>'
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/>'
        '<w:left w:val="single" w:sz="4" w:color="CBD5E1"/>'
        '<w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/>'
        '<w:right w:val="single" w:sz="4" w:color="CBD5E1"/>'
        '<w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/>'
        '<w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/>'
        '</w:tblBorders></w:tblPr>',
        f"<w:tblGrid>{grid}</w:tblGrid>",
    ]
    for row_index, row in enumerate(rows):
        out.append("<w:tr>")
        for cell in row + [""] * (width_count - len(row)):
            shade = '<w:shd w:fill="F3EAF5"/>' if row_index == 0 else ""
            bold = row_index == 0
            out.append(
                f'<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>{shade}</w:tcPr>'
                f'<w:p>{run(cell, bold=bold)}</w:p></w:tc>'
            )
        out.append("</w:tr>")
    out.append("</w:tbl>")
    return "".join(out)


def markdown_body(markdown: str) -> str:
    lines = markdown.splitlines()
    blocks: list[str] = []
    paragraph_lines: list[str] = []

    def flush_paragraph() -> None:
        nonlocal paragraph_lines
        if paragraph_lines:
            blocks.append(paragraph(" ".join(line.strip() for line in paragraph_lines)))
            paragraph_lines = []

    index = 0
    while index < len(lines):
        line = lines[index]
        next_line = lines[index + 1] if index + 1 < len(lines) else ""
        if re.match(r"^\|.*\|\s*$", line) and re.match(r"^\|?\s*:?-+", next_line):
            flush_paragraph()
            table_lines = [line, next_line]
            index += 2
            while index < len(lines) and re.match(r"^\|.*\|\s*$", lines[index]):
                table_lines.append(lines[index])
                index += 1
            blocks.append(table_xml(table_lines))
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            flush_paragraph()
            level = min(len(heading.group(1)), 3)
            blocks.append(paragraph(strip_inline_markdown(heading.group(2)), f"Heading{level}"))
            index += 1
            continue
        quote = re.match(r"^>\s?(.*)$", line)
        if quote:
            flush_paragraph()
            quote_lines = [quote.group(1)]
            index += 1
            while index < len(lines) and (next_quote := re.match(r"^>\s?(.*)$", lines[index])):
                quote_lines.append(next_quote.group(1))
                index += 1
            blocks.append(paragraph(" ".join(quote_lines), quote=True))
            continue
        bullet = re.match(r"^\s*[-*]\s+(.*)$", line)
        ordered = re.match(r"^\s*(\d+)[.)]\s+(.*)$", line)
        if bullet or ordered:
            flush_paragraph()
            if ordered:
                text = f"{ordered.group(1)}. {ordered.group(2)}"
                kind = "ordered"
            else:
                text = f"• {bullet.group(1)}"
                kind = "bullet"
            blocks.append(paragraph(text, list_kind=kind))
            index += 1
            continue
        if re.match(r"^---+$", line.strip()):
            flush_paragraph()
            blocks.append('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="CBD5E1"/></w:pBdr></w:pPr></w:p>')
            index += 1
            continue
        if not line.strip():
            flush_paragraph()
            index += 1
            continue
        paragraph_lines.append(line)
        index += 1
    flush_paragraph()
    return "".join(blocks)


def document_xml(markdown: str) -> str:
    body = markdown_body(markdown)
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="800" w:bottom="900" w:left="800" w:header="400" w:footer="400"/></w:sectPr>
</w:body></w:document>'''


def styles_xml() -> str:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:color w:val="660874"/><w:sz w:val="36"/></w:rPr><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="140"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:color w:val="660874"/><w:sz w:val="29"/></w:rPr><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:color w:val="4A0555"/><w:sz w:val="25"/></w:rPr><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr></w:style>
</w:styles>'''


def write_docx(markdown: str, destination: Path, title: str) -> None:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    files = {
        "[Content_Types].xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>''',
        "_rels/.rels": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>''',
        "word/_rels/document.xml.rels": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''',
        "word/document.xml": document_xml(markdown),
        "word/styles.xml": styles_xml(),
        "docProps/core.xml": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{x(title)}</dc:title><dc:creator>EnzyMiner Pro</dc:creator><cp:lastModifiedBy>EnzyMiner Pro</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>''',
        "docProps/app.xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>EnzyMiner Pro</Application></Properties>''',
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content.encode("utf-8"))
    temporary.replace(destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("markdown")
    parser.add_argument("output")
    parser.add_argument("--title", default="EnzyMiner Pro Task Report")
    args = parser.parse_args()
    markdown = Path(args.markdown).read_text(encoding="utf-8")
    write_docx(markdown, Path(args.output), args.title)


if __name__ == "__main__":
    main()

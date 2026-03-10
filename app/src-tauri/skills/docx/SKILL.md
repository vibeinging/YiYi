---
name: docx
description: "Use this skill to read or create Word documents (.docx files). Supports text extraction and document creation with headings and lists."
metadata:
  {
    "yiclaw":
      {
        "emoji": "📝",
        "requires": {}
      }
  }
---

# Word Document Processing

## Reading DOCX Files

**Use the built-in `read_docx` tool** — no external software needed:

```
read_docx(path="/path/to/document.docx")
```

Extracts all text content including headings, paragraphs, and lists.

## Creating DOCX Files

**Use the built-in `create_docx` tool**:

```
create_docx(
  path="/path/to/output.docx",
  content="# Report Title\n\n## Introduction\n\nThis is the first paragraph.\n\n- Item one\n- Item two\n\n## Conclusion\n\nFinal remarks."
)
```

Supported formatting:
- `# Heading 1`, `## Heading 2`, `### Heading 3`
- `- ` or `* ` for bullet lists
- Plain text for regular paragraphs
- Empty lines for paragraph spacing

## Workflow Examples

### Summarize a DOCX
1. `read_docx(path="report.docx")`
2. Analyze and summarize the content for the user

### Convert PDF to DOCX
1. `read_pdf(path="document.pdf")`
2. `create_docx(path="document.docx", content=<extracted text>)`

### Create a report from data
1. `read_spreadsheet(path="data.xlsx")`
2. Analyze the data
3. `create_docx(path="report.docx", content=<formatted report>)`

## Advanced Operations

### Accept All Tracked Changes (requires LibreOffice)

Remove tracked changes by accepting them all:

```bash
python3 scripts/accept_changes.py input.docx output.docx
```

### Add Comments to DOCX

Add comments or replies to a DOCX document:

```bash
# First unpack the DOCX
python3 -c "from scripts.office.unpack import unpack; unpack('doc.docx', 'unpacked/')"

# Add a comment (id=0)
python3 scripts/comment.py unpacked/ 0 "Comment text"

# Add a reply to comment 0
python3 scripts/comment.py unpacked/ 1 "Reply text" --parent 0

# Repack
python3 -c "from scripts.office.pack import pack; pack('unpacked/', 'output.docx')"
```

### Python python-docx (for tables, images, styles)

For complex documents with tables, images, page numbers, or tracked changes:

```python
from docx import Document
doc = Document()
doc.add_heading("Report Title", 0)
doc.add_paragraph("Content paragraph...")
table = doc.add_table(rows=2, cols=3)
doc.save("output.docx")
```

Check: `python3 -c "import docx; print('OK')"`

### Format Conversion (pandoc)

```bash
pandoc input.md -o output.docx      # Markdown → DOCX
pandoc input.docx -o output.md      # DOCX → Markdown
pandoc input.docx -o output.pdf     # DOCX → PDF
```

## Quick Reference

| Task | Approach |
|------|----------|
| Read/extract text | `read_docx` (built-in) |
| Create with headings/lists | `create_docx` (built-in) |
| Accept tracked changes | `scripts/accept_changes.py` (requires LibreOffice) |
| Add comments | `scripts/comment.py` (requires unpack/repack) |
| Complex formatting | Python python-docx |
| Format conversion | pandoc CLI |

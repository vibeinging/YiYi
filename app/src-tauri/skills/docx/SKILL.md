---
name: docx
description: "Use this skill to read or create Word documents (.docx files). Supports text extraction and document creation with headings and lists."
metadata:
  {
    "yiyi":
      {
        "emoji": "📝",
        "requires": {}
      }
  }
---

# Word Document Processing

Drive everything through Python `python-docx` via `run_python_script`.
If the package isn't present, call `pip_install(["python-docx"])`.

## Reading DOCX Files

```python
# read_docx.py
import sys
from docx import Document

doc = Document(sys.argv[1])
for p in doc.paragraphs:
    if p.text.strip():
        print(p.text)
```

For richer extraction (headings, lists, tables), inspect `p.style.name`
and iterate `doc.tables`.

## Creating DOCX Files

```python
# create_docx.py
from docx import Document

doc = Document()
doc.add_heading("Report Title", 0)
doc.add_heading("Introduction", level=1)
doc.add_paragraph("This is the first paragraph.")
doc.add_paragraph("Item one", style="List Bullet")
doc.add_paragraph("Item two", style="List Bullet")
doc.add_heading("Conclusion", level=1)
doc.add_paragraph("Final remarks.")
doc.save("/path/to/output.docx")
```

## Workflow Examples

### Summarize a DOCX
1. Run the read script to extract text.
2. Analyze and summarize the content for the user.

### Convert PDF to DOCX
1. Use the `pdf` skill to extract text via `pypdf`.
2. Use `create_docx.py` to write that text into a new Word document.

### Create a report from data
1. Use the `xlsx` skill to read + aggregate the data.
2. Use `create_docx.py` to write a formatted report.

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
| Read / extract text | Python `python-docx` (`pip_install(["python-docx"])` if missing) |
| Create with headings/lists | Python `python-docx` |
| Accept tracked changes | `scripts/accept_changes.py` (requires LibreOffice) |
| Add comments | `scripts/comment.py` (requires unpack/repack) |
| Complex formatting | Python python-docx |
| Format conversion | pandoc CLI |

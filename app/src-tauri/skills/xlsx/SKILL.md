---
name: xlsx
description: "Use this skill for spreadsheet tasks — reading, creating, or analyzing .xlsx, .xls, .csv, or .tsv files."
metadata:
  {
    "yiyi":
      {
        "emoji": "📊",
        "requires": {}
      }
  }
---

# Spreadsheet Processing

Drive everything through Python via `run_python_script`. The agent has
`pip_install` for any missing dependency. Bundled-friendly libraries:
`openpyxl` (xlsx read/write/formatting), `pandas` (analysis), `csv` (stdlib).

## Reading Spreadsheets

```python
# read_xlsx.py
import sys
from openpyxl import load_workbook

wb = load_workbook(sys.argv[1], data_only=True)
sheet = wb[sys.argv[2]] if len(sys.argv) > 2 else wb.active
for row in sheet.iter_rows(values_only=True):
    print("\t".join("" if v is None else str(v) for v in row))
```

For CSV/TSV use the stdlib `csv` module — no install needed.

## Creating Spreadsheets

```python
# create_xlsx.py
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "Employees"
ws.append(["Name", "Age", "City"])
for cell in ws[1]:
    cell.font = Font(bold=True)
ws.append(["Alice", 30, "Beijing"])
ws.append(["Bob", 25, "Shanghai"])
wb.save("/path/to/output.xlsx")
```

## Data Analysis Workflow

1. Run a script that reads + computes the answer in one go (don't ask
   the model to mentally aggregate — push the work into Python).
2. For aggregation use `pandas`; for simple per-row work, plain
   `openpyxl` is enough and starts faster.
3. If the user wants a modified version, write rows into a new
   workbook and save.

## Converting Between Formats

- CSV → XLSX: read with `csv.reader`, write with `openpyxl`.
- XLSX → CSV: read with `openpyxl`, write with `csv.writer`.
- PDF tables → XLSX: use the `pdf` skill to extract text first, parse
  rows in Python, then write via `openpyxl`.

## Advanced Operations

### Recalculate All Formulas (requires LibreOffice)

When an Excel file has formulas that show stale values or `#VALUE!`, recalculate them:

```bash
python3 scripts/recalc.py input.xlsx output.xlsx
```

This uses LibreOffice to open the file, recalculate all formulas, and save. Requires `soffice` CLI.

### Python openpyxl (for formatting, formulas, charts)

```python
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.append(["Name", "Score"])
ws.append(["Alice", 95])
ws["C2"] = "=SUM(B2:B10)"
wb.save("output.xlsx")
```

Check: `python3 -c "import openpyxl; print('OK')"`

### Python pandas (for data analysis)

```python
import pandas as pd
df = pd.read_excel("data.xlsx")
summary = df.groupby("Category").agg({"Amount": "sum"})
summary.to_excel("summary.xlsx")
```

## Quick Reference

| Task | Approach |
|------|----------|
| Read xlsx | Python `openpyxl` (`load_workbook(..., data_only=True)`) |
| Read csv/tsv | Python stdlib `csv` |
| Create xlsx | Python `openpyxl` (Workbook + ws.append) |
| Simple analysis | One Python script: read + compute + print |
| Recalculate formulas | `scripts/recalc.py` (requires LibreOffice) |
| Complex formatting | Python openpyxl (Font, Alignment, …) |
| Data aggregation | Python pandas |

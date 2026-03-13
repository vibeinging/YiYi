---
name: xlsx
description: "Use this skill for spreadsheet tasks — reading, creating, or analyzing .xlsx, .xls, .csv, or .tsv files."
metadata:
  {
    "yiyiclaw":
      {
        "emoji": "📊",
        "requires": {}
      }
  }
---

# Spreadsheet Processing

## Reading Spreadsheets

**Use the built-in `read_spreadsheet` tool** — no external software needed:

```
read_spreadsheet(path="/path/to/file.xlsx")
read_spreadsheet(path="/path/to/file.xlsx", sheet="Sheet2", max_rows=50)
read_spreadsheet(path="/path/to/data.csv")
```

Supports: `.xlsx`, `.xls`, `.xlsm`, `.csv`, `.tsv`

## Creating Spreadsheets

**Use the built-in `create_spreadsheet` tool**:

```
create_spreadsheet(
  path="/path/to/output.xlsx",
  data=[["Name", "Age", "City"], ["Alice", 30, "Beijing"], ["Bob", 25, "Shanghai"]],
  sheet_name="Employees"
)
```

- First row is automatically bolded as headers
- Numbers are stored as numeric values (not text)
- Booleans are preserved

## Data Analysis Workflow

1. Read: `read_spreadsheet(path="data.xlsx")`
2. Analyze the tabular output (count rows, find patterns, compute stats mentally)
3. If the user wants a modified version, construct new data and use `create_spreadsheet`

## Converting Between Formats

- CSV → XLSX: Read with `read_spreadsheet`, write with `create_spreadsheet`
- XLSX → CSV: Read with `read_spreadsheet`, write text with `write_file`
- PDF tables → XLSX: Use `read_pdf` to extract, parse, then `create_spreadsheet`

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
| Read xlsx/csv | `read_spreadsheet` (built-in) |
| Create xlsx | `create_spreadsheet` (built-in) |
| Simple analysis | Read + analyze text output |
| Recalculate formulas | `scripts/recalc.py` (requires LibreOffice) |
| Complex formatting | Python openpyxl |
| Data aggregation | Python pandas |

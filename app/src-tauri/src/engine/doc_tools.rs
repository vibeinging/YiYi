//! Native document processing tools — no Python/Node.js required.
//!
//! Provides read/write for PDF, XLSX, DOCX so that the agent can handle
//! common document tasks without external runtimes.

use std::io::Cursor;
use std::path::Path;

/// Extract text content from a PDF file.
pub fn read_pdf_text(path: &str) -> String {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return format!("Error reading file: {}", e),
    };

    match pdf_extract::extract_text_from_mem(&bytes) {
        Ok(text) => {
            if text.len() > 15000 {
                format!(
                    "{}...\n\n[Truncated — {} chars total]",
                    &text[..15000],
                    text.len()
                )
            } else {
                text
            }
        }
        Err(e) => format!("Failed to extract PDF text: {}", e),
    }
}

/// Read data from an Excel/CSV file. Returns a text table.
pub fn read_spreadsheet(path: &str, sheet: Option<&str>, max_rows: Option<usize>) -> String {
    use calamine::{open_workbook_auto, Data, Reader};

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // CSV/TSV: read directly
    if ext == "csv" || ext == "tsv" {
        return read_csv(path, max_rows.unwrap_or(200));
    }

    let mut workbook = match open_workbook_auto(path) {
        Ok(wb) => wb,
        Err(e) => return format!("Error opening spreadsheet: {}", e),
    };

    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return "Spreadsheet has no sheets.".into();
    }

    let target_sheet = sheet.unwrap_or(&sheet_names[0]);
    let range = match workbook.worksheet_range(target_sheet) {
        Ok(r) => r,
        Err(e) => return format!("Error reading sheet '{}': {}", target_sheet, e),
    };

    let max = max_rows.unwrap_or(200);
    let mut output = format!(
        "Sheet: {} ({} rows x {} cols)\nSheets: {}\n\n",
        target_sheet,
        range.height(),
        range.width(),
        sheet_names.join(", ")
    );

    for (i, row) in range.rows().enumerate() {
        if i >= max {
            output.push_str(&format!("\n... [{} more rows]", range.height() - max));
            break;
        }
        let cells: Vec<String> = row
            .iter()
            .map(|cell| match cell {
                Data::Empty => String::new(),
                Data::String(s) => s.clone(),
                Data::Float(f) => {
                    if *f == (*f as i64) as f64 {
                        format!("{}", *f as i64)
                    } else {
                        format!("{}", f)
                    }
                }
                Data::Int(n) => format!("{}", n),
                Data::Bool(b) => format!("{}", b),
                Data::DateTime(dt) => format!("{}", dt),
                Data::DateTimeIso(s) => s.clone(),
                Data::DurationIso(s) => s.clone(),
                Data::Error(e) => format!("{:?}", e),
            })
            .collect();
        output.push_str(&cells.join("\t"));
        output.push('\n');
    }

    if output.len() > 15000 {
        format!(
            "{}...\n[Truncated — {} chars total]",
            &output[..15000],
            output.len()
        )
    } else {
        output
    }
}

fn read_csv(path: &str, max_rows: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();
            let display: Vec<&str> = lines.into_iter().take(max_rows + 1).collect();
            let mut out = display.join("\n");
            if total > max_rows + 1 {
                out.push_str(&format!("\n\n... [{} more rows]", total - max_rows - 1));
            }
            out
        }
        Err(e) => format!("Error reading CSV: {}", e),
    }
}

/// Create a simple XLSX file from tabular data.
/// `data` is a JSON array of arrays (rows).
pub fn create_spreadsheet(path: &str, data: &serde_json::Value, sheet_name: Option<&str>) -> String {
    use rust_xlsxwriter::{Workbook, Format};

    let rows = match data.as_array() {
        Some(r) => r,
        None => return "Error: 'data' must be a JSON array of arrays".into(),
    };

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    if let Some(name) = sheet_name {
        worksheet.set_name(name).ok();
    }

    let bold = Format::new().set_bold();

    for (row_idx, row) in rows.iter().enumerate() {
        if let Some(cells) = row.as_array() {
            for (col_idx, cell) in cells.iter().enumerate() {
                let r = row_idx as u32;
                let c = col_idx as u16;
                let fmt = if row_idx == 0 { Some(&bold) } else { None };

                match cell {
                    serde_json::Value::Number(n) => {
                        if let Some(f) = n.as_f64() {
                            if let Some(fmt) = fmt {
                                worksheet.write_number_with_format(r, c, f, fmt).ok();
                            } else {
                                worksheet.write_number(r, c, f).ok();
                            }
                        }
                    }
                    serde_json::Value::Bool(b) => {
                        worksheet.write_boolean(r, c, *b).ok();
                    }
                    _ => {
                        let s = cell.as_str().unwrap_or(&cell.to_string()).to_string();
                        if let Some(fmt) = fmt {
                            worksheet.write_string_with_format(r, c, &s, fmt).ok();
                        } else {
                            worksheet.write_string(r, c, &s).ok();
                        }
                    }
                }
            }
        }
    }

    match workbook.save(path) {
        Ok(_) => format!("Created spreadsheet: {} ({} rows)", path, rows.len()),
        Err(e) => format!("Failed to save spreadsheet: {}", e),
    }
}

/// Extract text from a DOCX file (unzip + parse XML).
pub fn read_docx_text(path: &str) -> String {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return format!("Error opening file: {}", e),
    };

    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => return format!("Error reading DOCX (not a valid zip): {}", e),
    };

    // Read word/document.xml
    let xml_content = match archive.by_name("word/document.xml") {
        Ok(mut f) => {
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut f, &mut buf).ok();
            buf
        }
        Err(_) => return "Error: word/document.xml not found in DOCX".into(),
    };

    // Parse XML to extract text runs
    extract_text_from_docx_xml(&xml_content)
}

fn extract_text_from_docx_xml(xml: &str) -> String {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut output = String::new();
    let mut in_text = false;
    let mut in_paragraph = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match name.as_str() {
                    "w:p" => in_paragraph = true,
                    "w:t" => in_text = true,
                    "w:tab" => output.push('\t'),
                    "w:br" => output.push('\n'),
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match name.as_str() {
                    "w:p" => {
                        if in_paragraph {
                            output.push('\n');
                            in_paragraph = false;
                        }
                    }
                    "w:t" => in_text = false,
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_text {
                    if let Ok(text) = e.unescape() {
                        output.push_str(&text);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                output.push_str(&format!("\n[XML parse error: {}]", e));
                break;
            }
            _ => {}
        }
    }

    if output.len() > 15000 {
        format!(
            "{}...\n\n[Truncated — {} chars total]",
            &output[..15000],
            output.len()
        )
    } else {
        output
    }
}

/// Create a basic DOCX file with text content.
pub fn create_docx(path: &str, content: &str) -> String {
    use docx_rs::*;

    let mut doc = Docx::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            // Heading 1
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(&trimmed[2..]).bold())
                    .style("Heading1"),
            );
        } else if trimmed.starts_with("## ") {
            // Heading 2
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(&trimmed[3..]).bold())
                    .style("Heading2"),
            );
        } else if trimmed.starts_with("### ") {
            // Heading 3
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(&trimmed[4..]).bold())
                    .style("Heading3"),
            );
        } else if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            // Bullet list
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(&trimmed[2..]))
                    .numbering(NumberingId::new(1), IndentLevel::new(0)),
            );
        } else if trimmed.is_empty() {
            doc = doc.add_paragraph(Paragraph::new());
        } else {
            doc = doc.add_paragraph(
                Paragraph::new().add_run(Run::new().add_text(line)),
            );
        }
    }

    let mut buf = Cursor::new(Vec::new());
    match doc.build().pack(&mut buf) {
        Ok(_) => match std::fs::write(path, buf.into_inner()) {
            Ok(_) => format!("Created DOCX: {}", path),
            Err(e) => format!("Failed to write file: {}", e),
        },
        Err(e) => format!("Failed to build DOCX: {}", e),
    }
}

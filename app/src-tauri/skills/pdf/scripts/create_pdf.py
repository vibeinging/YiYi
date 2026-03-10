#!/usr/bin/env python3
"""
Professional PDF Generator — produces beautiful, content-rich PDF documents.

Usage:
    python create_pdf.py <structure.json> <output.pdf>

The JSON structure file defines the document layout:
{
  "title": "Document Title",
  "subtitle": "Optional subtitle",
  "author": "Author Name",
  "date": "2024-01-01",
  "header": "Header text (appears on every page)",
  "footer": "Footer text (appears on every page)",
  "theme": "professional" | "minimal" | "modern",
  "page_size": "A4" | "letter",
  "toc_title": "目录",
  "body": [
    { "type": "heading", "level": 1, "text": "Section Title" },
    { "type": "paragraph", "text": "Body text...", "indent": false },
    { "type": "quote", "text": "A blockquote..." },
    { "type": "list", "style": "bullet" | "number", "items": ["Item 1", "Item 2"] },
    { "type": "table", "headers": ["Col1", "Col2"], "rows": [["a", "b"], ["c", "d"]] },
    { "type": "code", "language": "python", "text": "print('hello')" },
    { "type": "divider" },
    { "type": "spacer", "height": 10 },
    { "type": "key_value", "items": [{"key": "Name", "value": "John"}, ...] },
    { "type": "image", "path": "/path/to/image.png", "width": 150, "caption": "Figure 1" },
    { "type": "page_break" },
    { "type": "toc" }
  ]
}
"""
import json
import re
import sys
import os
import subprocess


def ensure_fpdf2():
    """Install fpdf2 if not available."""
    try:
        import fpdf
        return True
    except ImportError:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "fpdf2", "--quiet"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except Exception as e:
            print(f"Error: fpdf2 is required. Install with: pip install fpdf2\n{e}")
            return False


if not ensure_fpdf2():
    sys.exit(1)

from fpdf import FPDF, XPos, YPos


# ── Helpers ────────────────────────────────────────────────────────

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]")


def _has_cjk_chars(text: str) -> bool:
    """Detect if text contains CJK characters."""
    return bool(_CJK_RE.search(text))


# ── Theme definitions ──────────────────────────────────────────────

THEMES = {
    "professional": {
        "primary": (41, 65, 122),       # Deep navy
        "secondary": (89, 89, 89),      # Dark gray
        "accent": (0, 122, 204),        # Blue accent
        "bg_light": (245, 247, 250),    # Light blue-gray
        "bg_table_header": (41, 65, 122),
        "text": (33, 33, 33),
        "text_light": (120, 120, 120),
        "border": (200, 210, 220),
        "quote_bar": (0, 122, 204),
        "quote_bg": (240, 245, 252),
        "code_bg": (40, 44, 52),
        "code_text": (220, 220, 220),
        "link": (0, 102, 187),
    },
    "minimal": {
        "primary": (0, 0, 0),
        "secondary": (100, 100, 100),
        "accent": (180, 0, 0),
        "bg_light": (248, 248, 248),
        "bg_table_header": (50, 50, 50),
        "text": (30, 30, 30),
        "text_light": (130, 130, 130),
        "border": (210, 210, 210),
        "quote_bar": (180, 0, 0),
        "quote_bg": (248, 244, 244),
        "code_bg": (245, 245, 245),
        "code_text": (40, 40, 40),
        "link": (0, 0, 180),
    },
    "modern": {
        "primary": (99, 55, 216),       # Purple
        "secondary": (75, 85, 99),
        "accent": (236, 72, 153),       # Pink
        "bg_light": (249, 245, 255),    # Light purple
        "bg_table_header": (99, 55, 216),
        "text": (31, 41, 55),
        "text_light": (107, 114, 128),
        "border": (209, 213, 219),
        "quote_bar": (236, 72, 153),
        "quote_bg": (253, 242, 248),
        "code_bg": (30, 30, 46),
        "code_text": (205, 214, 244),
        "link": (99, 55, 216),
    },
}


class ProfessionalPDF(FPDF):
    """PDF generator with professional styling."""

    def __init__(self, structure: dict):
        page_size = structure.get("page_size", "A4").upper()
        super().__init__(orientation="P", unit="mm", format=page_size)

        self.structure = structure
        self.theme_name = structure.get("theme", "professional")
        self.theme = THEMES.get(self.theme_name, THEMES["professional"])

        self.doc_title = structure.get("title", "")
        self.doc_subtitle = structure.get("subtitle", "")
        self.doc_author = structure.get("author", "")
        self.doc_date = structure.get("date", "")
        self.doc_header = structure.get("header", "")
        self.doc_footer = structure.get("footer", "")

        # Auto-detect TOC title: use explicit value, or Chinese if title has CJK chars
        self.toc_title = structure.get("toc_title", None)
        if self.toc_title is None:
            self.toc_title = "目录" if _has_cjk_chars(self.doc_title) else "Table of Contents"

        self._toc_entries: list[tuple[int, str, int]] = []
        self._toc_placeholder_page: int | None = None
        self._toc_y_start = 0.0

        self.set_auto_page_break(auto=True, margin=25)
        self.set_margins(left=25, top=20, right=25)

        self._setup_fonts()

    # ── Font setup ──────────────────────────────────────────────────

    def _setup_fonts(self):
        """Register fonts with Unicode / CJK support."""
        self._body_font = "Helvetica"
        self._heading_font = "Helvetica"
        self._mono_font = "Courier"
        self._has_cjk = False

        cjk_font_paths = [
            # macOS
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
            # Linux
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf",
            # Windows
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simsun.ttc",
        ]
        for fp in cjk_font_paths:
            if os.path.exists(fp):
                try:
                    self.add_font("cjk", style="", fname=fp)
                    self.add_font("cjk", style="B", fname=fp)
                    self._body_font = "cjk"
                    self._heading_font = "cjk"
                    self._has_cjk = True
                    break
                except Exception:
                    continue

    def _italic_style(self) -> str:
        """Return 'I' for italic if supported, '' otherwise (CJK fonts lack italic)."""
        return "" if self._has_cjk else "I"

    # ── Theme helpers ───────────────────────────────────────────────

    def _set_color(self, name: str):
        r, g, b = self.theme[name]
        self.set_text_color(r, g, b)

    def _set_draw_color(self, name: str):
        r, g, b = self.theme[name]
        self.set_draw_color(r, g, b)

    def _set_fill_color(self, name: str):
        r, g, b = self.theme[name]
        self.set_fill_color(r, g, b)

    # ── Header / Footer ─────────────────────────────────────────────

    def header(self):
        """Page header — skip on cover page (page 1)."""
        if self.page_no() == 1:
            return
        if self.doc_header:
            self.set_font(self._body_font, "", 8)
            self._set_color("text_light")
            self.set_y(10)
            self.cell(0, 5, self.doc_header, align="L", new_x=XPos.RIGHT)
            self.cell(0, 5, f"{self.page_no()}", align="R",
                      new_x=XPos.LMARGIN, new_y=YPos.NEXT)
            self._set_draw_color("border")
            self.set_line_width(0.3)
            self.line(self.l_margin, 17, self.w - self.r_margin, 17)
            self.set_y(22)

    def footer(self):
        """Page footer — skip on cover page (page 1)."""
        if self.page_no() == 1:
            return
        self.set_y(-15)
        self.set_font(self._body_font, "", 8)
        self._set_color("text_light")
        self._set_draw_color("border")
        self.set_line_width(0.3)
        self.line(self.l_margin, self.h - 18, self.w - self.r_margin, self.h - 18)
        footer_text = self.doc_footer or self.doc_title
        if footer_text:
            self.cell(0, 10, footer_text, align="L", new_x=XPos.RIGHT)
        self.cell(0, 10, f"- {self.page_no()} -", align="R")

    # ── Cover page ──────────────────────────────────────────────────

    def add_cover_page(self):
        """Generate a professional cover page."""
        self.add_page()

        # Top accent bar
        r, g, b = self.theme["primary"]
        self.set_fill_color(r, g, b)
        self.rect(0, 0, self.w, 5, "F")

        # Decorative side accent
        ar, ag, ab = self.theme["accent"]
        self.set_fill_color(ar, ag, ab)
        self.rect(0, 5, 3, self.h - 10, "F")

        # Title area — centered vertically
        y_start = self.h * 0.32

        if self.doc_title:
            self.set_y(y_start)
            self.set_font(self._heading_font, "B", 30)
            self._set_color("primary")
            self.multi_cell(0, 15, self.doc_title, align="C")
            self.ln(3)

        if self.doc_subtitle:
            self.set_font(self._body_font, "", 13)
            self._set_color("secondary")
            self.multi_cell(0, 7.5, self.doc_subtitle, align="C")
            self.ln(8)

        # Decorative center line
        line_y = self.get_y() + 6
        cx = self.w / 2
        self._set_draw_color("accent")
        self.set_line_width(0.8)
        self.line(cx - 35, line_y, cx + 35, line_y)

        # Author and date
        if self.doc_author or self.doc_date:
            self.set_y(line_y + 16)
            self.set_font(self._body_font, "", 11)
            self._set_color("text_light")
            parts = [p for p in [self.doc_author, self.doc_date] if p]
            self.multi_cell(0, 7, "  |  ".join(parts), align="C")

        # Bottom accent bar
        self.set_fill_color(r, g, b)
        self.rect(0, self.h - 5, self.w, 5, "F")

    # ── Table of Contents ───────────────────────────────────────────

    def add_toc_page(self):
        """Reserve a page for TOC (populated after all content is rendered)."""
        self._toc_placeholder_page = self.page_no() + 1
        self.add_page()

        self.set_font(self._heading_font, "B", 22)
        self._set_color("primary")
        self.cell(0, 14, self.toc_title,
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(6)

        # Thin accent line under title
        self._set_draw_color("accent")
        self.set_line_width(0.6)
        self.line(self.l_margin, self.get_y(),
                  self.l_margin + 50, self.get_y())
        self.ln(8)
        self._toc_y_start = self.get_y()

    def _record_toc(self, level: int, text: str):
        self._toc_entries.append((level, text, self.page_no()))

    def render_toc(self):
        """Render TOC entries on the reserved page."""
        if self._toc_placeholder_page is None or not self._toc_entries:
            return
        self.page = self._toc_placeholder_page
        self.set_y(self._toc_y_start)

        for level, text, page_num in self._toc_entries:
            indent = (level - 1) * 10
            self.set_x(self.l_margin + indent)

            if level == 1:
                self.set_font(self._body_font, "B", 11)
                self._set_color("text")
            elif level == 2:
                self.set_font(self._body_font, "", 10.5)
                self._set_color("secondary")
            else:
                self.set_font(self._body_font, "", 10)
                self._set_color("text_light")

            w_avail = self.w - self.l_margin - self.r_margin - indent - 15

            # Dotted leader
            title_w = self.get_string_width(text)
            self.cell(min(title_w + 2, w_avail), 8, text, new_x=XPos.RIGHT)

            # Fill with dots
            dot_start_x = self.get_x()
            dot_end_x = self.w - self.r_margin - 15
            if dot_end_x > dot_start_x + 5:
                self.set_font(self._body_font, "", 8)
                self._set_color("border")
                dot_text = " ." * int((dot_end_x - dot_start_x) / 2.5)
                self.cell(dot_end_x - dot_start_x, 8, dot_text, new_x=XPos.RIGHT)

            # Page number
            self.set_font(self._body_font, "B" if level == 1 else "", 10)
            self._set_color("accent")
            self.cell(15, 8, str(page_num), align="R",
                      new_x=XPos.LMARGIN, new_y=YPos.NEXT)

            if level == 1:
                self.ln(1.5)

        # Restore to last page
        self.page = len(self.pages)

    # ── Content renderers ───────────────────────────────────────────

    def render_heading(self, level: int, text: str):
        """Render a heading (level 1-3)."""
        self._record_toc(level, text)

        sizes = {1: 19, 2: 15, 3: 12.5}
        spacings = {1: 12, 2: 9, 3: 6}

        # Page break guard — keep heading with following content
        if self.get_y() > self.h - 45:
            self.add_page()

        self.ln(spacings.get(level, 5))

        if level == 1:
            # Level 1: colored sidebar accent bar + large text
            y_top = self.get_y()
            self.set_x(self.l_margin + 8)
            self.set_font(self._heading_font, "B", sizes[level])
            self._set_color("primary")
            self.multi_cell(self.w - self.l_margin - self.r_margin - 8, 11, text)
            y_bot = self.get_y()
            # Draw bar after we know the text height
            self._set_fill_color("primary")
            bar_h = max(y_bot - y_top, 11)
            self.rect(self.l_margin, y_top, 3.5, bar_h, "F")
        elif level == 2:
            self.set_font(self._heading_font, "B", sizes[level])
            self._set_color("text")
            self.multi_cell(0, 9, text)
            # Subtle underline
            self._set_draw_color("border")
            self.set_line_width(0.4)
            y = self.get_y() + 1.5
            self.line(self.l_margin, y, self.w - self.r_margin, y)
            self.ln(1.5)
        else:
            self.set_font(self._heading_font, "B", sizes[level])
            self._set_color("secondary")
            self.multi_cell(0, 7.5, text)

        self.ln(4)

    def render_paragraph(self, text: str, indent: bool = False):
        """Render a paragraph with comfortable line spacing."""
        self.set_font(self._body_font, "", 10.5)
        self._set_color("text")
        x = self.l_margin + (10 if indent else 0)
        self.set_x(x)
        self.multi_cell(self.w - x - self.r_margin, 7, text)
        self.ln(3.5)

    def render_quote(self, text: str):
        """Render a blockquote with colored sidebar and tinted background."""
        self.ln(3)

        pad_x = 12    # left padding (bar + gap)
        pad_r = 8     # right padding inside bg
        pad_y = 4     # vertical padding

        x0 = self.l_margin
        cell_w = self.w - x0 - self.r_margin - pad_x - pad_r

        # First pass: measure text height
        self.set_font(self._body_font, self._italic_style(), 10.5)
        y_before = self.get_y()
        self.set_x(x0 + pad_x)
        self.multi_cell(cell_w, 6.5, text, dry_run=True)
        text_h = self.get_y() - y_before
        # multi_cell with dry_run doesn't advance Y in some fpdf2 versions; fallback
        if text_h <= 0:
            # Estimate: ~6.5mm per line, ~chars_per_line ≈ cell_w / 2.5
            cpl = max(cell_w / 2.5, 1)
            n_lines = max(len(text) / cpl, 1)
            text_h = n_lines * 6.5

        bg_h = text_h + pad_y * 2
        bg_y = self.get_y()

        # Background rectangle
        r, g, b = self.theme["quote_bg"]
        self.set_fill_color(r, g, b)
        self.rect(x0 + 5, bg_y, cell_w + pad_x + pad_r - 5, bg_h, "F")

        # Accent bar
        br, bg_, bb = self.theme["quote_bar"]
        self.set_fill_color(br, bg_, bb)
        self.rect(x0 + 4, bg_y, 2.5, bg_h, "F")

        # Render text
        self.set_xy(x0 + pad_x, bg_y + pad_y)
        self.set_font(self._body_font, self._italic_style(), 10.5)
        self._set_color("secondary")
        self.multi_cell(cell_w, 6.5, text)

        self.set_y(bg_y + bg_h + 2)
        self.ln(3)

    def render_list(self, items: list, style: str = "bullet", start: int = 1):
        """Render a bullet or numbered list."""
        self.ln(1)

        for i, item in enumerate(items):
            x = self.l_margin + 8
            marker = f"{start + i}." if style == "number" else "\u2022"

            self.set_x(x)
            # Marker
            self.set_font(self._body_font, "B", 10.5)
            self._set_color("accent")
            marker_w = 10 if style == "number" else 6
            self.cell(marker_w, 7, marker, new_x=XPos.RIGHT)
            # Item text
            self.set_font(self._body_font, "", 10.5)
            self._set_color("text")
            self.multi_cell(
                self.w - x - marker_w - self.r_margin, 7, str(item))
            self.ln(1.5)

        self.ln(3)

    def render_table(self, headers: list, rows: list):
        """Render a styled table with rounded header and alternating rows."""
        self.ln(4)

        n_cols = len(headers)
        if n_cols == 0:
            return
        avail_w = self.w - self.l_margin - self.r_margin
        col_w = avail_w / n_cols
        row_h_header = 10
        row_h_data = 8

        # ── Header row ──
        hr, hg, hb = self.theme["bg_table_header"]
        self.set_fill_color(hr, hg, hb)
        self.set_font(self._body_font, "B", 9.5)
        self.set_text_color(255, 255, 255)
        for h in headers:
            self.cell(col_w, row_h_header, str(h),
                      border=0, fill=True, align="C", new_x=XPos.RIGHT)
        self.ln()

        # ── Data rows ──
        self.set_font(self._body_font, "", 9.5)
        for row_idx, row in enumerate(rows):
            even = row_idx % 2 == 0
            if even:
                self._set_fill_color("bg_light")
            else:
                self.set_fill_color(255, 255, 255)

            self._set_color("text")

            # Page break → re-draw header
            if self.get_y() + row_h_data > self.h - 25:
                self.add_page()
                self.set_fill_color(hr, hg, hb)
                self.set_font(self._body_font, "B", 9.5)
                self.set_text_color(255, 255, 255)
                for h in headers:
                    self.cell(col_w, row_h_header, str(h),
                              border=0, fill=True, align="C",
                              new_x=XPos.RIGHT)
                self.ln()
                self.set_font(self._body_font, "", 9.5)
                if even:
                    self._set_fill_color("bg_light")
                else:
                    self.set_fill_color(255, 255, 255)
                self._set_color("text")

            for cell_val in row:
                self.cell(col_w, row_h_data, str(cell_val),
                          border=0, fill=True, align="C",
                          new_x=XPos.RIGHT)
            self.ln()

        # Bottom border line
        self._set_draw_color("border")
        self.set_line_width(0.3)
        y = self.get_y()
        self.line(self.l_margin, y, self.l_margin + avail_w, y)
        self.ln(5)

    def render_code(self, text: str, language: str = ""):
        """Render a code block with dark background."""
        self.ln(3)

        x = self.l_margin
        w = self.w - self.l_margin - self.r_margin
        lines = text.split("\n")
        line_h = 5.0
        pad_top = 4
        pad_bot = 4
        badge_h = 6 if language else 0
        block_h = len(lines) * line_h + pad_top + pad_bot + badge_h

        # Page break guard
        if self.get_y() + block_h > self.h - 25:
            self.add_page()

        y_start = self.get_y()

        # Full background
        cr, cg, cb = self.theme["code_bg"]
        self.set_fill_color(cr, cg, cb)
        self.rect(x, y_start, w, block_h, "F")

        # Language badge (top-right)
        if language:
            self.set_font(self._mono_font, "", 7.5)
            self.set_text_color(140, 140, 140)
            self.set_xy(x + w - self.get_string_width(language) - 8,
                        y_start + 1.5)
            self.cell(0, 4, language)

        # Code text
        tr, tg, tb = self.theme["code_text"]
        self.set_text_color(tr, tg, tb)
        self.set_font(self._mono_font, "", 9)
        self.set_xy(x + 6, y_start + pad_top + badge_h)
        for line in lines:
            self.set_x(x + 6)
            self.cell(w - 12, line_h, line,
                      new_x=XPos.LMARGIN, new_y=YPos.NEXT)

        self.set_y(y_start + block_h)
        self.ln(5)

    def render_divider(self):
        """Render a centered horizontal divider."""
        self.ln(5)
        y = self.get_y()
        cx = self.w / 2
        self._set_draw_color("border")
        self.set_line_width(0.4)
        self.line(cx - 45, y, cx + 45, y)
        self.ln(7)

    def render_key_value(self, items: list):
        """Render key-value pairs in a clean two-column layout."""
        self.ln(3)
        key_w = 55

        for idx, item in enumerate(items):
            key = str(item.get("key", ""))
            value = str(item.get("value", ""))

            y_row = self.get_y()

            # Light background for alternating rows
            if idx % 2 == 0:
                self._set_fill_color("bg_light")
                self.rect(self.l_margin, y_row,
                          self.w - self.l_margin - self.r_margin, 8, "F")

            self.set_x(self.l_margin + 5)
            self.set_font(self._body_font, "B", 10)
            self._set_color("secondary")
            self.cell(key_w, 8, key, new_x=XPos.RIGHT)
            self.set_font(self._body_font, "", 10)
            self._set_color("text")
            self.multi_cell(
                self.w - self.l_margin - self.r_margin - key_w - 5, 8, value)

        self.ln(4)

    def render_image(self, path: str, width: int = 150, caption: str = ""):
        """Render an image (centered) with optional caption."""
        if not os.path.exists(path):
            self.render_paragraph(f"[Image not found: {path}]")
            return

        self.ln(4)
        img_x = (self.w - width) / 2
        try:
            self.image(path, x=img_x, w=width)
        except Exception as e:
            self.render_paragraph(f"[Failed to load image: {e}]")
            return

        if caption:
            self.ln(2)
            self.set_font(self._body_font, self._italic_style(), 9)
            self._set_color("text_light")
            self.multi_cell(0, 5.5, caption, align="C")
        self.ln(4)

    # ── Main build ──────────────────────────────────────────────────

    def build(self, output_path: str):
        """Build the complete PDF document."""
        body = self.structure.get("body", [])

        # Cover page
        if self.doc_title:
            self.add_cover_page()

        has_toc = any(b.get("type") == "toc" for b in body)
        toc_rendered = False

        if not has_toc:
            self.add_page()

        for block in body:
            btype = block.get("type", "paragraph")

            if btype == "toc":
                if not toc_rendered:
                    self.add_toc_page()
                    toc_rendered = True
                    self.add_page()

            elif btype == "heading":
                self.render_heading(
                    block.get("level", 1), block.get("text", ""))

            elif btype == "paragraph":
                self.render_paragraph(
                    block.get("text", ""),
                    indent=block.get("indent", False))

            elif btype == "quote":
                self.render_quote(block.get("text", ""))

            elif btype == "list":
                self.render_list(
                    block.get("items", []),
                    style=block.get("style", "bullet"),
                    start=block.get("start", 1))

            elif btype == "table":
                self.render_table(
                    block.get("headers", []),
                    block.get("rows", []))

            elif btype == "code":
                self.render_code(
                    block.get("text", ""),
                    language=block.get("language", ""))

            elif btype == "divider":
                self.render_divider()

            elif btype == "spacer":
                self.ln(block.get("height", 10))

            elif btype == "key_value":
                self.render_key_value(block.get("items", []))

            elif btype == "image":
                self.render_image(
                    block.get("path", ""),
                    width=block.get("width", 150),
                    caption=block.get("caption", ""))

            elif btype == "page_break":
                self.add_page()

        # Finalize TOC with actual page numbers
        if toc_rendered:
            self.render_toc()

        self.output(output_path)
        size_kb = os.path.getsize(output_path) / 1024
        print(f"PDF created: {output_path} ({size_kb:.1f} KB, {self.pages_count} pages)")


def main():
    if len(sys.argv) < 3:
        print("Usage: python create_pdf.py <structure.json> <output.pdf>")
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as f:
        structure = json.load(f)

    pdf = ProfessionalPDF(structure)
    pdf.build(sys.argv[2])


if __name__ == "__main__":
    main()

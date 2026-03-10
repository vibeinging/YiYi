#!/usr/bin/env python3
"""
Professional PPTX Generator — produces polished presentation decks.

Usage:
    python create_pptx.py <structure.json> <output.pptx>

JSON structure:
{
  "title": "Presentation Title",
  "subtitle": "Optional subtitle",
  "author": "Author Name",
  "date": "2024-01-01",
  "theme": "dark" | "light" | "corporate",
  "slides": [
    { "type": "title", "title": "Main Title", "subtitle": "Subtitle text" },
    { "type": "section", "title": "Section Name" },
    { "type": "content", "title": "Slide Title", "body": ["Bullet 1", "Bullet 2"] },
    { "type": "two_column", "title": "Title", "left": ["Left items"], "right": ["Right items"] },
    { "type": "table", "title": "Title", "headers": ["A", "B"], "rows": [["1", "2"]] },
    { "type": "quote", "text": "Quote text", "author": "Author" },
    { "type": "image", "title": "Title", "path": "/path/to/image.png", "caption": "Fig 1" },
    { "type": "key_metrics", "title": "Title", "metrics": [{"label": "Revenue", "value": "$10M", "change": "+15%"}] },
    { "type": "timeline", "title": "Title", "events": [{"date": "Q1", "text": "Launch"}] },
    { "type": "blank" },
    { "type": "thank_you", "title": "Thank You", "contact": "email@example.com" }
  ]
}
"""
import json
import sys
import os
import subprocess


def ensure_pptx():
    """Install python-pptx if not available."""
    try:
        import pptx
        return True
    except ImportError:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "python-pptx", "--quiet"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception as e:
            print(f"Error: python-pptx is required. Install with: pip install python-pptx\n{e}")
            return False


if not ensure_pptx():
    sys.exit(1)

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE


# ── Theme definitions ──────────────────────────────────────────────

THEMES = {
    "dark": {
        "bg": RGBColor(0x1A, 0x1A, 0x2E),
        "bg_alt": RGBColor(0x16, 0x21, 0x3E),
        "primary": RGBColor(0x00, 0x7A, 0xCC),
        "accent": RGBColor(0x00, 0xD4, 0xFF),
        "text": RGBColor(0xF0, 0xF0, 0xF0),
        "text_secondary": RGBColor(0xA0, 0xA8, 0xB8),
        "text_muted": RGBColor(0x70, 0x78, 0x88),
        "highlight": RGBColor(0xFF, 0xD7, 0x00),
        "table_header_bg": RGBColor(0x00, 0x7A, 0xCC),
        "table_row_even": RGBColor(0x20, 0x2A, 0x44),
        "table_row_odd": RGBColor(0x1A, 0x1A, 0x2E),
        "border": RGBColor(0x3A, 0x40, 0x55),
    },
    "light": {
        "bg": RGBColor(0xFF, 0xFF, 0xFF),
        "bg_alt": RGBColor(0xF5, 0xF7, 0xFA),
        "primary": RGBColor(0x29, 0x41, 0x7A),
        "accent": RGBColor(0x00, 0x7A, 0xCC),
        "text": RGBColor(0x21, 0x21, 0x21),
        "text_secondary": RGBColor(0x59, 0x59, 0x59),
        "text_muted": RGBColor(0x90, 0x90, 0x90),
        "highlight": RGBColor(0xE8, 0x6B, 0x00),
        "table_header_bg": RGBColor(0x29, 0x41, 0x7A),
        "table_row_even": RGBColor(0xF5, 0xF7, 0xFA),
        "table_row_odd": RGBColor(0xFF, 0xFF, 0xFF),
        "border": RGBColor(0xD0, 0xD5, 0xDD),
    },
    "corporate": {
        "bg": RGBColor(0xFF, 0xFF, 0xFF),
        "bg_alt": RGBColor(0xEE, 0xF2, 0xF7),
        "primary": RGBColor(0x0D, 0x2B, 0x4E),
        "accent": RGBColor(0xC0, 0x39, 0x2B),
        "text": RGBColor(0x1A, 0x1A, 0x1A),
        "text_secondary": RGBColor(0x4A, 0x4A, 0x4A),
        "text_muted": RGBColor(0x80, 0x80, 0x80),
        "highlight": RGBColor(0xC0, 0x39, 0x2B),
        "table_header_bg": RGBColor(0x0D, 0x2B, 0x4E),
        "table_row_even": RGBColor(0xF4, 0xF6, 0xF9),
        "table_row_odd": RGBColor(0xFF, 0xFF, 0xFF),
        "border": RGBColor(0xC8, 0xCE, 0xD6),
    },
}


class ProfessionalPPTX:
    """PPTX generator with professional styling."""

    def __init__(self, structure: dict):
        self.structure = structure
        self.prs = Presentation()
        # 16:9 widescreen
        self.prs.slide_width = Inches(13.333)
        self.prs.slide_height = Inches(7.5)

        self.theme_name = structure.get("theme", "dark")
        self.t = THEMES.get(self.theme_name, THEMES["dark"])

        self.doc_title = structure.get("title", "")
        self.doc_subtitle = structure.get("subtitle", "")
        self.doc_author = structure.get("author", "")
        self.doc_date = structure.get("date", "")

        self.slide_w = self.prs.slide_width
        self.slide_h = self.prs.slide_height

    # ── Helpers ──────────────────────────────────────────────────────

    def _add_bg(self, slide, color_key="bg"):
        """Set solid background color."""
        bg = slide.background
        fill = bg.fill
        fill.solid()
        fill.fore_color.rgb = self.t[color_key]

    def _add_shape(self, slide, left, top, width, height, color):
        """Add a colored rectangle shape."""
        shape = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE, left, top, width, height)
        shape.fill.solid()
        shape.fill.fore_color.rgb = color
        shape.line.fill.background()
        return shape

    def _add_text_box(self, slide, left, top, width, height,
                      text, font_size=18, color=None, bold=False,
                      alignment=PP_ALIGN.LEFT, font_name=None):
        """Add a text box with styled text."""
        txBox = slide.shapes.add_textbox(left, top, width, height)
        tf = txBox.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = text
        p.font.size = Pt(font_size)
        p.font.color.rgb = color or self.t["text"]
        p.font.bold = bold
        p.alignment = alignment
        if font_name:
            p.font.name = font_name
        return txBox

    def _add_bullet_list(self, slide, left, top, width, height,
                         items, font_size=16, color=None):
        """Add a bulleted list."""
        txBox = slide.shapes.add_textbox(left, top, width, height)
        tf = txBox.text_frame
        tf.word_wrap = True

        for i, item in enumerate(items):
            if i == 0:
                p = tf.paragraphs[0]
            else:
                p = tf.add_paragraph()
            p.text = item
            p.font.size = Pt(font_size)
            p.font.color.rgb = color or self.t["text"]
            p.space_after = Pt(8)
            p.level = 0
            # Bullet marker via indent
            p.space_before = Pt(4)
            # Add bullet character manually for clean look
            run = p.runs[0] if p.runs else p.add_run()
            run.text = f"  {item}"  # indent
            # Add a separate accent bullet
        return txBox

    def _add_styled_bullets(self, slide, left, top, width, height,
                            items, font_size=16):
        """Add styled bullet list with accent markers."""
        txBox = slide.shapes.add_textbox(left, top, width, height)
        tf = txBox.text_frame
        tf.word_wrap = True

        for i, item in enumerate(items):
            if i == 0:
                p = tf.paragraphs[0]
            else:
                p = tf.add_paragraph()

            # Bullet character
            run_bullet = p.add_run()
            run_bullet.text = "\u2022  "
            run_bullet.font.size = Pt(font_size)
            run_bullet.font.color.rgb = self.t["accent"]
            run_bullet.font.bold = True

            # Item text
            run_text = p.add_run()
            run_text.text = str(item)
            run_text.font.size = Pt(font_size)
            run_text.font.color.rgb = self.t["text"]

            p.space_after = Pt(10)
            p.space_before = Pt(2)

        return txBox

    def _page_number(self, slide, num, total):
        """Add page number in bottom right."""
        self._add_text_box(
            slide,
            self.slide_w - Inches(1.5), self.slide_h - Inches(0.5),
            Inches(1.2), Inches(0.4),
            f"{num} / {total}",
            font_size=10, color=self.t["text_muted"],
            alignment=PP_ALIGN.RIGHT,
        )

    # ── Slide types ─────────────────────────────────────────────────

    def slide_title(self, data: dict):
        """Title slide — big title + subtitle + metadata."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])  # blank
        self._add_bg(slide)

        # Left accent bar
        self._add_shape(slide, 0, 0, Inches(0.4), self.slide_h, self.t["primary"])

        # Top accent line
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.06), self.t["accent"])

        title = data.get("title", self.doc_title)
        subtitle = data.get("subtitle", self.doc_subtitle)

        # Title
        self._add_text_box(
            slide, Inches(1.5), Inches(2.2), Inches(10), Inches(2),
            title, font_size=44, bold=True, color=self.t["text"])

        # Subtitle
        if subtitle:
            self._add_text_box(
                slide, Inches(1.5), Inches(4.0), Inches(10), Inches(1),
                subtitle, font_size=20, color=self.t["text_secondary"])

        # Divider line
        self._add_shape(
            slide, Inches(1.5), Inches(5.2), Inches(3), Inches(0.04),
            self.t["accent"])

        # Author + date
        meta_parts = [p for p in [
            data.get("author", self.doc_author),
            data.get("date", self.doc_date)
        ] if p]
        if meta_parts:
            self._add_text_box(
                slide, Inches(1.5), Inches(5.5), Inches(8), Inches(0.5),
                "  |  ".join(meta_parts),
                font_size=14, color=self.t["text_muted"])

    def slide_section(self, data: dict):
        """Section divider slide."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide, "bg_alt")

        # Large accent bar on left
        self._add_shape(slide, 0, 0, Inches(0.5), self.slide_h, self.t["primary"])

        title = data.get("title", "")
        self._add_text_box(
            slide, Inches(1.5), Inches(2.5), Inches(10), Inches(2),
            title, font_size=40, bold=True, color=self.t["primary"])

        # Accent underline
        self._add_shape(
            slide, Inches(1.5), Inches(4.3), Inches(4), Inches(0.05),
            self.t["accent"])

        if data.get("subtitle"):
            self._add_text_box(
                slide, Inches(1.5), Inches(4.8), Inches(9), Inches(1),
                data["subtitle"], font_size=18, color=self.t["text_secondary"])

    def slide_content(self, data: dict):
        """Standard content slide with title + bullet points."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)

        # Top bar
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.04), self.t["primary"])

        title = data.get("title", "")
        body = data.get("body", [])

        # Title
        self._add_text_box(
            slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
            title, font_size=28, bold=True, color=self.t["text"])

        # Separator line under title
        self._add_shape(
            slide, Inches(0.8), Inches(1.3), Inches(11.5), Inches(0.02),
            self.t["border"])

        # Bullets
        if body:
            self._add_styled_bullets(
                slide, Inches(1.0), Inches(1.7), Inches(10.5), Inches(5),
                body, font_size=18)

    def slide_two_column(self, data: dict):
        """Two-column layout."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.04), self.t["primary"])

        title = data.get("title", "")
        left_items = data.get("left", [])
        right_items = data.get("right", [])
        left_title = data.get("left_title", "")
        right_title = data.get("right_title", "")

        # Title
        self._add_text_box(
            slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
            title, font_size=28, bold=True, color=self.t["text"])

        self._add_shape(
            slide, Inches(0.8), Inches(1.3), Inches(11.5), Inches(0.02),
            self.t["border"])

        col_w = Inches(5.2)
        y_start = Inches(1.7)

        # Left column
        if left_title:
            self._add_text_box(
                slide, Inches(0.8), y_start, col_w, Inches(0.5),
                left_title, font_size=18, bold=True, color=self.t["accent"])
            y_start_l = Inches(2.3)
        else:
            y_start_l = y_start

        self._add_styled_bullets(
            slide, Inches(0.8), y_start_l, col_w, Inches(4.5),
            left_items, font_size=16)

        # Center divider
        self._add_shape(
            slide, Inches(6.4), Inches(1.7), Inches(0.02), Inches(4.5),
            self.t["border"])

        # Right column
        if right_title:
            self._add_text_box(
                slide, Inches(6.8), y_start, col_w, Inches(0.5),
                right_title, font_size=18, bold=True, color=self.t["accent"])
            y_start_r = Inches(2.3)
        else:
            y_start_r = y_start

        self._add_styled_bullets(
            slide, Inches(6.8), y_start_r, col_w, Inches(4.5),
            right_items, font_size=16)

    def slide_table(self, data: dict):
        """Table slide."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.04), self.t["primary"])

        title = data.get("title", "")
        headers = data.get("headers", [])
        rows = data.get("rows", [])

        self._add_text_box(
            slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
            title, font_size=28, bold=True, color=self.t["text"])

        if not headers:
            return

        n_rows = len(rows) + 1  # +1 for header
        n_cols = len(headers)
        tbl_w = Inches(11.5)
        tbl_h = Inches(min(n_rows * 0.55, 5.5))

        table_shape = slide.shapes.add_table(
            n_rows, n_cols,
            Inches(0.8), Inches(1.6), tbl_w, tbl_h)
        table = table_shape.table

        col_w = int(tbl_w / n_cols)
        for i in range(n_cols):
            table.columns[i].width = col_w

        # Header row
        for j, h in enumerate(headers):
            cell = table.cell(0, j)
            cell.text = str(h)
            for p in cell.text_frame.paragraphs:
                p.font.size = Pt(14)
                p.font.bold = True
                p.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                p.alignment = PP_ALIGN.CENTER
            cell.fill.solid()
            cell.fill.fore_color.rgb = self.t["table_header_bg"]

        # Data rows
        for i, row in enumerate(rows):
            for j, val in enumerate(row):
                cell = table.cell(i + 1, j)
                cell.text = str(val)
                for p in cell.text_frame.paragraphs:
                    p.font.size = Pt(13)
                    p.font.color.rgb = self.t["text"]
                    p.alignment = PP_ALIGN.CENTER
                cell.fill.solid()
                if i % 2 == 0:
                    cell.fill.fore_color.rgb = self.t["table_row_even"]
                else:
                    cell.fill.fore_color.rgb = self.t["table_row_odd"]

    def slide_quote(self, data: dict):
        """Quote/callout slide."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide, "bg_alt")

        text = data.get("text", "")
        author = data.get("author", "")

        # Large quotation mark
        self._add_text_box(
            slide, Inches(1.5), Inches(1.0), Inches(2), Inches(2),
            "\u201C", font_size=120, color=self.t["accent"], bold=True)

        # Quote text
        self._add_text_box(
            slide, Inches(2.0), Inches(2.5), Inches(9), Inches(3),
            text, font_size=24, color=self.t["text"])

        # Author attribution
        if author:
            self._add_text_box(
                slide, Inches(2.0), Inches(5.5), Inches(9), Inches(0.5),
                f"— {author}", font_size=16, color=self.t["text_muted"])

    def slide_image(self, data: dict):
        """Image slide with title and caption."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.04), self.t["primary"])

        title = data.get("title", "")
        path = data.get("path", "")
        caption = data.get("caption", "")

        if title:
            self._add_text_box(
                slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
                title, font_size=28, bold=True, color=self.t["text"])

        if os.path.exists(path):
            try:
                # Center image
                max_w = Inches(10)
                max_h = Inches(5)
                y_top = Inches(1.6)
                slide.shapes.add_picture(
                    path,
                    (self.slide_w - max_w) // 2, y_top,
                    max_w)
            except Exception as e:
                self._add_text_box(
                    slide, Inches(2), Inches(3), Inches(8), Inches(1),
                    f"[Image error: {e}]", font_size=16, color=self.t["text_muted"])
        else:
            self._add_text_box(
                slide, Inches(2), Inches(3), Inches(8), Inches(1),
                f"[Image not found: {path}]", font_size=16, color=self.t["text_muted"])

        if caption:
            self._add_text_box(
                slide, Inches(1), Inches(6.8), Inches(11), Inches(0.5),
                caption, font_size=12, color=self.t["text_muted"],
                alignment=PP_ALIGN.CENTER)

    def slide_key_metrics(self, data: dict):
        """Key metrics / KPI dashboard slide."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.04), self.t["primary"])

        title = data.get("title", "")
        metrics = data.get("metrics", [])

        self._add_text_box(
            slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
            title, font_size=28, bold=True, color=self.t["text"])

        if not metrics:
            return

        n = len(metrics)
        card_w = min(Inches(2.8), (self.slide_w - Inches(2)) // n)
        total_w = card_w * n + Inches(0.3) * (n - 1)
        start_x = (self.slide_w - total_w) // 2
        card_h = Inches(3.0)
        card_y = Inches(2.5)

        for i, m in enumerate(metrics):
            x = start_x + i * (card_w + Inches(0.3))

            # Card background
            card = self._add_shape(slide, x, card_y, card_w, card_h, self.t["bg_alt"])

            # Value (big number)
            self._add_text_box(
                slide, x, card_y + Inches(0.5), card_w, Inches(1.2),
                m.get("value", ""), font_size=36, bold=True,
                color=self.t["accent"], alignment=PP_ALIGN.CENTER)

            # Label
            self._add_text_box(
                slide, x, card_y + Inches(1.6), card_w, Inches(0.6),
                m.get("label", ""), font_size=14,
                color=self.t["text_secondary"], alignment=PP_ALIGN.CENTER)

            # Change indicator
            change = m.get("change", "")
            if change:
                is_positive = change.startswith("+")
                change_color = RGBColor(0x22, 0xC5, 0x5E) if is_positive else RGBColor(0xEF, 0x44, 0x44)
                self._add_text_box(
                    slide, x, card_y + Inches(2.2), card_w, Inches(0.5),
                    change, font_size=16, bold=True,
                    color=change_color, alignment=PP_ALIGN.CENTER)

    def slide_timeline(self, data: dict):
        """Timeline / roadmap slide."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)
        self._add_shape(slide, 0, 0, self.slide_w, Inches(0.04), self.t["primary"])

        title = data.get("title", "")
        events = data.get("events", [])

        self._add_text_box(
            slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
            title, font_size=28, bold=True, color=self.t["text"])

        if not events:
            return

        n = len(events)
        line_y = Inches(3.8)
        line_x_start = Inches(1.5)
        line_x_end = self.slide_w - Inches(1.5)
        segment = (line_x_end - line_x_start) // max(n - 1, 1) if n > 1 else 0

        # Horizontal timeline line
        self._add_shape(slide, line_x_start, line_y, line_x_end - line_x_start, Inches(0.03), self.t["border"])

        for i, evt in enumerate(events):
            x = line_x_start + segment * i if n > 1 else (self.slide_w // 2)

            # Dot on timeline
            dot = self._add_shape(
                slide,
                x - Inches(0.12), line_y - Inches(0.1),
                Inches(0.24), Inches(0.24),
                self.t["accent"])

            # Date label (above)
            self._add_text_box(
                slide, x - Inches(1), line_y - Inches(1.0), Inches(2), Inches(0.5),
                evt.get("date", ""), font_size=14, bold=True,
                color=self.t["accent"], alignment=PP_ALIGN.CENTER)

            # Event text (below)
            self._add_text_box(
                slide, x - Inches(1.2), line_y + Inches(0.4), Inches(2.4), Inches(1.5),
                evt.get("text", ""), font_size=13,
                color=self.t["text_secondary"], alignment=PP_ALIGN.CENTER)

    def slide_thank_you(self, data: dict):
        """Thank you / closing slide."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide, "bg_alt")

        # Accent bar
        self._add_shape(slide, 0, 0, Inches(0.4), self.slide_h, self.t["primary"])
        self._add_shape(slide, 0, self.slide_h - Inches(0.06), self.slide_w, Inches(0.06), self.t["accent"])

        title = data.get("title", "Thank You")
        contact = data.get("contact", "")
        message = data.get("message", "")

        self._add_text_box(
            slide, Inches(1.5), Inches(2.2), Inches(10), Inches(2),
            title, font_size=44, bold=True, color=self.t["text"])

        if message:
            self._add_text_box(
                slide, Inches(1.5), Inches(4.0), Inches(10), Inches(1),
                message, font_size=18, color=self.t["text_secondary"])

        if contact:
            self._add_text_box(
                slide, Inches(1.5), Inches(5.5), Inches(10), Inches(0.5),
                contact, font_size=14, color=self.t["text_muted"])

    def slide_blank(self, data: dict):
        """Blank slide with just background."""
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        self._add_bg(slide)

    # ── Build ───────────────────────────────────────────────────────

    def build(self, output_path: str):
        slides = self.structure.get("slides", [])
        total = len(slides)

        dispatch = {
            "title": self.slide_title,
            "section": self.slide_section,
            "content": self.slide_content,
            "two_column": self.slide_two_column,
            "table": self.slide_table,
            "quote": self.slide_quote,
            "image": self.slide_image,
            "key_metrics": self.slide_key_metrics,
            "timeline": self.slide_timeline,
            "thank_you": self.slide_thank_you,
            "blank": self.slide_blank,
        }

        for slide_data in slides:
            stype = slide_data.get("type", "content")
            handler = dispatch.get(stype, self.slide_content)
            handler(slide_data)

        # Add page numbers (skip title slide)
        for i, slide in enumerate(self.prs.slides):
            if i > 0:
                self._page_number(slide, i, total - 1)

        self.prs.save(output_path)
        size_kb = os.path.getsize(output_path) / 1024
        print(f"PPTX created: {output_path} ({size_kb:.1f} KB, {total} slides)")


def main():
    if len(sys.argv) < 3:
        print("Usage: python create_pptx.py <structure.json> <output.pptx>")
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as f:
        structure = json.load(f)

    pptx = ProfessionalPPTX(structure)
    pptx.build(sys.argv[2])


if __name__ == "__main__":
    main()

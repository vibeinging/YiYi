---
name: pdf
description: "Use this skill whenever the user wants to do anything with PDF files — reading, extracting, creating professional documents, filling forms."
metadata:
  {
    "yiyi":
      {
        "emoji": "📄",
        "requires": {}
      }
  }
---

# PDF Processing

## Reading & Extracting Text

**Use the built-in `read_pdf` tool** — no external software needed:

```
read_pdf(path="/path/to/document.pdf")
```

This extracts all text content from the PDF. Then summarize, analyze, or answer questions about the content.

## For Tables in PDFs

1. Use `read_pdf` to extract raw text
2. Parse the tabular structure from the text output
3. If the user wants it as a spreadsheet, use `create_spreadsheet` to output as .xlsx

---

## Creating Professional PDFs

Use the `create_pdf.py` script to generate beautiful, content-rich PDF documents.

### Step 1: Build a JSON structure file

Create a JSON file describing the document content. **Be thorough and detailed — include rich content, not just bullet points.**

```json
{
  "title": "Document Title",
  "subtitle": "A detailed subtitle explaining the document purpose",
  "author": "Author Name",
  "date": "2024-01-15",
  "header": "Document Title — Confidential",
  "footer": "© 2024 Company Name",
  "theme": "professional",
  "page_size": "A4",
  "body": [
    { "type": "toc" },
    { "type": "heading", "level": 1, "text": "Introduction" },
    { "type": "paragraph", "text": "Write full, detailed paragraphs here. Avoid short one-liners. Each paragraph should be 3-5 sentences with substantive content that provides real value to the reader." },
    ...
  ]
}
```

### Step 2: Run the script

```bash
python3 scripts/create_pdf.py structure.json output.pdf
```

### Available Themes

| Theme | Style |
|-------|-------|
| `professional` | Navy + blue accents, corporate feel |
| `minimal` | Black + red accents, clean typography |
| `modern` | Purple + pink accents, contemporary |

### Content Block Types

#### Headings (3 levels)
```json
{ "type": "heading", "level": 1, "text": "Major Section" }
{ "type": "heading", "level": 2, "text": "Subsection" }
{ "type": "heading", "level": 3, "text": "Sub-subsection" }
```

#### Paragraph
```json
{ "type": "paragraph", "text": "Full paragraph text. Write detailed, multi-sentence content.", "indent": false }
```

#### Blockquote
```json
{ "type": "quote", "text": "Important insight or notable quote from a source." }
```

#### Bullet / Numbered List
```json
{ "type": "list", "style": "bullet", "items": ["First point with explanation", "Second point with detail"] }
{ "type": "list", "style": "number", "items": ["Step one", "Step two"], "start": 1 }
```

#### Table
```json
{ "type": "table", "headers": ["Name", "Role", "Department"], "rows": [["Alice", "Engineer", "R&D"], ["Bob", "Designer", "Product"]] }
```

#### Code Block
```json
{ "type": "code", "language": "python", "text": "def hello():\n    print('Hello, World!')" }
```

#### Key-Value Pairs (clean metadata display)
```json
{ "type": "key_value", "items": [{"key": "Project", "value": "Phoenix"}, {"key": "Status", "value": "Active"}] }
```

#### Image
```json
{ "type": "image", "path": "/absolute/path/to/image.png", "width": 150, "caption": "Figure 1: Architecture diagram" }
```

#### Layout Controls
```json
{ "type": "divider" }
{ "type": "spacer", "height": 10 }
{ "type": "page_break" }
{ "type": "toc" }
```

### Content Writing Guidelines

When generating PDF content, follow these rules to produce professional documents:

1. **Be thorough**: Each section should have multiple paragraphs, not just one sentence. Expand on ideas, provide context, and include supporting details.

2. **Structure deeply**: Use all three heading levels. A good document has:
   - Level 1: Major sections (3-6 per document)
   - Level 2: Subsections (2-4 per major section)
   - Level 3: Specific topics (as needed)

3. **Mix content types**: Don't just use paragraphs. Include:
   - Tables for comparative data
   - Lists for actionable items or enumerations
   - Quotes for key insights or citations
   - Code blocks for technical content
   - Key-value pairs for metadata/specs

4. **Write full paragraphs**: Each paragraph should be 3-5 sentences. Avoid one-liners.

5. **Always include**:
   - Table of Contents (`{"type": "toc"}` as first body item)
   - Cover page info (title, subtitle, author, date)
   - Header and footer text
   - Proper section numbering in headings

6. **Chinese content**: The script auto-detects and uses CJK fonts (PingFang on macOS, Noto Sans CJK on Linux, Microsoft YaHei on Windows).

### Example: Complete Report Structure

```json
{
  "title": "2024 年度技术报告",
  "subtitle": "人工智能与机器学习应用进展分析",
  "author": "技术部",
  "date": "2024-12-01",
  "header": "2024 年度技术报告",
  "footer": "© 2024 公司名称 · 机密文件",
  "theme": "professional",
  "body": [
    { "type": "toc" },

    { "type": "heading", "level": 1, "text": "1. 执行摘要" },
    { "type": "paragraph", "text": "本报告全面回顾了 2024 年度公司在人工智能和机器学习领域的技术应用进展。报告涵盖了关键项目里程碑、技术架构演进、团队能力建设以及未来发展规划四个核心维度。" },
    { "type": "paragraph", "text": "在过去一年中，我们成功部署了 12 个 AI 驱动的生产系统，处理效率平均提升 43%，客户满意度提高至 94.2%。这些成果的取得离不开团队的不懈努力和技术路线的正确选择。" },
    { "type": "key_value", "items": [
      {"key": "报告周期", "value": "2024 年 1 月 — 12 月"},
      {"key": "项目总数", "value": "12 个生产系统"},
      {"key": "效率提升", "value": "平均 43%"},
      {"key": "客户满意度", "value": "94.2%"}
    ]},

    { "type": "heading", "level": 1, "text": "2. 核心项目进展" },
    { "type": "heading", "level": 2, "text": "2.1 智能客服系统" },
    { "type": "paragraph", "text": "智能客服系统于 2024 年 3 月正式上线，基于大语言模型构建的对话引擎能够处理 85% 的常见客户咨询。系统采用 RAG（检索增强生成）架构，结合企业知识库实现精准问答。" },
    { "type": "paragraph", "text": "截至年末，系统累计处理对话 230 万轮次，平均响应时间 1.2 秒，首次解决率达 78%。与人工客服相比，处理成本降低 62%，同时客户满意度保持在 91% 以上。" },

    { "type": "heading", "level": 2, "text": "2.2 数据分析平台" },
    { "type": "paragraph", "text": "数据分析平台完成了从传统 BI 工具到 AI 驱动分析的升级转型。新平台支持自然语言查询，用户只需描述分析需求，系统即可自动生成可视化报表。" },
    { "type": "table", "headers": ["指标", "升级前", "升级后", "提升幅度"], "rows": [
      ["查询响应时间", "45 秒", "3 秒", "93%"],
      ["日活跃用户", "120", "580", "383%"],
      ["报表生成耗时", "2 小时", "10 分钟", "92%"]
    ]},

    { "type": "heading", "level": 1, "text": "3. 技术架构" },
    { "type": "paragraph", "text": "我们的技术架构遵循微服务设计原则，核心组件包括模型服务层、数据管道、特征工程平台和监控告警系统。各组件之间通过消息队列实现松耦合通信。" },
    { "type": "quote", "text": "好的架构不是一次设计出来的，而是在持续迭代中逐步演进的。我们的架构每季度进行一次评审和优化。" },
    { "type": "list", "style": "bullet", "items": [
      "模型服务层：支持 TensorRT 加速推理，P99 延迟 < 50ms",
      "数据管道：基于 Apache Kafka 的实时流处理，日吞吐量 10 亿条记录",
      "特征工程平台：自动化特征提取和存储，支持在线和离线两种模式",
      "监控告警系统：全链路追踪，异常检测准确率 96%"
    ]},

    { "type": "heading", "level": 1, "text": "4. 未来展望" },
    { "type": "paragraph", "text": "展望 2025 年，我们将重点推进多模态 AI 应用、边缘计算部署和自动化 MLOps 三大方向。预计投入预算 1200 万元，新增技术岗位 15 个。" },
    { "type": "list", "style": "number", "items": [
      "Q1：完成多模态模型评估和选型",
      "Q2：边缘设备适配和性能优化",
      "Q3：MLOps 平台 2.0 上线",
      "Q4：全面评估与规划下一年度"
    ]}
  ]
}
```

---

## Advanced Operations

### Merge / Split / Rotate PDFs (Python pypdf)

```bash
python3 -c "
from pypdf import PdfReader, PdfWriter
# Merge
writer = PdfWriter()
for f in ['a.pdf', 'b.pdf']:
    writer.append(f)
writer.write('merged.pdf')
"
```

### OCR Scanned PDFs

Requires: `pytesseract`, `pdf2image`

```bash
python3 -c "
from pdf2image import convert_from_path
import pytesseract
images = convert_from_path('scanned.pdf')
text = '\n'.join(pytesseract.image_to_string(img, lang='chi_sim+eng') for img in images)
print(text)
"
```

### Fill PDF Forms

See `forms.md` for detailed form-filling workflow (both fillable and non-fillable forms).

## Quick Reference

| Task | Approach |
|------|----------|
| Read/extract text | `read_pdf` tool (built-in) |
| Extract tables | `read_pdf` + parse text |
| Save as spreadsheet | `read_pdf` + `create_spreadsheet` |
| **Create professional PDF** | **`create_pdf.py` script** |
| Merge/split/rotate | Python pypdf |
| Fill PDF forms | See `forms.md` |
| OCR scanned PDFs | Python pytesseract |

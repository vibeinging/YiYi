---
name: pptx
description: "Use this skill whenever the user wants to do anything with PowerPoint presentations — reading, extracting text, creating professional slide decks."
metadata:
  {
    "yiyiclaw":
      {
        "emoji": "📊",
        "requires": {}
      }
  }
---

# PowerPoint Processing

## Reading & Extracting Text

PPTX files are ZIP archives containing XML. Extract content with shell tools:

```bash
# List all slides
unzip -l presentation.pptx | grep slide

# Extract all text from all slides
unzip -p presentation.pptx ppt/slides/slide*.xml | sed 's/<[^>]*>//g'

# Extract specific slide
unzip -p presentation.pptx ppt/slides/slide3.xml | sed 's/<[^>]*>//g'
```

Or use Python for structured extraction:

```python
from pptx import Presentation
prs = Presentation("presentation.pptx")
for i, slide in enumerate(prs.slides):
    print(f"--- Slide {i+1} ---")
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(shape.text)
```

---

## Creating Professional Presentations

Use the `create_pptx.py` script to generate polished, themed slide decks.

### Step 1: Build a JSON structure file

Create a JSON file describing the presentation. **Include rich content — detailed bullet points, not one-word items.**

```json
{
  "title": "Presentation Title",
  "subtitle": "Descriptive subtitle",
  "author": "Author Name",
  "date": "2024-01-15",
  "theme": "dark",
  "slides": [
    { "type": "title", "title": "Main Title", "subtitle": "Subtitle" },
    { "type": "section", "title": "Section Name" },
    { "type": "content", "title": "Slide Title", "body": ["Point 1", "Point 2"] },
    ...
  ]
}
```

### Step 2: Run the script

```bash
python3 scripts/create_pptx.py structure.json output.pptx
```

### Available Themes

| Theme | Style |
|-------|-------|
| `dark` | Dark navy background, blue/cyan accents — modern tech feel |
| `light` | White background, navy/blue accents — clean and professional |
| `corporate` | White background, navy/red accents — formal business style |

### Slide Types

#### Title Slide (opening slide)
```json
{ "type": "title", "title": "Main Title", "subtitle": "Subtitle text", "author": "Name", "date": "2024-01-01" }
```

#### Section Divider
```json
{ "type": "section", "title": "Section Name", "subtitle": "Optional description" }
```

#### Content Slide (bullet points)
```json
{ "type": "content", "title": "Slide Title", "body": ["Detailed point one with explanation", "Point two with supporting data", "Point three with context"] }
```

#### Two-Column Layout
```json
{ "type": "two_column", "title": "Comparison Title", "left_title": "Option A", "left": ["Left point 1", "Left point 2"], "right_title": "Option B", "right": ["Right point 1", "Right point 2"] }
```

#### Table Slide
```json
{ "type": "table", "title": "Data Overview", "headers": ["Name", "Role", "Status"], "rows": [["Alice", "Engineer", "Active"], ["Bob", "Designer", "Active"]] }
```

#### Quote / Callout
```json
{ "type": "quote", "text": "An impactful quote or key insight.", "author": "Attribution" }
```

#### Image Slide
```json
{ "type": "image", "title": "Architecture Diagram", "path": "/absolute/path/to/image.png", "caption": "Figure 1: System overview" }
```

#### Key Metrics / KPI Dashboard
```json
{ "type": "key_metrics", "title": "Performance KPIs", "metrics": [{"label": "Revenue", "value": "$10M", "change": "+15%"}, {"label": "Users", "value": "50K", "change": "+30%"}, {"label": "Uptime", "value": "99.9%", "change": "+0.2%"}] }
```
- `change`: Prefix with `+` for green (positive) or `-` for red (negative)
- Best with 2–4 metrics per slide

#### Timeline / Roadmap
```json
{ "type": "timeline", "title": "Project Roadmap", "events": [{"date": "Q1", "text": "Phase 1 launch"}, {"date": "Q2", "text": "Feature expansion"}, {"date": "Q3", "text": "Scale to production"}] }
```
- Best with 3–5 events

#### Thank You / Closing
```json
{ "type": "thank_you", "title": "Thank You", "message": "Questions or feedback welcome", "contact": "email@example.com" }
```

#### Blank Slide
```json
{ "type": "blank" }
```

### Content Guidelines

1. **Bullet points should be substantive**: Each bullet should be a full phrase or short sentence, not just a keyword. "Revenue grew 43% driven by new product launch" is better than "Revenue +43%".

2. **Structure the presentation well**:
   - Start with a `title` slide
   - Use `section` slides to divide major topics
   - Mix slide types — don't use only `content` slides
   - End with `thank_you`

3. **Recommended flow** (8–15 slides):
   - Title → Section → Content/Metrics → Section → Two-Column/Table → Quote → Timeline → Thank You

4. **Use key_metrics for numbers**: When presenting KPIs or statistics, use `key_metrics` instead of putting numbers in bullet points.

5. **Use two_column for comparisons**: Before/after, pros/cons, option A vs B — use `two_column` instead of a single list.

6. **Chinese content**: python-pptx uses system fonts. Chinese text renders correctly on systems with CJK fonts installed.

### Example: Complete Presentation

```json
{
  "title": "2024 年度技术报告",
  "subtitle": "人工智能与机器学习应用进展分析",
  "author": "技术部",
  "date": "2024-12-01",
  "theme": "dark",
  "slides": [
    { "type": "title", "title": "2024 年度技术报告", "subtitle": "AI 应用进展分析", "author": "技术部", "date": "2024-12-01" },

    { "type": "section", "title": "核心项目进展", "subtitle": "本年度 12 个 AI 系统成功部署" },

    { "type": "content", "title": "智能客服系统", "body": [
      "基于大语言模型构建对话引擎，覆盖 85% 常见客户咨询",
      "RAG 架构结合企业知识库，实现精准上下文问答",
      "累计处理 230 万轮对话，平均响应时间 1.2 秒",
      "首次解决率 78%，较人工客服成本降低 62%"
    ]},

    { "type": "key_metrics", "title": "关键业务指标", "metrics": [
      {"label": "对话处理量", "value": "230万", "change": "+180%"},
      {"label": "平均响应", "value": "1.2s", "change": "-85%"},
      {"label": "客户满意度", "value": "94.2%", "change": "+12%"}
    ]},

    { "type": "two_column", "title": "数据平台升级对比", "left_title": "升级前", "left": [
      "手动查询，平均响应 45 秒",
      "日活跃用户仅 120 人",
      "报表生成需要 2 小时"
    ], "right_title": "升级后", "right": [
      "自然语言查询，3 秒响应",
      "日活跃用户增至 580 人",
      "报表 10 分钟自动生成"
    ]},

    { "type": "table", "title": "项目进度总览", "headers": ["项目", "状态", "完成率", "负责人"], "rows": [
      ["智能客服系统", "已上线", "100%", "张三"],
      ["数据分析平台", "测试中", "85%", "李四"],
      ["推荐引擎", "开发中", "60%", "王五"]
    ]},

    { "type": "quote", "text": "好的架构不是一次设计出来的，而是在持续迭代中逐步演进的。我们的架构每季度评审优化一次。", "author": "技术架构组" },

    { "type": "timeline", "title": "2025 年路线图", "events": [
      {"date": "Q1", "text": "多模态模型评估与选型"},
      {"date": "Q2", "text": "边缘设备适配与性能优化"},
      {"date": "Q3", "text": "MLOps 平台 2.0 上线"},
      {"date": "Q4", "text": "全面评估与下一年规划"}
    ]},

    { "type": "thank_you", "title": "谢谢", "message": "如有问题请随时联系技术部", "contact": "tech@company.com" }
  ]
}
```

---

## Advanced Operations

### Convert PPTX to PDF
```bash
# Using LibreOffice
soffice --headless --convert-to pdf presentation.pptx
```

### Extract Images from PPTX
```bash
unzip -j presentation.pptx ppt/media/* -d ./extracted_images/
```

### Modify Existing PPTX
```python
from pptx import Presentation
prs = Presentation("existing.pptx")
slide = prs.slides[0]
slide.shapes.title.text = "Updated Title"
prs.save("modified.pptx")
```

## Quick Reference

| Task | Approach |
|------|----------|
| Extract text | Shell `unzip -p` + `sed` |
| Extract images | `unzip -j` from `ppt/media/` |
| **Create professional deck** | **`create_pptx.py` script** |
| Modify existing PPTX | Python python-pptx |
| Convert to PDF | LibreOffice CLI |

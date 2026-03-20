---
name: wechat_writer
description: "Write and format articles for WeChat Official Accounts (微信公众号). Use when the user asks to write, format, or optimize content for WeChat publication, including tech articles, product analysis, and general content creation."
metadata:
  {
    "yiyi":
      {
        "emoji": "✍️",
        "requires": {}
      }
  }
---

# WeChat Official Account Writer (公众号写作)

Help users create high-quality articles for WeChat Official Accounts, covering research, writing, formatting, and optimization for the WeChat reading experience.

## When to Activate

**Trigger conditions:**
- User mentions 公众号: "写公众号文章", "公众号发布", "微信文章"
- User asks to write articles for WeChat: "帮我写一篇文章", "写一篇关于XX的文章"
- User asks to format content for WeChat: "排版", "美化文章", "公众号格式"
- User wants to research and write: "研究XX然后写篇文章"

## Workflow

### Stage 1: Topic Research & Planning

1. **Clarify topic and angle**: Ask the user for:
   - Topic/subject matter
   - Target audience (tech developers, product managers, general readers, etc.)
   - Tone (professional, conversational, storytelling, etc.)
   - Approximate length (short: 1500-2000 words, medium: 2000-4000 words, long: 4000+ words)

2. **Research**: Use **browser_use** to:
   - Search for latest information, data, and trends on the topic
   - Find authoritative sources and references
   - Identify unique angles not yet covered

### Stage 2: Writing

Follow WeChat article best practices:

#### Structure
- **Hook title (标题)**: Compelling, under 30 characters, use numbers or questions when appropriate
- **Opening (开头)**: Hook the reader in the first 3 sentences — use a story, question, surprising fact, or pain point
- **Body (正文)**: Clear sections with subheadings, short paragraphs (2-4 sentences), mix of text and visual breaks
- **Conclusion (结尾)**: Summarize key takeaways, include call-to-action (关注, 点赞, 在看, 转发)

#### Writing Style for WeChat
- Use conversational Chinese, avoid overly academic language
- Short paragraphs — WeChat is read on mobile, dense text loses readers
- Use **bold** for key points
- Add section dividers for visual rhythm
- Include relatable examples and analogies
- Use rhetorical questions to engage readers
- Add emoji sparingly for visual accent (not excessive)

#### Content Types

**Tech/AI Articles (技术科普)**:
- Explain complex concepts with analogies
- Include real-world use cases and demos
- Add code snippets if relevant (keep short)
- Reference official sources and papers

**Product Analysis (产品分析)**:
- Break down features and user experience
- Compare with competitors
- Analyze from user value perspective
- Include screenshots or diagrams when possible

**Industry Insights (行业观察)**:
- Provide data-driven analysis
- Include expert quotes and references
- Offer unique perspective or prediction
- Connect to reader's daily work/life

### Stage 3: Formatting for WeChat

Generate the article in clean HTML format optimized for WeChat editor:

```html
<section style="...">
  <!-- Article content with inline styles -->
</section>
```

**Formatting rules:**
- Use inline CSS only (WeChat strips `<style>` tags and external CSS)
- Font size: 16px for body, 20-22px for main title, 18px for section headings
- Line height: 1.8-2.0 for readability
- Color: #333 for body text, accent colors for headings
- Letter spacing: 1-2px
- Paragraph margin: 15-20px bottom
- Max width: optimized for mobile reading
- Code blocks: background #f6f8fa, padding, border-radius, overflow scroll
- Blockquotes: left border accent, subtle background
- Images: max-width 100%, centered

### Stage 4: Review & Polish

Before delivering:
1. Check for typos and grammar issues
2. Verify all facts and data are accurate
3. Ensure the article flows naturally
4. Confirm formatting renders well on mobile
5. Suggest 2-3 alternative titles
6. Provide a one-line abstract for 摘要 field

## Output

Deliver the final article in two formats:
1. **Markdown version** — for easy editing and version control
2. **HTML version** — ready to paste into WeChat editor, with all inline styles applied

## Guidelines

- Always write in Chinese unless the user specifies otherwise
- Prioritize readability on mobile screens
- Keep sentences concise — WeChat readers skim
- Use storytelling to make dry topics engaging
- Cite sources when referencing data or claims
- Respect copyright — do not copy content verbatim from other sources
- If researching with browser_use, synthesize information into original content

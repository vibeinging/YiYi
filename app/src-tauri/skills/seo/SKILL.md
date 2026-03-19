---
name: seo
description: "SEO content optimization and analysis. Use when the user asks to optimize content for search engines, analyze keywords, write SEO-friendly articles, improve page rankings, or generate meta tags and structured data."
metadata:
  {
    "yiyiclaw":
      {
        "emoji": "🔍",
        "requires": {}
      }
  }
---

# SEO Content Optimization Skill

Help users create and optimize content for search engine visibility. This skill covers keyword research, content optimization, meta tag generation, and SEO analysis.

## When to Activate

**Trigger conditions:**
- User mentions SEO: "优化SEO", "搜索引擎优化", "提升排名", "SEO analysis"
- User asks for keyword research: "关键词分析", "找关键词", "keyword research"
- User asks to write SEO-friendly content: "写一篇SEO文章", "优化这篇文章的SEO"
- User asks about meta tags or structured data: "写meta标签", "生成结构化数据"

## Capabilities

### 1. Keyword Research & Analysis
- Analyze user's topic and suggest primary, secondary, and long-tail keywords
- Evaluate keyword intent (informational, navigational, transactional)
- Suggest keyword clusters and semantic variations
- Use **browser_use** to research competitor keywords and trending topics when needed

### 2. Content Optimization
- Analyze existing content for SEO improvements
- Optimize title tags (keep under 60 characters, include primary keyword)
- Write compelling meta descriptions (under 160 characters, include CTA)
- Suggest heading structure (H1-H6) with keyword placement
- Optimize content density and readability
- Add internal/external linking suggestions
- Ensure proper keyword distribution (title, first paragraph, headings, body, conclusion)

### 3. SEO Content Writing
When writing SEO-optimized articles:
1. **Research phase**: Identify target keywords and search intent
2. **Outline**: Create SEO-friendly structure with keyword-rich headings
3. **Write**: Produce content with natural keyword integration
4. **Optimize**: Add meta tags, alt text suggestions, schema markup recommendations

### 4. Technical SEO Suggestions
- Generate JSON-LD structured data (Article, FAQ, HowTo, Product, etc.)
- Suggest Open Graph and Twitter Card meta tags
- Provide URL slug recommendations
- Check content for common SEO issues (keyword stuffing, thin content, missing alt text)

## Output Format

When analyzing or optimizing content, provide:

```
## SEO Analysis Report

### Target Keywords
- Primary: [keyword] (search intent: [type])
- Secondary: [keyword1], [keyword2]
- Long-tail: [phrase1], [phrase2]

### Optimization Score: [X/10]

### Recommendations
1. Title: [optimized title]
2. Meta Description: [optimized description]
3. Headings: [suggested structure]
4. Content: [specific improvements]

### Structured Data (JSON-LD)
[generated schema markup]
```

## Guidelines

- Always consider the target audience and search intent
- Prioritize user experience over keyword density
- Suggest natural keyword integration, never keyword stuffing
- Consider both Chinese and English SEO best practices based on target market
- When using browser_use to research, check top-ranking pages for the target keyword to understand content expectations
- Provide actionable, specific recommendations rather than generic advice

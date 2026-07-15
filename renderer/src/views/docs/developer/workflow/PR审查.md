# PR Review 规范

## 评论原则

### 基本要求

1. **客观专业** - 不使用评分、情绪化表达（如"垃圾代码"、"太棒了"等）
2. **问题导向** - 明确指出问题，不做主观评价
3. **提供方案** - 每个问题都应给出修复建议或代码示例
4. **行内优先** - 尽量使用行级评论，精确定位问题位置

### 禁止内容

- 品味评分（如 🔴🟡🟢 评级）
- 情绪化词汇（如"致命"、"垃圾"、"完美"）
- 没有修复方案的批评
- 与代码无关的个人评价

## 评论格式

### PR 级别评论

用于总结性说明，格式如下：

```markdown
## Code Review - PR #xxx: [标题]

### 需要修复的问题

#### 1. [问题描述]

**文件**: `path/to/file.py:行号`

[问题说明]

---

### 建议修复的问题

| 问题 | 位置 | 说明 |
|------|------|------|
| xxx | `file.py:10` | xxx |
```

### 行级评论

直接在代码行添加评论，格式：

```markdown
[问题说明]

**修复方案**:
\`\`\`python
# 修复后的代码
\`\`\`
```

## Gitee API 使用

### 获取 Token

1. 访问 https://gitee.com/profile/personal_access_tokens
2. 创建 token（勾选 `projects` 权限）
3. 保存到项目根目录 `.gitee_token` 文件

### API 封装

使用 `scripts/gitee_api.py`：

```bash
# 列出 PR
python scripts/gitee_api.py list-prs --state open

# 获取 PR 详情
python scripts/gitee_api.py get-pr 105

# 获取 PR 评论
python scripts/gitee_api.py get-comments 105

# 添加 PR 评论
python scripts/gitee_api.py add-comment 105 --body "评论内容"

# 添加行评论
python scripts/gitee_api.py add-comment 105 \
  --body "评论内容" \
  --path "backend/api/routes/xxx.py" \
  --position 24
```

### 行评论 position 说明

`position` 是 diff 中的行号（从 1 开始），不是文件的实际行号。

获取方式：
1. 调用 `get_pr_files(pr_number)` 获取文件 diff
2. 查看 `patch.diff` 字段，按行计数
3. 找到目标行的位置即为 position

示例 diff：
```
  1: @@ -14,6 +14,7 @@ from models.business_data_source import BusinessDataSource
  2:  from models.database_connection import DatabaseConnection
  3:  from models.structured_data_source import StructuredDataSource
  4:  from models.unstructured_data_source import UnstructuredDataSource
  5: +from models.mcp_data_source import MCPDataSource   # <- position = 5
```

## 常见问题分类

### 必须修复

- 逻辑错误（条件写反、变量用错等）
- 数据库查询条件错误
- 类型不匹配
- 缺失的错误处理
- 安全问题

### 建议修复

- 命名不规范
- 注释/文档错误
- 代码风格问题
- 性能优化建议
- 架构改进建议

## 示例

### 好的评论

```markdown
这里应该是 `StructuredDataSource.id` 而不是 `MCPDataSource.id`：

\`\`\`python
result = await db.execute(
    select(StructuredDataSource)
    .where(
        StructuredDataSource.id == source_id,
        StructuredDataSource.user_id == user_id
    )
)
\`\`\`
```

### 不好的评论

```markdown
这代码写得太烂了，完全用错了模型！
```

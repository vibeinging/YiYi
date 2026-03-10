---
name: claude_code
description: "通过 Claude Code CLI 执行复杂编码任务，支持会话持续、自动安装与任务委派"
metadata:
  {
    "yiclaw":
      {
        "emoji": "🤖",
        "requires": {}
      }
  }
---
# Claude Code CLI 集成

启用此技能后，编码相关任务通过 `claude_code` 工具委派给 Claude Code CLI 执行。Claude Code 拥有完整的代码理解、编辑、搜索和终端能力，适合处理复杂编码任务。

## 使用方式

**直接调用 `claude_code` 工具**，不需要手动运行 shell 命令。工具会自动处理：
- CLI 安装检测（未安装时返回安装指引）
- 会话持续性（同一对话中多次调用共享上下文）
- 权限管理（自动跳过 Claude Code 的交互式确认，由 YiClaw 沙箱层统一管控）
- 超时控制和结果解析

### 基本调用

```json
{
  "prompt": "在 src/utils.ts 中添加一个 formatDate 函数，支持 YYYY-MM-DD 格式",
  "working_dir": "/path/to/project"
}
```

### 连续任务（自动保持上下文）

第一次调用：
```json
{
  "prompt": "阅读这个项目的代码，理解认证模块的架构"
}
```

第二次调用（自动继承上下文，Claude Code 记得之前阅读的内容）：
```json
{
  "prompt": "基于刚才的理解，给认证模块添加 OAuth2 支持"
}
```

### 传递上下文（context）

通过 `context` 参数把相关的技能规范、项目约定或对话摘要传给 Claude Code，让它遵循同样的标准：

```json
{
  "prompt": "给 user 模块添加单元测试",
  "working_dir": "/path/to/project",
  "context": "项目约定：\n- 使用 pytest，asyncio_mode=auto\n- 测试文件放在 tests/ 目录\n- Git commit 用 Conventional Commits 格式\n- 代码风格：black (79 chars), flake8"
}
```

**什么时候传 context**：
- 有编码相关的 skill 规范时（如 coding_assistant 的 Git 工作流、Conventional Commits）
- 用户有特定偏好或项目约定时
- 需要传递当前对话中积累的关键信息时

**什么时候不传**：
- 简单的查询/分析任务，不需要额外规范
- context 内容与任务无关（如邮件技能、新闻技能的指令）

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `prompt` | 是 | 编码任务描述，要具体清晰 |
| `working_dir` | 否 | 工作目录，默认用户工作区 |
| `context` | 否 | 附加上下文：技能规范、项目约定、对话摘要等，会注入 Claude Code 的 prompt |
| `continue_session` | 否 | 是否续接上次会话（默认 true） |
| `timeout_secs` | 否 | 超时秒数，默认 300（5分钟） |

## 权限模型

Claude Code 以非交互模式运行，权限确认由 YiClaw 统一处理：

- Claude Code 的交互式权限提示已自动跳过（`--dangerously-skip-permissions`）
- 文件访问由 YiClaw 的沙箱系统保护（超出工作区的路径会触发用户确认弹窗）
- **重要**：对于敏感操作（删除文件、git push、修改系统配置等），你应该在调用 `claude_code` 之前先向用户确认意图，不要直接委派

## 委派策略

遇到以下编码任务时，使用 `claude_code` 工具委派：

- **代码编写/修改**：新功能开发、bug 修复、重构
- **代码搜索/分析**：查找定义、分析调用链、理解架构
- **测试**：编写测试、运行测试、修复测试
- **Git 操作**：提交、分支管理（不自动 push）
- **构建/调试**：编译错误修复、依赖问题排查
- **大规模重构**：涉及多文件的重命名、模式替换

## Prompt 编写建议

好的 prompt 能显著提升 Claude Code 的执行质量：

1. **明确目标**：说清楚要做什么，而非怎么做
2. **指定范围**：提到具体的文件、目录或模块
3. **给出上下文**：项目使用的语言、框架、约定
4. **分步拆解**：复杂任务拆成 2-3 个步骤，分多次调用

### 好的 prompt 示例

- "在 src/api/auth.rs 中添加 JWT token 刷新逻辑，参考现有的 token 生成函数 create_token"
- "找到所有使用 deprecated_api() 的地方，迁移到 new_api()，然后运行测试确认"
- "修复 issue #123：用户登录后 session 未正确持久化。先阅读 session 相关代码理解问题"

### 避免的 prompt

- "帮我写代码"（太模糊）
- "重构整个项目"（范围太大，应拆分）

## 结果处理

工具执行完成后：

1. 解析 Claude Code 的输出结果
2. 向用户简洁汇报：完成了什么、修改/创建了哪些文件
3. 如果失败，分析原因：
   - 超时 → 建议拆分任务或增加 `timeout_secs`
   - CLI 未安装 → 引导用户安装 `npm i -g @anthropic-ai/claude-code`
   - API Key 缺失 → 引导用户设置 `ANTHROPIC_API_KEY`

## 与 Bot 交互

通过 Bot（Discord、Telegram 等）收到编码任务时：

1. 先简短回复"正在处理..."（利用 early reply 机制）
2. 调用 `claude_code` 工具执行
3. 将结果摘要回复给用户（注意平台消息长度限制，必要时截断）

## 注意事项

- Claude Code 不会自动 push 代码，需要用户明确要求
- 长时间任务可能超时（默认 5 分钟），建议拆分为小任务
- 确保工作目录正确，避免在错误的项目中执行操作
- 敏感操作（删除文件、force push 等）：**先问用户再委派**，不要默默执行

---
name: task_proposer
description: "PRIORITY SKILL — Detect long-running tasks and propose background execution BEFORE any work begins. Must run before auto_continue."
metadata:
  yiyiclaw:
    emoji: "📋"
    always_active: true
---

# 长任务检测与后台执行（优先级最高）

⚠️ **此规则优先于 auto_continue**：收到用户消息后，你必须**先判断是否为长任务**，再决定是否执行。如果判断为长任务，必须**先调用 `propose_background_task`**，不要直接开始执行任务。

## 什么是长任务

满足以下**任一条件**即为长任务：

- **生成文件类任务**：生成 HTML、创建网页、写一个 app、创建项目、生成文档集
- **多文件操作**：需要创建或修改 2 个以上文件
- **编程开发类**：需要调用 `claude_code` 工具、编写代码项目
- **复杂分析处理**：长报告撰写、大数据集分析、多步骤文件处理
- **创建型表述**：用户使用"帮我做"、"帮我生成"、"帮我创建"、"帮我写一个"、"从零开始"等表述
- **预估需要 3 轮以上**的多步执行任务

## 不是长任务（直接在主窗口完成）

- 简单问答、知识解释、闲聊
- 单文件读取、翻译一段文字、格式转换
- 查询类操作（天气、搜索、计算）
- 用户已使用 /task 命令（已是显式任务）
- 对话中的**后续轮次**（已在执行中，不再重复提议）

## 执行流程

### 场景一：首次收到用户消息

1. **先判断**：分析任务是否满足上述"长任务"条件
2. **如果是长任务**：
   - 立即调用 `propose_background_task` 工具
   - 在 `task_description` 中说明任务内容和预计步骤
   - 在 `context_summary` 中总结对话背景、用户需求细节
   - ⛔ **不要调用 `request_continuation`**，不要开始执行任务
   - 用文字告诉用户你的判断，等待用户选择
3. **如果不是长任务**：直接执行（此时 auto_continue 规则生效）

### 场景二：用户选择"在这里继续"

- 正常在主窗口执行任务
- 此时 auto_continue 接管，可以进行多轮执行

### 场景三：用户中途要求转为长任务

当用户在执行过程中说出类似以下表述时：
- "转成长任务"、"放到后台执行"、"转后台"
- "太久了，后台跑吧"

你应该：
1. **停止当前执行**（不再调用 `request_continuation`）
2. 将已完成的工作和剩余工作总结到 `context_summary` 中，包括：
   - 用户的原始需求
   - 已完成的步骤和产出
   - 未完成的剩余工作
   - 当前进度状态
3. 调用 `propose_background_task` 工具
4. 等待用户确认

## 关键规则

- 一次判断即可，**不要反复询问**
- 调用 `propose_background_task` 后**必须停止**，不要同时调用 `request_continuation`
- 宁可多提议一次，也不要漏掉一个长任务

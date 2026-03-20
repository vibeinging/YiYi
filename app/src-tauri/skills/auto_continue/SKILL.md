---
name: auto_continue
description: "Enable multi-round task execution. The model autonomously decides whether a task needs multiple rounds and calls request_continuation tool to signal."
metadata: { "yiyi": { "emoji": "♾️", "always_active": true, "hidden": true } }
---

# 多轮任务自主执行

你具备多轮连续执行的能力。当任务需要多步完成时，调用 `request_continuation` 工具来请求下一轮。

## ⚠️ 前置条件：先检查 task_proposer

**首轮（用户刚发送消息时）**：如果任务可能是长任务（生成文件、创建项目、多文件操作等），必须先由 task_proposer 判断并调用 `create_task`。只有在以下情况才能直接开始多轮执行：
- 任务明确不是长任务（简单问答、单文件操作等）
- 用户已选择"在这里继续"
- 当前已在多轮执行的**第 2 轮及之后**

## 判断标准

**不需要多轮**（大多数情况）：
- 简单问答、闲聊、解释说明
- 单步操作（读一个文件、执行一条命令）
- 信息查询、翻译、总结

**需要多轮**：
- 涉及多个文件的编写或修改
- 需要分阶段完成的复杂任务（调研 → 设计 → 实现 → 验证）
- 创建完整项目或大型文档
- 需要多次工具调用且有依赖关系的工作流

## 执行规则

1. **自行判断**：根据任务复杂度决定是否使用多轮模式，不需要用户手动开启
2. **首轮启动时**：如果判断需要多轮，先简要说明整体计划和预计步骤
3. **每轮聚焦**：专注完成一个明确的子步骤，轮末简要汇报进度
4. **请求继续**：任务未完成时，调用 `request_continuation` 工具并说明剩余工作
5. **自然结束**：任务全部完成后，不调用 `request_continuation`
6. **中途转长任务**：如果用户要求"转成长任务"或"放到后台"，立即停止多轮执行，交由 task_proposer 处理

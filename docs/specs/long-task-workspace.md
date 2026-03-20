# 长任务工作区系统设计

> 状态：草案
> 日期：2026-03-13

## 核心理念

所有有文件产出的任务，无论长短，一律在用户 workspace 下创建独立目录。长任务只是在此基础上增加了 DB 记录和持久化管理。中途转长任务 = 纯入库操作，零文件搬迁。

## 1. 目录结构

### 产出目录（用户可见）

```
~/Documents/YiYi/
├── 作品集网站/            # 任务产出文件
│   ├── index.html
│   ├── style.css
│   └── assets/
├── Q1数据分析报告/
│   └── report.html
└── ...
```

- 路径：`{YIYICLAW_WORKSPACE}/{任务相关名称}/`
- 命名规则：Agent 根据用户需求生成有意义的名称
- 冲突处理：目录已存在时追加后缀（`-2`、`-3`）
- 用户可以直接在 Finder/资源管理器中浏览产出

### 元数据目录（内部）

```
~/.yiyiclaw/tasks/{task_id}/
├── TASK.md              # 任务上下文（Agent 和用户均可读写）
└── progress.json        # 执行状态快照（已有）
```

### TASK.md 格式

```markdown
# {任务标题}

## 原始需求
{用户的原始请求，包括对话中的补充细节}

## 执行计划
1. [x] 创建 HTML 结构
2. [ ] 添加 CSS 样式
3. [ ] 实现交互功能

## 产出文件
- index.html — 主页面
- style.css — 样式表

## 约束和偏好
- 使用纯 HTML/CSS
- 深色主题
- 响应式布局

## 进度备注
{Agent 执行过程中的关键记录}
```

用途：
- Agent 恢复执行时读取，获取完整上下文
- 用户可直接编辑此文件调整需求/约束，下次执行时 Agent 会读到变更

## 2. 数据库变更

### tasks 表新增字段

```sql
ALTER TABLE tasks ADD COLUMN workspace_path TEXT;  -- 产出目录的绝对路径
```

- 非长任务（内联执行）也可以有 workspace_path，但无 task 记录
- 中途转长任务时：创建 task 记录，workspace_path 指向已有产出目录

## 3. 任务生命周期

### 3.1 首次消息 → 判断流程

```
用户消息
  ↓
Agent 分析需求
  ├─ 需求不明确 → 追问用户（如"帮我做个网站"→"什么类型的网站？"）
  ├─ 无文件产出 → 直接回答（问答、查询、翻译等）
  └─ 有文件产出 →
      ├─ 1. 创建 workspace 目录（~/Documents/YiYi/{名称}/）
      ├─ 2. 判断是否为长任务（task_proposer 规则）
      │   ├─ 是长任务 → 调用 propose_background_task → 弹卡片
      │   └─ 不是长任务 → 直接执行，文件写入该目录
      └─ 3. Agent 执行时 working_dir 设为该目录
```

### 3.2 用户选择后台执行

```
用户点击"后台执行"
  ↓
confirm_background_task()
  ├─ 创建 task 记录（DB），workspace_path = 已有目录路径
  ├─ 创建 TASK.md（写入元数据目录）
  ├─ 创建独立 session
  ├─ 注入上下文 + 原始消息
  └─ 启动后台执行（spawn_task_execution）
```

### 3.3 用户选择"在这里继续"

```
正常在主窗口执行
  ├─ auto_continue 接管多轮执行
  ├─ 文件产出到已创建的 workspace 目录
  └─ 无 task 记录（除非中途转长任务）
```

### 3.4 中途转长任务

```
用户："转成长任务" / "放到后台"
  ↓
Agent 调用 propose_background_task（包含已完成工作摘要）
  ↓
用户确认
  ↓
confirm_background_task()
  ├─ 创建 task 记录，workspace_path = 同一个目录（零搬迁）
  ├─ 创建 TASK.md（包含已完成步骤 + 剩余工作）
  ├─ 注入完整上下文到新 session
  └─ 后台继续执行
```

### 3.5 任务清理

- 不自动清理，用户手动操作
- 提供清理功能：
  - `/status` 中可删除已完成任务
  - 删除时可选择"仅删除任务记录"或"同时删除产出文件"
  - TaskSidebar 右键菜单支持删除

## 4. 交互命令

### `/status`

列出所有任务的简要状态：

```
📋 任务列表
─────────────────────────────
● 作品集网站          运行中  45%
● Q1数据分析报告      已完成  ✓
○ API文档生成         已暂停
─────────────────────────────
使用 /focus {名称} 切换到任务
```

### `/focus {任务名}`

- 主窗口切换到该任务的 session
- 顶部显示提示条："当前聚焦：作品集网站 · /unfocus 返回主对话"
- 后续对话都在任务 session 中进行
- Agent 自动读取 TASK.md 获取上下文

### `/unfocus`

- 返回主对话 session
- 提示条消失

## 5. Agent 执行时的行为

### working_dir

- 有产出目录时：Agent 的 working_dir 设为 workspace 下的任务目录
- 文件操作（write_file, shell 等）自然落在正确位置

### 上下文恢复

任务恢复执行时（暂停后继续、崩溃恢复）：
1. 读取 TASK.md 获取需求、计划、进度
2. 读取目录内容了解已有产出
3. 继续未完成的工作

### 产出文件记录

Agent 每次写入文件后，更新 TASK.md 的"产出文件"章节，保持索引同步。

## 6. 实现优先级

### P0（核心流程）
- [ ] tasks 表增加 workspace_path 字段
- [ ] Agent 有文件产出时自动创建 workspace 目录
- [ ] task_proposer 判断流程正确执行（弹卡片）
- [ ] confirm_background_task 关联 workspace_path
- [ ] 中途转长任务（纯入库）

### P1（交互命令）
- [ ] `/status` 命令
- [ ] `/focus` + `/unfocus` 命令
- [ ] focus 状态提示条 UI

### P2（增强）
- [ ] TASK.md 自动生成和更新
- [ ] 任务清理功能（删除记录 / 删除文件）
- [ ] 用户编辑 TASK.md 后 Agent 感知变更
- [ ] 任务恢复执行（读取 TASK.md 上下文）

### P3（后续）
- [ ] 长任务独立窗口（纯输出展示）
- [ ] 任务产出预览（在 TaskDetailOverlay 中预览文件）

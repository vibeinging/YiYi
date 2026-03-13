# Phase 1: 单主窗口 + 任务面板 MVP

> 状态：Ready for Development
> 日期：2026-03-12
> 目标：Task = 带标记的 Session，纯加法改动，不破坏现有功能

---

## 一、产品范围

### 本期做
1. DB 新增 `tasks` 表 + sessions 表增加 `parent_session_id` 字段
2. 后端新增 `create_task` / `list_tasks` / `get_task_status` / `cancel_task` 四个 Tauri command
3. 后端 `chat_cancelled` 改为 per-task 取消信号
4. 工具系统注册 `create_task` 工具，Agent 可主动派发任务
5. 前端 Chat 页面底部新增可折叠 TaskPanel（任务面板）
6. 任务事件系统：`task://created` / `task://progress` / `task://completed` / `task://failed`
7. 主窗口对话流中嵌入任务卡片

### 本期不做
- 不移除 Session Tab 栏（保留现有多 Session 功能）
- 不创建独立任务子窗口（任务在主窗口内的 TaskPanel 中展示）
- 不融合 CronJob（保持现有定时任务独立）
- 不做 Bot 消息路由改造

---

## 二、数据模型

### 2.1 新增 tasks 表

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending | running | paused | completed | failed | cancelled
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    plan TEXT,                -- JSON: 阶段计划 [{title, status}]
    current_stage INTEGER DEFAULT 0,
    total_stages INTEGER DEFAULT 0,
    progress REAL DEFAULT 0.0,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 2.2 sessions 表修改

```sql
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT NULL;
```

当 Task 创建时：
- 新建一条 session：`id = "task:{task_id}"`, `source = "task"`, `source_meta = task_id`, `parent_session_id = 当前主对话 session_id`
- 新建一条 task 记录：关联到该 session

---

## 三、后端 API 设计

### 3.1 Tauri Commands（`commands/tasks.rs` 新文件）

```rust
#[tauri::command]
async fn create_task(
    title: String,
    description: Option<String>,
    parent_session_id: String,  // 从哪个对话创建的
    plan: Option<Vec<String>>,  // 阶段计划
    state: State<'_, AppState>,
) -> Result<TaskInfo, String>

#[tauri::command]
async fn list_tasks(
    parent_session_id: Option<String>,  // 为空时返回所有
    status: Option<String>,             // 过滤状态
    state: State<'_, AppState>,
) -> Result<Vec<TaskInfo>, String>

#[tauri::command]
async fn get_task_status(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<TaskInfo, String>

#[tauri::command]
async fn cancel_task(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String>

#[tauri::command]
async fn pause_task(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String>

// TaskInfo 返回结构
struct TaskInfo {
    id: String,
    title: String,
    description: Option<String>,
    status: String,
    session_id: String,
    parent_session_id: String,
    plan: Option<Vec<TaskStage>>,
    current_stage: i32,
    total_stages: i32,
    progress: f64,
    error_message: Option<String>,
    created_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

struct TaskStage {
    title: String,
    status: String,  // pending | running | completed | failed
}
```

### 3.2 AppState 扩展

```rust
// app_state.rs 新增
pub task_cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,

impl AppState {
    pub fn get_or_create_task_cancel(&self, task_id: &str) -> Arc<AtomicBool> { ... }
    pub fn cancel_task_signal(&self, task_id: &str) { ... }
    pub fn cleanup_task_signal(&self, task_id: &str) { ... }
}
```

### 3.3 工具注册（`tools.rs`）

```rust
// 新增 create_task 工具定义
ToolDefinition {
    name: "create_task",
    description: "当用户请求需要较长时间执行的复杂任务时，创建一个独立的后台任务。
                  适用场景：建网站、分析长文档、批量处理文件等。
                  不适用：简单问答、单步操作。",
    parameters: {
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "任务标题，简短描述" },
            "description": { "type": "string", "description": "任务详细描述" },
            "plan": {
                "type": "array",
                "items": { "type": "string" },
                "description": "执行阶段列表，如 ['初始化项目', '编写页面', '添加样式']"
            }
        },
        "required": ["title"]
    }
}
```

工具执行逻辑：
1. 生成 task_id（UUID）
2. 创建 task session：`task:{task_id}`
3. 写入 tasks 表
4. 初始化 cancel signal
5. 发送 `task://created` 事件
6. **在新 session 中启动 Agent 执行**（spawn async task）
7. 返回 "任务已创建" 给主对话

### 3.4 任务执行引擎

复用现有 `run_react_with_options` + auto-continue 机制：

```rust
// 在 create_task 工具执行后，spawn 异步任务
tokio::spawn(async move {
    let task_session_id = format!("task:{}", task_id);
    let cancel_flag = state.get_or_create_task_cancel(&task_id);

    // 构建任务专属 system prompt
    let system = format!(
        "你正在执行一个任务：{}\n\n{}\n\n请按计划逐步执行。",
        title, description
    );

    // 复用 ReAct 循环
    let result = run_react_with_options_persist(
        &config, &system, &description,
        &tools, &[], // 空历史
        Some(max_iterations),
        Some(&working_dir),
        |role, content| {
            db.push_message(&task_session_id, role, content);
        },
    ).await;

    // 更新任务状态
    match result {
        Ok(_) => db.update_task_status(&task_id, "completed"),
        Err(e) => db.update_task_status_with_error(&task_id, "failed", &e),
    }

    // 发送完成事件
    app.emit("task://completed", json!({ "task_id": task_id }));
});
```

### 3.5 事件系统

| 事件名 | 方向 | Payload | 触发时机 |
|--------|------|---------|---------|
| `task://created` | Backend → Frontend | `{task_id, session_id, title, plan}` | 任务创建成功 |
| `task://progress` | Backend → Frontend | `{task_id, current_stage, total_stages, progress, stage_title}` | Agent 完成一个阶段 |
| `task://completed` | Backend → Frontend | `{task_id, session_id}` | 任务执行完成 |
| `task://failed` | Backend → Frontend | `{task_id, error_message}` | 任务执行失败 |
| `task://cancelled` | Backend → Frontend | `{task_id}` | 任务被取消 |

---

## 四、前端设计

### 4.1 新增组件

#### TaskPanel（任务面板）

位置：Chat 页面底部，可折叠

```
折叠状态（默认，无任务时隐藏）：
┌──────────────────────────────────────────────────┐
│  任务 (2)                                    [▲] │
└──────────────────────────────────────────────────┘

展开状态：
┌──────────────────────────────────────────────────┐
│  任务 (2)                                    [▼] │
├──────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────┐    │
│  │ 创建个人网站          ● 进行中           │    │
│  │ ▰▰▰▰▰▱▱▱▱▱ 50%  · 阶段 3/6           │    │
│  │ 正在编写页面样式...                      │    │
│  │                       [查看] [暂停] [✕]  │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ 分析销售报告          ✓ 已完成           │    │
│  │ 3 分钟前完成                             │    │
│  │                       [查看结果]         │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

最大高度：300px，超出滚动

#### TaskCard（任务卡片 — 内嵌对话流）

在主对话中，当 Agent 调用 create_task 工具后，消息流中显示：

```
┌──────────────────────────────────────────────────┐
│  [任务图标] 创建个人网站                         │
│  ● 进行中 · 阶段 3/6                            │
│  ▰▰▰▰▰▱▱▱▱▱ 50%                               │
│                              [查看详情]          │
└──────────────────────────────────────────────────┘
```

#### TaskDetailDrawer（任务详情抽屉）

点击"查看详情"后，从右侧滑入，宽度 480px：

```
┌─ ← 返回 ── 创建个人网站 ──── [暂停] [取消] ─┐
│                                               │
│  状态：进行中 · 已运行 4 分 12 秒             │
│  ▰▰▰▰▰▱▱▱▱▱ 50%                            │
│                                               │
│  ── 执行计划 ──                               │
│  ✓ 初始化项目                                 │
│  ✓ 安装依赖                                   │
│  ● 编写页面样式（进行中）                      │
│  ○ 创建项目展示页                              │
│  ○ 添加响应式适配                              │
│  ○ 生成预览                                    │
│                                               │
│  ── 最近日志 ──                               │
│  [10:34] 创建了 styles/main.css               │
│  [10:35] 正在编写 Hero 区域样式...            │
│                                               │
│ ┌───────────────────────────────┐ [发送]      │
│ │ 对任务说点什么...             │             │
│ └───────────────────────────────┘             │
└───────────────────────────────────────────────┘
```

### 4.2 新增 Store

```typescript
// stores/taskStore.ts
interface TaskState {
  tasks: TaskInfo[];
  selectedTaskId: string | null;
  drawerOpen: boolean;

  // Actions
  loadTasks: () => Promise<void>;
  addTask: (task: TaskInfo) => void;
  updateTaskProgress: (taskId: string, progress: TaskProgress) => void;
  updateTaskStatus: (taskId: string, status: string) => void;
  selectTask: (taskId: string | null) => void;
  toggleDrawer: (open?: boolean) => void;
}
```

### 4.3 新增 API

```typescript
// api/tasks.ts
export const createTask = (title, description?, parentSessionId?, plan?) => invoke('create_task', ...);
export const listTasks = (parentSessionId?, status?) => invoke('list_tasks', ...);
export const getTaskStatus = (taskId) => invoke('get_task_status', ...);
export const cancelTask = (taskId) => invoke('cancel_task', ...);
export const pauseTask = (taskId) => invoke('pause_task', ...);
```

### 4.4 事件监听（扩展 useChatEventBridge 或新建 useTaskEventBridge）

```typescript
// hooks/useTaskEventBridge.ts
listen('task://created', (e) => taskStore.addTask(e.payload));
listen('task://progress', (e) => taskStore.updateTaskProgress(e.payload.task_id, e.payload));
listen('task://completed', (e) => taskStore.updateTaskStatus(e.payload.task_id, 'completed'));
listen('task://failed', (e) => taskStore.updateTaskStatus(e.payload.task_id, 'failed'));
listen('task://cancelled', (e) => taskStore.updateTaskStatus(e.payload.task_id, 'cancelled'));
```

### 4.5 Chat.tsx 改动

1. 在消息区域底部、输入框上方，插入 `<TaskPanel />`
2. 在消息渲染逻辑中，当工具调用名为 `create_task` 时，渲染 `<TaskCard />` 而非普通工具卡片
3. 右侧抽屉 `<TaskDetailDrawer />` 在 `selectedTaskId` 非空时显示

---

## 五、文件清单

### 新建文件
| 文件 | 说明 |
|------|------|
| `app/src-tauri/src/commands/tasks.rs` | 任务 CRUD 命令 |
| `app/src/components/TaskPanel.tsx` | 任务面板组件 |
| `app/src/components/TaskCard.tsx` | 对话内嵌任务卡片 |
| `app/src/components/TaskDetailDrawer.tsx` | 任务详情抽屉 |
| `app/src/stores/taskStore.ts` | 任务状态管理 |
| `app/src/hooks/useTaskEventBridge.ts` | 任务事件监听 |
| `app/src/api/tasks.ts` | 任务 API 调用 |

### 修改文件
| 文件 | 改动 |
|------|------|
| `app/src-tauri/src/engine/db.rs` | 新增 tasks 表 schema + CRUD 方法 |
| `app/src-tauri/src/state/app_state.rs` | 新增 task_cancellations |
| `app/src-tauri/src/engine/tools.rs` | 注册 create_task 工具 + 执行逻辑 |
| `app/src-tauri/src/commands/mod.rs` | 注册 tasks 模块 |
| `app/src-tauri/src/lib.rs` | 注册 task commands |
| `app/src/pages/Chat.tsx` | 集成 TaskPanel + TaskCard |
| `app/src/App.tsx` | 初始化 useTaskEventBridge |

---

## 六、验收标准

1. 用户在主对话中说"帮我建一个网站"，Agent 调用 create_task 创建任务
2. 对话流中出现任务卡片，显示进度
3. 底部 TaskPanel 显示任务列表和实时进度
4. 点击"查看详情"打开右侧抽屉，看到执行计划和日志
5. 用户可以取消/暂停任务
6. 任务完成后状态更新，主对话追加完成消息
7. 现有功能（多 Session、CronJob、Bot）不受影响

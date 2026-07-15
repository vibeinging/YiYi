# ARQ 异步任务队列指南

> "Bad programmers worry about the code. Good programmers worry about data structures."
>
> 这份文档告诉你项目中的 ARQ 架构、为什么这么设计，以及如何添加新任务。

---

## 一、为什么用任务队列？

### 核心问题：API 响应时间

**场景：文档向量化**
```text
用户上传文档 → API 收到请求 → 处理文档（3分钟）→ 返回结果
问题：用户等 3 分钟，连接超时，体验糟糕
```

**任务队列的解决方案**
```text
用户上传文档 → API 收到请求 → 提交任务 → 立即返回（1秒）
                                  ↓
                         后台 Worker 慢慢处理（3分钟）
```

### 为什么是 ARQ？

- **Redis 原生**：不需要额外的消息队列（RabbitMQ、Kafka）
- **Python async/await 原生支持**：与 FastAPI 天然集成
- **简单**：核心概念只有 3 个（Job、Queue、Worker）
- **轻量**：没有 Celery 的历史包袱和复杂性

**核心理念**：用最简单的方式解决实际问题。

---

## 二、架构设计：极简数据流

### 2.1 系统角色

```text
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  FastAPI App    │──提交──▶│  Redis Queue    │──消费──▶│  ARQ Worker     │
│  (生产者)        │       │  (消息队列)      │       │  (消费者)        │
└─────────────────┘       └─────────────────┘       └─────────────────┘
        │                                                     │
        └──────────────────  共享 Redis  ────────────────────┘
```

**角色职责**：
1. **FastAPI App (生产者)**：接收用户请求，提交任务到队列
2. **Redis Queue (消息队列)**：暂存任务，保证不丢失
3. **ARQ Worker (消费者)**：独立进程，执行耗时任务

**关键设计**：生产者和消费者解耦，互不阻塞。

### 2.2 目录结构

```text
backend/
├── core/arq/                      # 核心配置层
│   ├── queue.py                  # AsyncTaskQueue - 任务状态管理
│   ├── connection_provider.py    # ARQ 连接池（延迟初始化）
│   └── worker_settings.py        # Worker 配置
│
├── tasks/                         # 任务定义层
│   ├── __init__.py               # 导出所有任务
│   └── document_tasks.py         # 文档处理任务
│
├── main.py                        # FastAPI 启动（初始化 ARQ 连接池）
└── run_arq_worker.py              # Worker 启动脚本
```

**分层原则**：
- **queue.py**：任务状态追踪（pending → running → completed/failed）
- **connection_provider.py**：连接管理（延迟初始化、并发安全）
- **worker_settings.py**：Worker 配置（任务列表、超时、重试）
- **tasks/**：业务逻辑，使用核心层

---

## 三、核心组件详解

### 3.1 AsyncTaskQueue (`core/arq/queue.py`)

**设计哲学**：ARQ 负责执行、重试、超时。我们只负责追踪状态。

```python
class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass
class TaskInfo:
    id: str
    status: TaskStatus
    created_at: float
    updated_at: float
    error: Optional[str] = None
    result: Any = None
```

**核心方法**：

```python
class AsyncTaskQueue:
    # ===== 提交端（API 使用）=====
    async def submit(self, func: str, *args, task_id: str = None, **kwargs) -> str
    async def cancel(self, task_id: str) -> bool
    async def get_status(self, task_id: str) -> TaskInfo | None
    async def get_result(self, task_id: str, timeout: float = 0) -> Any

    # ===== 执行端（Worker 使用）=====
    async def mark_running(self, task_id: str)
    async def mark_completed(self, task_id: str, result: Any = None)
    async def mark_failed(self, task_id: str, error: str)
```

**使用示例**：

```python
from core.arq.queue import get_task_queue

# 获取全局队列实例
queue = await get_task_queue()

# 提交任务
task_id = await queue.submit(
    "process_unstructured_document",
    document_id="doc_123",
    chunk_size=512
)

# 查询状态
info = await queue.get_status(task_id)
print(f"Status: {info.status}")  # pending → running → completed

# 取消任务
await queue.cancel(task_id)
```

### 3.2 连接池管理 (`core/arq/connection_provider.py`)

**设计原则**：
1. **单一连接源**：只从 RedisManager 获取配置
2. **延迟初始化**：首次使用时创建连接池
3. **连接复用**：缓存连接池，避免重复创建

```python
from core.arq.connection_provider import get_arq_connection, arq_connection

# 方式1：直接获取
pool = await get_arq_connection()

# 方式2：上下文管理器
async with arq_connection() as conn:
    await conn.enqueue_job(...)
```

### 3.3 Worker 配置 (`core/arq/worker_settings.py`)

```python
class WorkerSettings:
    redis_settings = REDIS_SETTINGS           # 从 RedisManager 获取
    queue_name = QUEUE_NAME                   # 从环境变量获取

    functions = [
        process_unstructured_document,        # 非结构化文档处理
        process_structured_table              # 结构化表处理
    ]

    job_timeout = 30 * 60     # 30分钟超时
    max_tries = 3             # 最大重试次数
    max_burst_jobs = 10       # 最大并发任务数
    allow_abort_jobs = True   # 允许取消任务
```

---

## 四、队列隔离：多开发者环境

### 问题

多个开发者共用一个 Redis 服务器时，任务会互相干扰：
- 开发者 A 提交的任务被开发者 B 的 Worker 消费
- 调试困难，状态混乱

### 解决方案：QUEUE_NAME 环境变量

在 `.env` 中配置：

```bash
# ARQ 任务队列
# 队列名称（用于多开发者隔离，字符串无限制）
# 生产环境: QUEUE_NAME=arq_queue
# 开发环境: QUEUE_NAME=arq_queue_yourname（如 arq_queue_alice, arq_queue_bob）
QUEUE_NAME=arq_queue_wjm
```

**工作原理**：
- 每个开发者使用独立的队列名
- API 和 Worker 从同一个环境变量读取
- 只有相同队列名的 API 和 Worker 才能通信

**配置读取链**：
```
.env (QUEUE_NAME=arq_queue_wjm)
    ↓
connection_provider.py → create_pool(default_queue_name=queue_name)
    ↓
worker_settings.py → WorkerSettings.queue_name = QUEUE_NAME
    ↓
queue.py → AsyncTaskQueue._queue_name = DEFAULT_QUEUE_NAME
```

---

## 五、完整工作流

### 5.1 提交任务 (API 端)

```python
from core.arq.queue import get_task_queue

@router.post("/documents/{document_id}/process")
async def process_document(document_id: str, chunk_size: int = 512):
    queue = await get_task_queue()

    # 提交任务
    task_id = await queue.submit(
        "process_unstructured_document",
        document_id=document_id,
        chunk_size=chunk_size
    )

    return {"task_id": task_id, "status": "pending"}
```

### 5.2 执行任务 (Worker 端)

```python
# tasks/document_tasks.py

async def process_unstructured_document(
    ctx: dict,
    document_id: str,
    chunk_size: int = 512
):
    """非结构化文档处理任务"""
    task_id = ctx.get("job_id")
    queue = ctx.get("queue")  # Worker 启动时注入

    # 标记开始执行
    if queue:
        await queue.mark_running(task_id)

    try:
        # 业务逻辑
        result = await DocumentService.process(document_id, chunk_size)

        # 标记完成
        if queue:
            await queue.mark_completed(task_id, result)

        return result

    except Exception as e:
        # 标记失败
        if queue:
            await queue.mark_failed(task_id, str(e))
        raise
```

### 5.3 Worker 初始化

```python
# core/arq/worker_settings.py

async def on_startup(ctx: dict):
    """Worker 启动时初始化 queue 实例"""
    from core.arq.queue import init_task_queue

    redis = ctx.get('redis')
    if redis:
        queue = await init_task_queue(redis)
        ctx['queue'] = queue
        logger.info(f"[Worker] Task queue initialized: {queue.queue_name}")
```

### 5.4 启动 Worker

```bash
# 开发环境
python run_arq_worker.py

# 或使用 arq CLI
arq core.arq.worker_settings.WorkerSettings
```

---

## 六、添加新任务

### 步骤 1：定义任务函数

创建 `tasks/report_tasks.py`：

```python
async def generate_report(
    ctx: dict,
    report_type: str,
    user_id: int
) -> str:
    """生成报表任务"""
    task_id = ctx.get("job_id")
    queue = ctx.get("queue")

    if queue:
        await queue.mark_running(task_id)

    try:
        # 业务逻辑
        report_path = await ReportService.generate(report_type, user_id)

        if queue:
            await queue.mark_completed(task_id, report_path)

        return report_path

    except Exception as e:
        if queue:
            await queue.mark_failed(task_id, str(e))
        raise
```

### 步骤 2：注册到 Worker

修改 `core/arq/worker_settings.py`：

```python
from tasks.document_tasks import process_unstructured_document, process_structured_table
from tasks.report_tasks import generate_report  # 新增

class WorkerSettings:
    functions = [
        process_unstructured_document,
        process_structured_table,
        generate_report,  # 新增
    ]
```

### 步骤 3：在 API 中提交

```python
@router.post("/reports/generate")
async def create_report(report_type: str, user_id: int):
    queue = await get_task_queue()

    task_id = await queue.submit(
        "generate_report",
        report_type=report_type,
        user_id=user_id
    )

    return {"task_id": task_id}
```

### 步骤 4：重启 Worker

```bash
# 停止旧 Worker（Ctrl+C）
# 启动新 Worker
python run_arq_worker.py
```

---

## 七、任务状态追踪

### Redis Key 格式

```text
task:{task_id} → JSON(TaskInfo)
```

**示例**：
```json
{
  "id": "process_unstructured_document_1702123456789",
  "status": "running",
  "created_at": 1702123456.789,
  "updated_at": 1702123460.123,
  "error": null,
  "result": null
}
```

**TTL**：24 小时（自动清理）

### 状态流转

```text
submit()      mark_running()     mark_completed()
    │              │                    │
    ▼              ▼                    ▼
 PENDING  ───►  RUNNING  ───►  COMPLETED
                   │
                   │  mark_failed()
                   ▼
                FAILED
                   │
                   │  cancel()
                   ▼
               CANCELLED
```

### 查询状态

```python
# API 端
queue = await get_task_queue()
info = await queue.get_status(task_id)

if info:
    print(f"Status: {info.status}")
    print(f"Error: {info.error}")
    print(f"Result: {info.result}")
```

---

## 八、监控与调试

### 8.1 查看 Worker 日志

```bash
python run_arq_worker.py

# 输出示例
🚀 Starting ARQ Worker...
   Queue: arq_queue_wjm
   Functions: process_unstructured_document, process_structured_table
[Worker] Task queue initialized: arq_queue_wjm
[Queue] Task submitted: process_unstructured_document_1702123456789
[Queue] Task running: process_unstructured_document_1702123456789
[Queue] Task completed: process_unstructured_document_1702123456789
```

### 8.2 检查队列中的任务

```python
# 检查指定前缀的任务
queue = await get_task_queue()
tasks = await queue.get_tasks_by_prefix("process_unstructured_document")

for task in tasks:
    print(f"{task.id}: {task.status}")
```

### 8.3 手动测试

```python
#!/usr/bin/env python3
"""手动测试任务提交"""
import asyncio
from dotenv import load_dotenv
load_dotenv()  # 加载 .env

from core.arq.queue import get_task_queue

async def test():
    queue = await get_task_queue()

    # 提交任务
    task_id = await queue.submit(
        "process_unstructured_document",
        document_id="test_doc_123",
        chunk_size=512
    )
    print(f"Task submitted: {task_id}")

    # 等待完成
    import time
    for _ in range(60):
        info = await queue.get_status(task_id)
        print(f"Status: {info.status}")

        if info.status in ("completed", "failed"):
            print(f"Result: {info.result}")
            print(f"Error: {info.error}")
            break

        time.sleep(1)

if __name__ == "__main__":
    asyncio.run(test())
```

---

## 九、常见问题

### 问题 1：任务提交成功但不执行

**排查步骤**：

1. **Worker 是否运行？**
   ```bash
   ps aux | grep run_arq_worker
   ```

2. **队列名是否一致？**
   ```bash
   # 检查 .env 中的 QUEUE_NAME
   cat .env | grep QUEUE_NAME

   # API 和 Worker 必须使用相同的 QUEUE_NAME
   ```

3. **Worker 是否加载了新代码？**
   - 修改任务后必须重启 Worker

### 问题 2：任务一直是 pending 状态

**原因**：Worker 没有调用 `mark_running()`

**解决**：确保任务函数中调用状态更新：
```python
async def my_task(ctx, ...):
    queue = ctx.get("queue")
    task_id = ctx.get("job_id")

    if queue:
        await queue.mark_running(task_id)  # 必须调用
    ...
```

### 问题 3：Function 'xxx' not found

**原因**：任务未注册到 Worker

**解决**：
1. 在 `worker_settings.py` 的 `functions` 列表中添加任务
2. 重启 Worker

### 问题 4：多开发者任务互相干扰

**解决**：使用不同的 `QUEUE_NAME`

```bash
# 开发者 A 的 .env
QUEUE_NAME=arq_queue_alice

# 开发者 B 的 .env
QUEUE_NAME=arq_queue_bob
```

---

## 十、最佳实践

### 原则 1：任务必须幂等

```python
# ❌ 非幂等：每次执行增加计数
async def increment_counter(ctx, user_id):
    user.counter += 1

# ✅ 幂等：设置为固定值
async def set_status(ctx, document_id, status):
    doc.status = status  # 执行多次结果相同
```

### 原则 2：参数必须可序列化

```python
# ❌ 不能传递数据库会话
await queue.submit("my_task", db=db)

# ✅ 传递 ID，在任务内创建会话
await queue.submit("my_task", document_id=123)
```

### 原则 3：合理设置超时

```python
class WorkerSettings:
    job_timeout = 30 * 60   # 复杂任务：30分钟
    # job_timeout = 10 * 60 # 简单任务：10分钟
```

### 原则 4：状态更新要及时

```python
async def my_task(ctx, ...):
    queue = ctx.get("queue")
    task_id = ctx.get("job_id")

    # 开始时立即标记
    await queue.mark_running(task_id)

    try:
        result = await do_work()
        # 完成时立即标记
        await queue.mark_completed(task_id, result)
    except Exception as e:
        # 失败时立即标记
        await queue.mark_failed(task_id, str(e))
        raise
```

---

## 十一、快速参考

### 启动命令

```bash
# 启动 Worker（前台）
python run_arq_worker.py

# 启动 Worker（后台）
nohup python run_arq_worker.py > worker.log 2>&1 &

# 停止 Worker
pkill -f run_arq_worker
```

### 环境配置

```bash
# .env
REDIS_HOST=172.16.10.147
REDIS_PORT=6379
REDIS_PASSWORD=xxx
REDIS_DB=0
QUEUE_NAME=arq_queue_yourname
```

### 核心文件

| 文件 | 职责 |
|------|------|
| `core/arq/queue.py` | 任务状态管理 |
| `core/arq/connection_provider.py` | 连接池管理 |
| `core/arq/worker_settings.py` | Worker 配置 |
| `tasks/document_tasks.py` | 业务任务定义 |
| `run_arq_worker.py` | Worker 启动脚本 |

### 核心 API

```python
# 获取队列
queue = await get_task_queue()

# 提交任务
task_id = await queue.submit("func_name", arg1=val1, arg2=val2)

# 查询状态
info = await queue.get_status(task_id)

# 取消任务
await queue.cancel(task_id)

# Worker 端
await queue.mark_running(task_id)
await queue.mark_completed(task_id, result)
await queue.mark_failed(task_id, error)
```

---

## 总结

**核心设计**：
- **极简状态**：只有 6 个字段（id, status, created_at, updated_at, error, result）
- **职责分离**：ARQ 负责执行/重试，我们只负责追踪状态
- **队列隔离**：通过 `QUEUE_NAME` 环境变量实现多开发者隔离

**添加新任务只需 4 步**：
1. 定义任务函数（`tasks/xxx_tasks.py`）
2. 注册到 Worker（`worker_settings.py`）
3. 在 API 中提交（`queue.submit()`）
4. 重启 Worker

**记住**：任务必须幂等、参数可序列化、状态更新要及时。

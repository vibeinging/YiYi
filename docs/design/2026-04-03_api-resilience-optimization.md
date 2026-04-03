# API 调用与错误恢复优化设计

> 参考：Claude Code 源码分析 — 第 20 篇《API 调用与错误恢复》
> 日期：2026-04-03

---

## 一、现状分析

### 已有能力

| 模块 | 位置 | 能力 |
|------|------|------|
| LLM Client 重试 | `engine/llm_client/openai.rs`, `anthropic.rs` | MAX_RETRIES=3，指数退避 1→2→4s，429/5xx 重试，Retry-After 支持 |
| SSE 流式处理 | `engine/llm_client/stream.rs` | UTF-8 分片解码，cancellation flag 中断 |
| Bot 发送重试 | `engine/bots/retry.rs` | 指数退避，可重试错误分类，统计追踪 |
| Bot 速率限制 | `engine/bots/rate_limit.rs` | Token Bucket，平台级配置 |
| 前端错误捕获 | `stores/chatStreamStore.ts` | `chat://error` 事件监听，错误状态展示 |

### 关键缺失

| 缺失能力 | 影响 | 优先级 |
|----------|------|--------|
| 流式超时看门狗 | 网络卡顿时连接僵死，用户无感知 | P0 |
| 流式→非流式自动降级 | 流失败后无备选，直接报错 | P0 |
| 重试过程用户反馈 | 重试期间 UI 无提示，用户以为卡死 | P1 |
| 错误分类（临时 vs 永久） | 所有错误一视同仁，无差异化处理 | P1 |
| Context Overflow 自修复 | token 超限直接失败，不尝试调整 | P2 |
| API 调用可观测性 | 无延迟/成功率/重试率指标 | P2 |

---

## 二、优化方案

### Phase 1：流式连接守护（P0）

#### 2.1 Stream Idle Watchdog（流式空闲看门狗）

**问题**：SSE 流可能因网络中间件静默断开，TCP 连接不报错但数据停止流入。

**设计**：

```
┌─────────────────────────────────────────────────┐
│            process_sse_stream()                  │
│                                                  │
│  每收到一个 SSE chunk ──→ 重置 idle_timer       │
│                                                  │
│  idle_timer 超时 (60s) ──→ StreamIdleTimeout     │
│                           ──→ 释放流资源         │
│                           ──→ 触发非流式降级     │
│                                                  │
│  半程警告 (30s) ──→ 记录日志，不中断             │
└─────────────────────────────────────────────────┘
```

**实现位置**：`engine/llm_client/stream.rs`

```rust
// 新增配置
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const STREAM_IDLE_WARNING: Duration = Duration::from_secs(30);

// process_sse_stream 内部
// 用 tokio::select! 在 chunk 读取和 idle 超时之间竞争
loop {
    tokio::select! {
        chunk = response.chunk() => {
            match chunk {
                Ok(Some(data)) => {
                    idle_deadline = Instant::now() + STREAM_IDLE_TIMEOUT;
                    // ... 正常处理
                }
                Ok(None) => break,  // 流正常结束
                Err(e) => return Err(e.into()),
            }
        }
        _ = tokio::time::sleep_until(idle_deadline) => {
            warn!("Stream idle timeout after {}s", STREAM_IDLE_TIMEOUT.as_secs());
            return Err(LlmError::StreamIdleTimeout);
        }
        _ = cancel_check => {
            return Err(LlmError::Cancelled);
        }
    }
}
```

#### 2.2 流式→非流式自动降级

**问题**：流式请求失败后直接报错，无备选路径。

**设计**：

```
queryModel()
  ├─ 尝试 stream=true
  │   ├─ 成功 → 正常返回
  │   └─ 失败（StreamIdleTimeout / ConnectionReset / 404）
  │       ├─ 通知前端："正在切换到非流式模式..."
  │       └─ 尝试 stream=false（独立超时 120s）
  │           ├─ 成功 → 构造完整响应返回
  │           └─ 失败 → 最终报错
  └─ 用户主动取消 → 不降级，直接中断
```

**实现位置**：`engine/llm_client/openai.rs` + `anthropic.rs` 的 `send_request()`

```rust
// send_request 新增参数
pub struct RequestOptions {
    pub allow_nonstreaming_fallback: bool,  // 默认 true
    // ...
}

// 流式失败后的降级逻辑
match send_streaming_request(&client, &params).await {
    Ok(stream) => Ok(Response::Stream(stream)),
    Err(e) if e.is_stream_recoverable() && options.allow_nonstreaming_fallback => {
        // 通知前端
        emit_system_message("正在切换到非流式模式...");
        // 非流式重试，独立超时
        let result = send_non_streaming_request(&client, &params).await?;
        Ok(Response::Complete(result))
    }
    Err(e) => Err(e),
}
```

**可降级的错误类型**：
- `StreamIdleTimeout` — 看门狗超时
- `ConnectionReset` / `BrokenPipe` — 连接断开
- HTTP 404 — 网关不支持 SSE
- 非用户主动取消的 `APIConnectionError`

---

### Phase 2：重试体验优化（P1）

#### 2.3 重试过程用户反馈

**问题**：重试期间前端无任何提示，用户以为系统卡死。

**设计**：后端每次重试前通过 Tauri event 推送状态，前端展示轻量提示条。

```
后端 (retry loop)                    前端 (Chat.tsx)
  │                                    │
  ├─ 第1次失败                         │
  ├─ emit("chat://retry", {           │
  │    attempt: 1,                     │
  │    max: 3,                    ──→  ├─ 显示提示条：
  │    delay_ms: 1000,                 │   "网络波动，1秒后重试 (1/3)..."
  │    error_type: "overloaded"        │
  │  })                                │
  ├─ sleep(1s)                         │
  ├─ 第2次尝试成功                     │
  ├─ emit("chat://retry-resolved")──→  ├─ 隐藏提示条
  │                                    │
```

**前端组件**：`RetryStatusBar`

```tsx
// 轻量提示条，不打断用户操作
function RetryStatusBar() {
  const [retry, setRetry] = useState<RetryInfo | null>(null);

  useEffect(() => {
    const unlisten1 = listen('chat://retry', (e) => setRetry(e.payload));
    const unlisten2 = listen('chat://retry-resolved', () => setRetry(null));
    return () => { unlisten1.then(f => f()); unlisten2.then(f => f()); };
  }, []);

  if (!retry) return null;
  return (
    <div className="retry-bar">
      网络波动，{Math.ceil(retry.delay_ms / 1000)}秒后重试
      ({retry.attempt}/{retry.max})...
    </div>
  );
}
```

#### 2.4 错误分类与差异化处理

**问题**：所有错误统一处理，429（配额耗尽，需要等几小时）和 500（服务端短暂故障）混为一谈。

**新增错误分类枚举**：

```rust
pub enum ApiErrorCategory {
    /// 短暂故障，自动重试中 (500, 502, 503, 529, ConnectionError)
    Transient { retry_after: Option<Duration> },

    /// 速率限制 (429)，区分短期限流 vs 配额耗尽
    RateLimited {
        retry_after: Option<Duration>,
        is_quota_exhausted: bool,  // true = 配额用完，false = 短期限流
    },

    /// 认证失败 (401, 403)
    AuthError,

    /// 请求本身有问题 (400, 404)，不重试
    ClientError { message: String },

    /// 上下文溢出，可自修复
    ContextOverflow { input_tokens: usize, context_limit: usize },
}
```

**前端差异化展示**：

| 分类 | 用户看到的 | 操作 |
|------|-----------|------|
| Transient | "服务暂时繁忙，正在重试..." | 自动重试，无需操作 |
| RateLimited (短期) | "请求过于频繁，稍后重试..." | 自动退避 |
| RateLimited (配额耗尽) | "API 配额已用完，请检查用量" | 展示设置入口 |
| AuthError | "API Key 无效或已过期" | 展示设置入口 |
| ClientError | 具体错误信息 | 展示"重新发送"按钮 |
| ContextOverflow | "对话过长，正在自动压缩..." | 自动调整后重试 |

---

### Phase 3：高级恢复能力（P2）

#### 2.5 Context Overflow 自修复

**问题**：当对话 token 超过模型上下文限制时直接失败。

**设计**：从错误响应中提取 token 数字，自动调整 `max_tokens`。

```rust
// 从错误消息提取 token 信息
fn parse_context_overflow(error_msg: &str) -> Option<(usize, usize)> {
    // 匹配 "input length of X and max_tokens of Y exceed context limit of Z"
    // 返回 (input_tokens, context_limit)
    let re = Regex::new(
        r"input.*?(\d+).*?max_tokens.*?(\d+).*?context.*?(\d+)"
    ).ok()?;
    let caps = re.captures(error_msg)?;
    let input_tokens: usize = caps[1].parse().ok()?;
    let context_limit: usize = caps[3].parse().ok()?;
    Some((input_tokens, context_limit))
}

// 在重试循环中
if let Some((input_tokens, context_limit)) = parse_context_overflow(&err_msg) {
    let safety_buffer = 1000;
    let available = context_limit.saturating_sub(input_tokens + safety_buffer);
    let floor = 3000; // 最小输出 token
    if available >= floor {
        retry_context.max_tokens_override = Some(available.max(floor));
        continue; // 用调整后的参数重试
    }
    // 可用空间太小，触发 compaction
    trigger_compaction().await;
    continue;
}
```

**与现有 Compaction 联动**：

```
Context Overflow
  ├─ 可用空间 ≥ 3000 → 调整 max_tokens，重试
  └─ 可用空间 < 3000 → 触发 compaction（已有机制）→ 重试
```

#### 2.6 API 调用可观测性

**新增指标结构**：

```rust
pub struct ApiMetrics {
    pub total_requests: AtomicU64,
    pub total_retries: AtomicU64,
    pub total_failures: AtomicU64,
    pub total_stream_fallbacks: AtomicU64,
    pub avg_latency_ms: AtomicU64,
    pub last_error: RwLock<Option<(Instant, String)>>,
}
```

**采集点**：
- `send_request()` 入口/出口 — 请求计数、延迟
- 重试循环 — 重试次数、错误类型
- 流式降级 — fallback 计数

**暴露方式**：通过 Tauri command 供前端 Settings 页展示，或日志输出。

---

## 三、实现计划

```
Phase 1 — 流式连接守护 (P0)
├── 2.1 Stream Idle Watchdog        改动：stream.rs
├── 2.2 流式→非流式降级             改动：openai.rs, anthropic.rs, stream.rs
│
Phase 2 — 重试体验优化 (P1)
├── 2.3 重试过程用户反馈            改动：retry 循环 + 新增 RetryStatusBar 组件
├── 2.4 错误分类与差异化处理        改动：新增 ApiErrorCategory + 前端错误展示
│
Phase 3 — 高级恢复能力 (P2)
├── 2.5 Context Overflow 自修复     改动：retry 循环 + compaction 联动
└── 2.6 API 调用可观测性            改动：新增 ApiMetrics + Settings 展示
```

---

## 四、改动范围

| 文件 | 改动类型 | Phase |
|------|---------|-------|
| `engine/llm_client/stream.rs` | **核心改动** — 新增 watchdog + idle 超时 | 1 |
| `engine/llm_client/openai.rs` | **改动** — 降级逻辑 + 错误分类 | 1-2 |
| `engine/llm_client/anthropic.rs` | **改动** — 降级逻辑 + 错误分类 | 1-2 |
| `engine/llm_client/mod.rs` | **改动** — 新增 `ApiErrorCategory` / `LlmError` 变体 | 1-2 |
| `engine/react_agent/core.rs` | **小改** — 适配新错误类型 + context overflow 处理 | 2-3 |
| `src/components/chat/RetryStatusBar.tsx` | **新增** — 重试状态提示条 | 2 |
| `src/pages/Chat.tsx` | **小改** — 集成 RetryStatusBar + 错误分类展示 | 2 |

---

## 五、与 Claude Code 设计的对比

| Claude Code 机制 | YiYi 当前 | 本次优化后 |
|-----------------|-----------|-----------|
| AsyncGenerator 重试 + yield 状态 | for 循环重试，无状态反馈 | Tauri event 推送重试状态 |
| 流式看门狗 (90s) | 无 | tokio::select! 看门狗 (60s) |
| 流→非流自动降级 | 无 | 流失败自动非流式 fallback |
| 前台/后台差异化重试 | 无区分 | 暂不实现（YiYi 目前无大量后台 API 请求） |
| 连续 529 模型降级 | 无 | 暂不实现（YiYi 目前单模型，后续多模型时加入） |
| Context Overflow 自修复 | 直接失败 | 自动调整 max_tokens + 联动 compaction |
| 错误分类精细化 | 基础 429/5xx | 6 类错误 + 前端差异化展示 |
| Persistent Retry (无人值守) | 无 | 暂不实现（桌面应用场景不需要） |

**明确不实现的**：
- Persistent Retry — 桌面应用有用户在场，不需要无限重试
- 前台/后台差异化 — YiYi 目前后台 API 请求量小，收益不大
- 模型降级 — 等多模型 fallback 机制就绪后再加

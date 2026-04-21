# YiYi 测试框架设计

**日期：** 2026-04-20
**范围：** 从零重建 YiYi 的测试基建，覆盖 Rust 后端、前端、以及 Tauri 端到端全链路

## 1. 目标

建立完整、规范的测试框架，使 YiYi 的所有关键代码路径都有自动化测试保护，且 CI 能阻止回归。

**核心原则：API 接口即功能**。所有 Tauri commands（237 个 `#[tauri::command]` 函数）和所有前端 api wrapper（26 个 `app/src/api/*.ts` 文件）必须 **全量覆盖**，每一个都至少有 happy path + 一个 error path 测试。底层 engine 模块按 blast radius 分阶段，但 commands 层一次到位。

**成功标准：**
- **237 个 Tauri commands 100% 有集成测试**
- **26 个前端 api 文件每个 exported wrapper 100% 有 unit test**
- Rust 引擎核心模块行覆盖率 ≥ 70%
- 前端核心 pages/stores/components 行覆盖率 ≥ 60%
- CI 每次 push/PR 自动跑 Rust 测试 + 前端测试；E2E 每晚跑
- 新 PR 必须自带测试（硬 gate：新增 command 或 api wrapper 必须附测试）
- 开发者本地一条命令即可跑所有测试：`cargo test` / `npm test` / `npm run e2e`

## 2. 动机（现状快照）

**Rust：** 136 个 `#[test]` 散落在 20 个模块，全部 inline（`#[cfg(test)] mod tests`）；**零 dev-dependencies**（无 mockall/tempfile/tokio-test）；无 `tests/` 集成目录；无 test helpers；`react_agent/core`（712 行）、`bots/manager`（958 行）、`scheduler`（809 行）、`tools/*`（9553 行）**零测试**。

**前端：** 完全没有测试（无 runner、无 `*.test.*` 文件、无 deps）。

**E2E：** 无。

**CI：** `.github/workflows/release.yml` 只 build 不跑测试。

## 3. 决策

| # | 决策 | 答案 | 理由 |
|---|---|---|---|
| 1 | Scope | 全面补课（基建 + 核心模块回填 + 前端单元测试 + E2E + CI） | 用户选 C |
| 2 | Rust 测试库 | `mockall` + `tempfile` + `tokio-test` + `rstest` + `serial_test` | trait 多需 mock，async 多，文件 I/O 多，SQLite WAL 不能并行 |
| 3 | 前端 runner | Vitest + `@testing-library/react` + `@testing-library/jest-dom` | Vite 生态原生，零配置 |
| 4 | E2E 工具 | WebdriverIO + tauri-driver | Tauri 2.x 官方路径，比 Playwright-tauri 成熟 |
| 5 | 覆盖率 | Rust 核心 70%，前端 60%，E2E 只验关键路径；初期 CI 不硬 gate（warn），第一轮补课完成后再卡 | 过早硬 gate 会催生刷指标的垃圾测试 |
| 6 | 模块优先级 | 见 §5.5 / §6.4 / §7.3 | 按 blast radius + bug 风险 |

## 4. 架构

三个独立可交付的 Plan，A 内部因规模大再拆两阶段：

```
Plan A1 (Rust 基建 + 8 核心引擎模块)
   └→ Plan A2 (237 commands 全量覆盖)      ←┐
                                            ├── CI 合并跑
Plan B  (前端基建 + 26 api 全量 + 核心 UI) ←┘

Plan C  (Tauri E2E)      ← 依赖 A2 + B，独立交付（CI nightly）
```

- **A1 先做**（测试基建是所有后续测试的前提）
- **A2 和 B 可并行**（basic 基建完成后同时推进）
- **C 最后**
- Plan A 总体规模远大于 B，预计 A1≈1 周 + A2≈2~3 周 + B≈1.5 周 + C≈1 周

## 5. Plan A：Rust 测试（基建 + 引擎核心 + 237 commands 全覆盖）

### 5.1 Cargo 依赖

`app/src-tauri/Cargo.toml` 添加：

```toml
[dev-dependencies]
mockall = "0.13"
tempfile = "3"
tokio-test = "0.4"
rstest = "0.23"
serial_test = "3"

[dev-dependencies.tokio]
version = "1"
features = ["full", "test-util"]
```

### 5.2 `test_support` 模块

位置：`app/src-tauri/src/test_support/mod.rs`。为了让 **内部单元测试**（同 crate 内的 `mod tests`）和 **外部集成测试**（`tests/` 目录，被 rustc 视作独立 crate）都能复用，采用 feature gate：

```toml
# Cargo.toml
[features]
test-support = []
```

```rust
// lib.rs
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
```

并让集成测试以 `--features test-support` 运行（CI 脚本里加该 flag）。

**组件清单与签名：**

```rust
// test_support/temp_db.rs
pub struct TempDb {
    _dir: tempfile::TempDir,
    conn: rusqlite::Connection,
}
impl TempDb {
    /// 建一个带完整 schema+migration 的临时 SQLite，随 drop 自动清理
    pub fn new() -> Self;
    pub fn connection(&self) -> &rusqlite::Connection;
    pub fn path(&self) -> std::path::PathBuf;
}

// test_support/temp_workspace.rs
pub struct TempWorkspace { dir: tempfile::TempDir }
impl TempWorkspace {
    /// 模拟 ~/.yiyi/ 目录结构，含空 config.json 和 SQLite DB
    pub fn new() -> Self;
    pub fn path(&self) -> &std::path::Path;
    pub fn config_path(&self) -> std::path::PathBuf;
}

// test_support/fake_embedder.rs
pub struct FakeEmbedder;
impl memme_embeddings::Embedder for FakeEmbedder {
    /// 返回确定性 512-dim 向量（内容哈希的 f32 展开），不依赖 ONNX
    fn embed(&self, text: &str) -> Result<Vec<f32>, EmbedError>;
    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError>;
    fn dimensions(&self) -> usize { 512 }
    fn model_name(&self) -> &str { "fake" }
}

// test_support/mocks.rs
mockall::mock! {
    pub LlmProvider {}
    #[async_trait::async_trait]
    impl memme_llm::LlmProvider for LlmProvider {
        async fn chat(&self, req: ChatRequest) -> Result<ChatResponse>;
        // ... 其他方法
    }
}
```

相关 trait（`memme_llm::LlmProvider`、Bot trait 等）需加 `#[cfg_attr(test, mockall::automock)]`，以便自动生成 mock。

### 5.3 `tests/` 集成测试目录结构

```
app/src-tauri/tests/
├── common/                     # 集成测试间共用的 helper
│   └── mod.rs                  # re-export test_support + 构造 test AppState
├── engine/                     # 引擎核心模块（Plan A1）
│   ├── react_agent.rs
│   ├── bots_manager.rs
│   ├── scheduler.rs
│   ├── tools_file.rs
│   ├── tools_shell.rs          # 巩固 shell_security 现有 15 个测试 + 扩展
│   ├── mem_meditation.rs
│   └── mcp_runtime.rs
└── commands/                   # Tauri commands 全覆盖（Plan A2）
    ├── system.rs               # 39 commands
    ├── workspace.rs            # 27 commands
    ├── bots.rs                 # 20 commands
    ├── skills.rs               # 17 commands
    ├── buddy.rs                # 16 commands
    ├── models.rs               # 15 commands
    ├── tasks.rs                # 13 commands
    ├── cronjobs.rs             # 9 commands
    ├── channels.rs             # 9 commands
    ├── agent_session.rs        # 7 commands
    ├── agent_chat.rs           # 7 commands
    ├── mcp.rs                  # 6 commands
    ├── pty.rs                  # 5 commands
    ├── cli.rs                  # 5 commands
    ├── unified_users.rs        # 4 commands
    ├── plugins.rs              # 4 commands
    ├── permissions.rs          # 4 commands
    ├── heartbeat.rs            # 4 commands
    ├── browser.rs              # 4 commands
    ├── agents.rs               # 4 commands
    ├── voice.rs                # 3 commands
    ├── usage.rs                # 3 commands
    ├── export.rs               # 3 commands
    ├── env.rs                  # 3 commands
    ├── workers.rs              # 2 commands
    ├── shell.rs                # 2 commands
    └── extensions.rs           # 2 commands
```

每个 commands/*.rs 测试文件覆盖对应源文件里的**所有** `#[tauri::command]` 函数，每个命令至少：
- 1 个 happy path test（正常输入 → 期望返回值）
- 1 个 error path test（非法输入或依赖不可用 → 期望错误）

合计 **237 commands × ≥2 tests = ≥474 command-level 集成测试**。

### 5.4 命名规范 & 并发规则

- 测试函数名用 `<主题>_<行为>_<期望>` 格式：`react_agent_think_with_tool_use_returns_tool_call`
- `rstest` 参数化测试：表格驱动场景用 `#[rstest]` + `#[case(..)]`
- SQLite WAL 不能并发：涉及 `TempDb` 或 `TempWorkspace` 的测试加 `#[serial]`
- 每个测试文件开头：`mod common;` 引入共享 helper
- Async 测试：默认 `#[tokio::test(flavor = "multi_thread")]`，需要确定性调度的用 `#[tokio::test(start_paused = true)]`

### 5.4.1 Tauri Command 测试模式

为了让 237 个 commands 可测，采用 **"Thin Tauri layer"** 模式：

**推荐做法（新 command 必遵循）：**

```rust
// commands/system.rs
pub async fn get_memme_config_impl(state: &AppState) -> Result<MemmeConfig, String> {
    let cfg = state.config.read().await;
    Ok(cfg.memme.clone())
}

#[tauri::command]
pub async fn get_memme_config(state: State<'_, AppState>) -> Result<MemmeConfig, String> {
    get_memme_config_impl(&*state).await
}
```

测试时**直接测 `_impl` 函数**，绕过 `tauri::State` 包装：

```rust
// tests/commands/system.rs
#[tokio::test]
#[serial]
async fn get_memme_config_returns_default_on_fresh_install() {
    let ws = TempWorkspace::new();
    let state = common::build_test_app_state(&ws).await;
    let cfg = get_memme_config_impl(&state).await.unwrap();
    assert_eq!(cfg.embedding_provider, "local-bge-zh");
}
```

**已有 command 的迁移策略：**
- Plan A2 开始前，先用一次 refactor commit 把所有 237 个 commands 拆成 `_impl` + `#[tauri::command]` 壳（机械劳动，用脚本辅助）
- 然后逐文件写测试

**备选（若 refactor 成本过高）：** 使用 `tauri::test::mock_builder()` 构造 `App` + `State`，但 `mock_builder` 对 async/plugin 支持有边界，不作为首选。

### 5.5 8 个引擎核心模块的测试目标（Plan A1）

| 模块 | 要覆盖的行为 |
|---|---|
| `engine/react_agent/core.rs` | think/act/observe 循环；tool use 分发；max_turns 截断；cancel；error recovery |
| `engine/bots/manager.rs` | MPSC 入队 → dedup（同 msg_id）→ debounce 500ms → 4 worker 并发消费；worker panic 不拖垮 manager |
| `engine/scheduler.rs` | cron 触发；delay 到期；once 一次性；jobs 持久化；cancel；overdue catch-up |
| `engine/tools/file_tools.rs` | 读/写/删除权限检查；路径越权拒绝；大文件截断；二进制文件处理 |
| `engine/tools/shell_security.rs` | 已有 15 个测试巩固 + 补 env var 注入、shell metachar escape、timeout、pipe chain |
| `engine/mem/meditation.rs` | 背景冥想调度；不阻塞主线程；错误重试；compact 超时降级 |
| `engine/mcp_runtime.rs` | MCP client 启动/断连/重试；tool schema 解析；call 超时 |
| `engine/tools/mod.rs` | tool registry 注册/分发；并发安全标志；definitions_by_source |

### 5.5.1 Tauri commands 全覆盖（Plan A2）

见 §5.3 的 27 个 commands/*.rs 测试文件清单。每个 command 通用测试模板：

```rust
#[tokio::test] #[serial]
async fn <command>_happy_path() {
    let state = build_test_app_state().await;
    let result = <command>_impl(&state, valid_input).await.unwrap();
    assert_eq!(result, expected);
}

#[tokio::test] #[serial]
async fn <command>_rejects_invalid_input() {
    let state = build_test_app_state().await;
    let err = <command>_impl(&state, invalid_input).await.unwrap_err();
    assert!(err.contains("<expected error substring>"));
}
```

特殊类别：
- **流式 command**（如 `agent/chat.rs::chat_stream`）：测试 event emit 次数、顺序、payload 结构。用 `tauri::test::mock_builder()` 捕获 emit
- **有外部 I/O 的 command**（browser、cli、pty）：mock 外部进程；测试错误传播
- **纯数据 CRUD command**（workspace、bots、cronjobs 的增删改查）：使用 `TempDb` + `TempWorkspace`

### 5.6 覆盖率工具

- 安装：`cargo install cargo-llvm-cov`
- 本地跑：`cargo llvm-cov --html --open`
- CI 输出 LCOV，上传到 Codecov（可选）

### 5.7 本地命令

```
cargo test --workspace              # 跑所有测试
cargo test --test react_agent       # 跑某个集成测试文件
cargo llvm-cov --html               # 本地生成覆盖率报告
```

## 6. Plan B：前端测试框架

### 6.1 依赖与配置

`app/package.json` 添加：

```json
{
  "devDependencies": {
    "vitest": "^3",
    "@vitest/coverage-v8": "^3",
    "@testing-library/react": "^16",
    "@testing-library/jest-dom": "^6",
    "@testing-library/user-event": "^14",
    "jsdom": "^25"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

`vite.config.ts` 在 `defineConfig` 里加 `test` 字段：

```ts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: ['./src/test-utils/setup.ts'],
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html', 'lcov'],
    include: ['src/**/*.{ts,tsx}'],
    exclude: ['src/**/*.d.ts', 'src/main.tsx', 'src/test-utils/**'],
  },
}
```

### 6.2 Tauri invoke Mock

`app/src/test-utils/setup.ts`：

```ts
import '@testing-library/jest-dom'
import { vi } from 'vitest'

// 默认行为：任何未显式 mock 的 invoke 调用都 throw，避免沉默地返回 undefined 导致误判
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    throw new Error(`invoke("${cmd}") called but not mocked. Use mockInvoke() in your test.`)
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))
```

测试内每个文件必须用 `mockInvoke({...})`（见下）显式声明用到的命令。

`app/src/test-utils/mockTauri.ts`：

```ts
import { invoke } from '@tauri-apps/api/core'
import { vi } from 'vitest'

/** 按命令名配置返回值，测试里最常用 */
export function mockInvoke(routes: Record<string, (args?: any) => unknown>) {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const handler = routes[cmd]
    if (!handler) throw new Error(`Unexpected invoke: ${cmd}`)
    return handler(args)
  })
}
```

### 6.3 目录结构

```
app/src/
├── stores/
│   ├── chatStreamStore.ts
│   └── chatStreamStore.test.ts       # 紧邻源文件
├── api/                              # 全部 26 个文件都要有 .test.ts
│   ├── agent.ts
│   ├── agent.test.ts
│   ├── bots.ts
│   ├── bots.test.ts
│   ├── ... (其余 24 个均对应 .test.ts)
├── pages/
│   ├── Chat.tsx
│   └── Chat.test.tsx
├── components/
│   └── *.test.tsx
└── test-utils/
    ├── setup.ts
    └── mockTauri.ts
```

### 6.4 全量覆盖清单

**26 个 api 文件全量覆盖**（每个 exported 函数至少 1 个 test）：
```
agent.ts, agents.ts, bots.ts, browser.ts, buddy.ts, canvas.ts, channels.ts,
cli.ts, cronjobs.ts, env.ts, export.ts, heartbeat.ts, mcp.ts, models.ts,
permissions.ts, plugins.ts, pty.ts, settings.ts, shell.ts, skills.ts,
system.ts, tasks.ts, usage.ts, voice.ts, workspace.ts
```
（`types.ts` 只含类型定义，不需测试）

**每个 api wrapper 的测试模板：**

```ts
import { mockInvoke } from '../test-utils/mockTauri'
import { getMemmeConfig } from './system'

describe('getMemmeConfig', () => {
  it('calls get_memme_config command and returns typed config', async () => {
    mockInvoke({
      get_memme_config: () => ({ embedding_provider: 'local-bge-zh', embedding_dims: 512, /* ... */ })
    })
    const result = await getMemmeConfig()
    expect(result.embedding_provider).toBe('local-bge-zh')
  })

  it('propagates invoke errors', async () => {
    mockInvoke({
      get_memme_config: () => { throw new Error('backend error') }
    })
    await expect(getMemmeConfig()).rejects.toThrow('backend error')
  })
})
```

**核心 UI 模块（pages / stores / components）** 按 blast radius 优先级：

| 模块 | 测试目标 |
|---|---|
| `stores/chatStreamStore.ts` | 消息 append；流式 token 累积；cancel；错误状态 |
| `pages/Chat.tsx` | render 空态；接收 store 更新后渲染消息；发送按钮触发 invoke |
| `pages/Cronjobs.tsx` | 列表渲染；create/edit/delete 触发对应命令 |
| `pages/Bots.tsx` | bot CRUD；启停状态切换 |
| `pages/Settings.tsx`（记忆 tab） | LLM preset 一键填入 → invoke save_memme_config；dirty 状态 |
| `pages/SetupWizard.tsx` | 各步骤推进；最终 completeSetup 调用 |
| `components/TaskDetailOverlay.tsx` | render 各状态；关闭事件 |
| `components/BuddyPanel.tsx` | 初始加载；记忆搜索触发；冥想按钮 |

### 6.5 本地命令

```
npm test             # 单次跑
npm run test:watch   # watch 模式
npm run test:coverage
```

## 7. Plan C：Tauri E2E

### 7.1 工具

- **WebdriverIO v9** + `@wdio/cli`
- **tauri-driver**（`cargo install tauri-driver --locked`）
- **macOS：** 原生支持（Tauri 2.x 走 WebKit，不需额外配置）；Linux 可选

### 7.2 目录结构

```
app/e2e/
├── wdio.conf.ts
├── package.json             # 独立 npm workspace，避免污染主 package.json
├── specs/
│   ├── setup-wizard.spec.ts
│   ├── chat.spec.ts
│   ├── cron.spec.ts
│   ├── bots.spec.ts
│   └── memory.spec.ts
└── helpers/
    ├── app.ts               # 启动 app、等待 ready
    └── selectors.ts         # data-testid 常量
```

前端代码需要给关键元素加 `data-testid` 属性（例如 `<button data-testid="chat-send">`）。

### 7.3 5 个关键 User Flow

1. **setup-wizard**：从空白配置启动 → 选语言 → 配主模型 → 走完向导 → 断言主界面 ready
2. **chat**：发一条消息 → 等待流式响应出现在列表 → 断言消息已持久化
3. **cron**：创建 cron job（cron 表达式 `* * * * *`）→ 等一分钟内触发 → 看到历史记录
4. **bots**：添加一个 webhook bot → 断言列表 → 删除 → 断言列表空
5. **memory**：输入 "我喜欢喝咖啡" → 触发记忆提取（mock meditation trigger）→ 搜索"偏好"→ 命中记忆

### 7.4 本地命令

```
npm run e2e           # build dev + spawn tauri-driver + run specs
npm run e2e -- --spec chat.spec.ts
```

### 7.5 CI

独立 workflow：`.github/workflows/e2e.yml`，`schedule: cron '0 18 * * *'`（每天 UTC 18:00 = 北京 02:00）+ `workflow_dispatch` 手动触发。失败只发通知，不卡主流程。

## 8. CI Pipeline

**新 workflow：** `.github/workflows/test.yml`

```yaml
on: [push, pull_request]
jobs:
  rust:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - name: Test
        run: cd app/src-tauri && cargo test --workspace
      - name: Coverage
        run: cd app/src-tauri && cargo llvm-cov --lcov --output-path lcov.info
      - uses: codecov/codecov-action@v4  # 可选
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: cd app && npm ci && npm run test:coverage
```

**E2E workflow：** `.github/workflows/e2e.yml`，如 §7.5。

**第一轮补课完成后**追加的覆盖率 gate（未来 PR）：在 `test.yml` 加 `fail_ci_if_error: true` 和最低门槛检查。

**Commands/api 新增 PR 硬 gate**（Plan A2 + B 完成后启用）：
- `scripts/check-command-coverage.sh`：grep 源码里所有 `#[tauri::command]` 函数名，断言 `tests/commands/*.rs` 里都有对应 `*_impl` 调用
- `scripts/check-api-coverage.sh`：grep `src/api/*.ts` 的 exported 函数，断言同目录有对应 `*.test.ts` 且 test 名里包含函数名
- 两个脚本跑在 `test.yml` 的新 job `coverage-gate`，PR 缺测试直接红

## 9. 不做（YAGNI）

- proptest（property-based）— 算法类代码少，收益低
- Jest / Mocha — Vitest 覆盖所有需求
- Playwright-tauri — WebdriverIO 官方路径足够
- 覆盖率硬 gate（首轮）— 等有实测数据再卡
- 测试 SOUL.md / skills / prompts 的 golden output — 这属于 LLM 评测，不在测试框架范畴
- 性能测试 / benchmark — 以后专门立项
- Visual regression — 以后专门立项

## 10. 风险与开放问题

1. **tauri-driver 在 macOS 的稳定性**：Tauri 2.x 相对 1.x 更稳，但偶有 WebKit driver 兼容问题。E2E 失败率高时降级为"只跑 3 个最关键 flow"
2. **SQLite WAL 串行约束**：`#[serial]` 会让测试变慢，但必要。需监控单轮测试时长
3. **Mock LLM 的 fidelity**：MockLlmProvider 不能模拟真实 LLM 的非确定性。react_agent 的复杂 prompt 逻辑可能需要录制真实响应做 fixture（回放式测试），留作 Plan A 实施过程中按需加
4. **ONNX embedder 在测试里不加载**：FakeEmbedder 完全绕过 ONNX，但语义搜索行为无法验证。真实 embedder 的测试放在特殊的 `cargo test --ignored` bucket 里

## 11. 成功标准

- **Plan A1：** 引擎 8 个核心模块行覆盖率 ≥ 70%，CI 跑 `cargo test` 通过
- **Plan A2：** 237 个 Tauri commands **100%** 至少有 happy + error path 两个测试（≥474 tests）；CI 断言 command 文件里每个 `#[tauri::command]` 函数都能在测试中找到对应 `*_impl` 调用（脚本校验）
- **Plan B：** 26 个前端 api 文件 **100%** 每个 exported wrapper 至少 1 个 test；核心 8 个 UI 模块行覆盖率 ≥ 60%；CI 跑 `npm test` 通过
- **Plan C：** 5 个 user flow 均有 passing E2E spec，nightly 稳定运行一周
- **全部完成后：** 新增 Tauri command 或 api wrapper 的 PR 必须附测试（CI 硬 gate，见 §8 脚本校验）

## 12. 实施顺序

1. **Plan A1**（Rust 基建 + 8 引擎核心模块）：~1 周
2. **Plan A2**（237 commands 全覆盖，先 refactor 成 thin layer 再逐文件写测试）：~2~3 周
3. **Plan B**（前端基建 + 26 api 全覆盖 + 8 UI 模块）：~1.5 周（A1 完成后可与 A2 并行）
4. **Plan C**（E2E 5 个 user flow）：~1 周
5. **补齐后：** 评估是否开启覆盖率硬 gate + 启用 commands/api 新增 PR 必附测试的 CI 校验

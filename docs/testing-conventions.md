# YiYi 测试规范

> 适用于 YiYi 项目的 Rust 后端 / 前端 / E2E 测试。新代码须遵循本规范。

## Rust

### 组织
- **单元测试**：inline `#[cfg(test)] mod tests` 紧挨被测函数
- **集成测试**：放在 `app/src-tauri/tests/engine_<module>.rs`
  - **扁平布局**（Rust 要求）。`tests/` 下的子目录只能用作共享 helper（`tests/common/`）
  - 每个 `tests/*.rs` 是独立 binary，导入 lib crate 时用 `app_lib::...`（lib 名是 `app_lib`，不是 `yiyi`）
- **共享 helper**：`app_lib::test_support::*`，通过 `tests/common/mod.rs` re-export，测试文件开头 `mod common; use common::*;`

### 命名
`<subject>_<action>_<expected>` —— 例如：
- `scheduler_add_job_with_cron_expression_triggers_on_schedule`
- `bot_manager_register_handler_does_not_panic`
- `fake_embedder_returns_different_vectors_for_different_inputs`

### Async
- 默认 `#[tokio::test(flavor = "multi_thread")]`
- 需要确定性时钟推进：`#[tokio::test(start_paused = true)]` + `tokio::time::advance(...)`

### Serial
任何触碰 SQLite（`TempDb` / `TempWorkspace` 连接真实 DB）的测试必须加 `#[serial]`（来自 `serial_test` crate）。SQLite WAL 不能跨线程共享。

### Feature flag
测试用到 `test_support` helper 必须带 `--features test-support`：

```bash
# inline 单元测试
cargo test --features test-support --lib

# 特定集成测试
cargo test --features test-support --test engine_scheduler

# 特定测试函数
cargo test --features test-support --lib test_support::fake_embedder
```

### 覆盖率
- 引擎核心模块（`react_agent/core`, `bots/manager`, `scheduler`, `tools/*`, `mem/meditation`, `mcp_runtime`）目标 **≥70% 行覆盖**
- 前端核心 stores / pages / api ≥60%
- 生成 HTML 报告：`cargo llvm-cov --features test-support --lib --html --open`
- CI 上传 LCOV 作为 artifact

### test_support helpers 使用速查

| Helper | 用途 |
|---|---|
| `TempWorkspace::new()` | 模拟 `~/.yiyi/`，带空 config.json |
| `TempDb::new()` | 临时 SQLite DB，全量 migration |
| `FakeEmbedder::new()` | 确定性 512-dim 向量，不依赖 ONNX |
| `MockLlmProvider::new()` | mockall 生成的 LlmProvider mock |
| `build_test_app_state().await` | 完整隔离的 `AppState`，返回 `TestAppState` |
| `build_mock_tauri_app()` | `App<MockRuntime>`，用于测试收取 `AppHandle` 的命令 |

### AppHandle-taking commands

对于需要 `tauri::AppHandle`（用来 `emit` 事件）或 `tauri::Window` 的命令，使用
**generic-runtime thin-layer** 模式——把核心逻辑抽成 `_impl`，泛型化运行时，
使测试可以传 `AppHandle<MockRuntime>`，而生产继续传 `AppHandle<Wry>`。

#### Refactor 模式

```rust
use tauri::{AppHandle, Emitter, Runtime, State};

pub async fn foo_impl<R: Runtime>(
    state: &AppState,
    app: &AppHandle<R>,
    args: Args,
) -> Result<T, String> {
    // ... 业务逻辑，包括 app.emit(...) ...
}

#[tauri::command]
pub async fn foo(
    args: Args,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<T, String> {
    foo_impl(&*state, &app, args).await
}
```

#### 测试模式

```rust
use tauri::Listener;
use std::sync::{Arc, Mutex};

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn foo_emits_expected_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();  // 保持 app alive 至测试结束
    let handle = app.handle().clone();

    // 先注册 listener，再调用 _impl。MockRuntime 同步派发。
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let _id = handle.listen("foo://event", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).unwrap();
        events_clone.lock().unwrap().push(payload);
    });

    foo_impl(t.state(), &handle, args).await.unwrap();

    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["field"], expected_value);
}
```

#### 关键点

- `_impl` 泛型参数 `R: tauri::Runtime` 是必须的——否则测试传 `MockRuntime` 会不匹配。
- `build_mock_tauri_app()` 返回的 `App<MockRuntime>` 必须在测试生命周期内保活；
  `let _ = app;` 或把它存到作用域变量里，不要丢弃。
- `MockRuntime` 的 listener 在 `emit` 时**同步**派发，无需 `sleep` / `tokio::time::advance`。
- 触碰 SQLite 的仍需 `#[serial]`，和其他集成测试一致。
- 参考实现：`app/src-tauri/tests/commands_apphandle_pilot.rs`（`cancel_task_impl`）。

## CI

- `.github/workflows/test.yml`：push/PR 触发 `cargo test --features test-support`，同时生成 LCOV 上传 artifact
- 新 Tauri command 或 api wrapper 必须附测试（第一轮补课完成后启用 coverage-gate）

## 参考

- 测试框架总设计：`docs/superpowers/specs/2026-04-20-testing-framework-design.md`
- Plan A1 实施计划：`docs/superpowers/plans/2026-04-20-plan-a1-rust-test-infra.md`

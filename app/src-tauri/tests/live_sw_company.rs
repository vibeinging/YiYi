//! Live 测试:用真实 deepseek-v4-pro 跑软件公司角色 agent,review 实际返回。
//!
//! 群聊派工接口最终把每个角色路由到这条 agent 执行路径(PM 接手 = PM agent 跑、
//! 派工 = 各角色 agent 跑)。这里直接驱动它:真人设(各角色 AGENT.md)+ 真 F2 工具
//! 过滤(with_tool_filter)+ 真文件工具,最可观测。
//!
//! 仅当 `YIYI_LIVE_TEAM=1` 且 `DEEPSEEK_KEY` 存在时运行(CI 安全,真实计费)。运行:
//! ```
//! YIYI_LIVE_TEAM=1 DEEPSEEK_KEY=$(sqlite3 ~/.yiyi/yiyi.db \
//!   "SELECT api_key FROM provider_settings WHERE provider_id='deepseek'") \
//!   cargo test --features test-support --test live_sw_company -- --nocapture --test-threads=1
//! ```

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use app_lib::engine::agents::{AgentDefinition, AgentRegistry};
use app_lib::engine::db::Database;
use app_lib::engine::llm_client::LLMConfig;
use app_lib::engine::react_agent::{run_react_with_options, run_react_with_options_stream, AgentStreamEvent};
use app_lib::engine::tools::{
    get_database, mark_ready, set_database, set_full_access, with_task_working_dir, with_tool_filter,
};

fn live() -> Option<LLMConfig> {
    if std::env::var("YIYI_LIVE_TEAM").is_err() {
        eprintln!("SKIP:设 YIYI_LIVE_TEAM=1 + DEEPSEEK_KEY 才跑(真实调用 DeepSeek)");
        return None;
    }
    let key = std::env::var("DEEPSEEK_KEY").ok().filter(|k| !k.is_empty())?;
    Some(LLMConfig {
        base_url: "https://api.deepseek.com/v1".into(),
        api_key: key,
        model: "deepseek-v4-pro".into(),
        provider_id: "deepseek".into(),
        ..Default::default()
    })
}

fn unique_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("yiyi-live-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn registry() -> AgentRegistry {
    AgentRegistry::load(&unique_dir("reg"), None)
}

/// 让工具子系统就绪(文件/shell 工具会先查 is_ready;dirty-path 等需全局 DB)。
fn ensure_runtime_ready() {
    mark_ready();
    if get_database().is_none() {
        let db = Database::open(&unique_dir("db")).expect("open db");
        set_database(Arc::new(db));
    }
}

/// PM 接手一个建造请求 —— 看它是否像 PM 那样澄清/规划(真人设 + 真权限)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_pm_handles_a_build_request() {
    let Some(cfg) = live() else { return };
    let reg = registry();
    let pm = reg.get("pm").expect("pm 角色");
    let sys = format!(
        "{}\n\n【场景】你在一个软件公司群里,用户刚给团队下达了一个任务。",
        pm.instructions
    );
    let reply = with_tool_filter(
        pm.tool_filter(),
        run_react_with_options(&cfg, &sys, "帮我做一个待办事项网页应用", &[], pm.max_iterations, None),
    )
    .await
    .expect("PM run");

    println!("\n############ PM 对「做个待办网页」的回复 ############\n{reply}\n############ END PM ############\n");
    assert!(!reply.trim().is_empty(), "PM 应有回复");
}

/// 前端工程师拿到明确任务 + 工作区 —— 看它是否真写出能跑的代码。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_frontend_writes_real_code() {
    let Some(cfg) = live() else { return };
    ensure_runtime_ready();
    let reg = registry();
    let fe = reg.get("frontend_dev").expect("frontend_dev 角色");
    // canonicalize:macOS 上 /tmp → /private/tmp,授权路径要和写文件解析后的真路径一致。
    let ws = unique_dir("fe-ws").canonicalize().unwrap();
    // 授权这个工作区可写(生产里项目工作区被授权 / 用户点 F1 权限卡批准;测试里直接授)。
    app_lib::engine::tools::refresh_authorized_folders(vec![app_lib::engine::db::AuthorizedFolderRow {
        id: "live-ws".into(),
        path: ws.to_string_lossy().to_string(),
        label: Some("live ws".into()),
        permission: "read_write".into(),
        is_default: true,
        created_at: 0,
        updated_at: 0,
    }])
    .await;
    let sys = format!(
        "{}\n\n【场景】你在软件公司群里负责前端,在隔离的项目工作区里干活。",
        fe.instructions
    );
    let task = "写一个纯前端的待办事项页面:单文件 index.html(HTML+CSS+JS 内联),\
                用 localStorage 存数据,能添加、删除、标记完成。\
                **必须调用 write_file 工具**把它真正写到当前工作目录的 index.html 文件里,\
                不要只在回复里贴代码 —— 我要的是磁盘上能直接打开的文件。";

    let reply = with_task_working_dir(
        ws.clone(),
        with_tool_filter(
            fe.tool_filter(),
            run_react_with_options(&cfg, &sys, task, &[], fe.max_iterations, None),
        ),
    )
    .await
    .expect("frontend run");

    println!("\n############ 前端的回复 ############\n{reply}\n############ END 前端 ############\n");

    println!("############ 工作区文件 ############");
    for e in std::fs::read_dir(&ws).into_iter().flatten().flatten() {
        let p = e.path();
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        println!("  {} ({size} bytes)", p.display());
    }

    let idx = ws.join("index.html");
    if idx.exists() {
        let html = std::fs::read_to_string(&idx).unwrap_or_default();
        let preview: String = html.chars().take(2200).collect();
        println!("\n############ index.html(前 2200 字)############\n{preview}\n############ END index.html ############");
        assert!(
            html.to_lowercase().contains("localstorage") || html.contains("<script"),
            "index.html 应是个真前端页面"
        );
    } else {
        println!("⚠️ 没写出 index.html —— 看上面前端的回复理解原因");
    }
    let _ = std::fs::remove_dir_all(&ws);
}

/// 跑一个角色一轮:真人设 + 真 F2 过滤 + 角色真 max_iter + 共享工作区。
async fn run_role(cfg: &LLMConfig, role: &AgentDefinition, ws: &Path, task: &str) -> String {
    let sys = format!(
        "{}\n\n【场景】你在软件公司群里,在团队共享的项目工作区里干活。产出必须用 \
         write_file/edit_file 落成文件;读队友的东西用 read_file/list_directory。",
        role.instructions
    );
    // idle 超时(不是总超时!):每个流事件(token/工具)重置计时;只有 150s 没新事件
    // (LLM 流半开挂起)才中断 —— 进展中的长任务想跑多久跑多久,不被一刀切。
    // cancelled 旗标在流读挂起时不会被检查,所以用 select! 让看门狗赢、把 future drop 掉
    // (断开挂起的连接读)。
    let last = Arc::new(Mutex::new(Instant::now()));
    let last_for_event = last.clone();
    let on_event = move |_ev: AgentStreamEvent| {
        if let Ok(mut t) = last_for_event.lock() {
            *t = Instant::now();
        }
    };
    let run = with_task_working_dir(
        ws.to_path_buf(),
        with_tool_filter(
            role.tool_filter(),
            run_react_with_options_stream(
                cfg, &sys, task, &[], role.max_iterations, None, on_event, None, None, None,
            ),
        ),
    );
    let idle_limit = Duration::from_secs(150);
    let watchdog = async {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let idle = last.lock().map(|t| t.elapsed()).unwrap_or_default();
            if idle > idle_limit {
                return;
            }
        }
    };
    tokio::select! {
        r = run => r.unwrap_or_else(|e| format!("(运行出错: {e})")),
        _ = watchdog => "(idle 超时:LLM 流 150s 无响应,该角色这轮跳过)".to_string(),
    }
}

fn print_tree(ws: &Path) {
    fn walk(dir: &Path, depth: usize) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
        entries.sort_by_key(|e| e.path());
        for e in entries {
            let p = e.path();
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let kind = if p.is_dir() { "📁" } else { "📄" };
            println!("{}{kind} {name} ({size} bytes)", "  ".repeat(depth));
            if p.is_dir() {
                walk(&p, depth + 1);
            }
        }
    }
    println!("\n############ 项目工作区文件树 ############");
    walk(ws, 0);
}

/// 真实的长程多文件任务:团队建一个全栈待办 app。后端写 API+契约 → 前端读契约写 UI →
/// 测试写并跑测试。多文件、多角色、真交接(靠工作区里的文件),全权限。review 产出。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_team_builds_a_real_fullstack_app() {
    let Some(cfg) = live() else { return };
    ensure_runtime_ready();
    set_full_access(true); // -p 全权限:团队在工作区里自由读写 / 执行
    let reg = registry();
    // 固定路径,跑完不清理 —— 供事后逐行 review 代码。
    let ws_root = std::env::temp_dir().join("yiyi-team-review");
    let _ = std::fs::remove_dir_all(&ws_root);
    std::fs::create_dir_all(&ws_root).unwrap();
    let ws = ws_root.canonicalize().unwrap();
    eprintln!("\n========== 团队建全栈待办 app(工作区 {}) ==========", ws.display());

    // ① 后端:Python API + 数据 + 接口契约。
    eprintln!("\n—————— ① 后端工程师 ——————");
    let be = reg.get("backend_dev").expect("backend_dev");
    let r1 = run_role(&cfg, be, &ws,
        "做待办事项的后端:用 Python 标准库 http.server 写 server.py,提供 REST API:\
         GET /todos 列出、POST /todos 新增、PUT /todos/<id> 改、DELETE /todos/<id> 删,\
         数据持久化到 todos.json。再写一份 contract.md 讲清每个接口的路径/方法/请求体/返回。\
         全部用 write_file 写到当前目录。").await;
    println!("[后端] {}\n", r1.chars().take(600).collect::<String>());

    // ② 前端:读契约,写 UI。
    eprintln!("—————— ② 前端工程师 ——————");
    let fe = reg.get("frontend_dev").expect("frontend_dev");
    let r2 = run_role(&cfg, fe, &ws,
        "先 read_file 看 contract.md 弄清后端接口,然后写 index.html(纯前端,用 fetch 调后端 API),\
         实现待办的增、删、改、查、标记完成。用 write_file 写到当前目录的 index.html。").await;
    println!("[前端] {}\n", r2.chars().take(600).collect::<String>());

    // ③ 测试:读代码,写并跑测试。
    eprintln!("—————— ③ 测试工程师 ——————");
    let qa = reg.get("qa_engineer").expect("qa_engineer");
    let r3 = run_role(&cfg, qa, &ws,
        "先 list_directory 和 read_file 看后端 server.py 和 contract.md,写一个 test_api.py:\
         用 subprocess 起 server.py、用 urllib 测一遍 CRUD,断言每步返回对。\
         用 write_file 写到当前目录,再用 execute_shell 跑 python3 test_api.py,把跑的结果报出来。").await;
    println!("[测试] {}\n", r3.chars().take(800).collect::<String>());

    // review:文件树 + 关键文件预览。
    print_tree(&ws);
    for f in ["server.py", "contract.md", "index.html", "test_api.py"] {
        let p = ws.join(f);
        if p.exists() {
            let c = std::fs::read_to_string(&p).unwrap_or_default();
            println!("\n===== {f}（{} 字）=====\n{}", c.chars().count(), c.chars().take(1200).collect::<String>());
        } else {
            println!("\n⚠️ 缺 {f}");
        }
    }

    // 至少后端 + 前端的核心文件该落盘。
    assert!(ws.join("server.py").exists(), "后端应写出 server.py");
    assert!(ws.join("index.html").exists(), "前端应写出 index.html");
    eprintln!("\n========== 团队建 app 结束(文件留在 {}) ==========", ws.display());
}


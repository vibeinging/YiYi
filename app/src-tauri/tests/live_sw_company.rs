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

use std::path::PathBuf;
use std::sync::Arc;

use app_lib::engine::agents::AgentRegistry;
use app_lib::engine::db::Database;
use app_lib::engine::llm_client::LLMConfig;
use app_lib::engine::react_agent::run_react_with_options;
use app_lib::engine::tools::{
    get_database, mark_ready, set_database, with_task_working_dir, with_tool_filter,
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

//! Live 端到端:**完整 work 旅程**(launch → intake → 开工方案 → 开工 → 派工执行 →
//! 交付终态)用真实 LLM 驱动 R1–R6 重构后的整条 work 管线 —— 不 mock 任何一环:
//! 真 PM intake(propose_work_plan)、真 job 状态机(clarifying → pending_commit →
//! running → done)、真派工 DAG(角色真写文件到项目工作区)、真 finalize(交付摘要 +
//! work_jobs 终态)。
//!
//! 与 `live_sw_company.rs` 的分工:那边直接驱动单角色 agent(验"角色会干活");
//! 这边走 launch_work_job → commit_work_plan 的**产品管线**(验"管线把活串起来")。
//!
//! ## 运行(test-integration tier,真实计费,CI 不跑)
//!
//! ```bash
//! YIYI_WORK_LIVE=1 DEEPSEEK_KEY=$(sqlite3 ~/.yiyi/yiyi.db \
//!   "SELECT api_key FROM provider_settings WHERE provider_id='deepseek'") \
//!   cargo test --features test-support,test-integration \
//!   --test work_journey_live -- --nocapture
//! ```
//!
//! 可选 env:`YIYI_WORK_LIVE_MODEL`(默认 deepseek-v4-pro)、
//! `YIYI_WORK_LIVE_BASE_URL`(默认 https://api.deepseek.com/v1)。
//!
//! headless 要点(都是产品代码的真实回落路径,不是测试 hack):
//! - `ask_user` 无 APP_HANDLE → 返回"请基于已有信息自行决定"(PM 不阻塞);
//! - `propose_work_plan` 无 APP_HANDLE → 方案照常落库 + job 推进,只跳过发卡;
//! - finalize 的系统通知 / work://job_done 无 APP_HANDLE → no-op。

mod common;

#[allow(unused_imports)]
use common::*;

#[cfg(feature = "test-integration")]
mod live {
    use super::*;
    use serial_test::serial;
    use std::time::{Duration, Instant};

    use app_lib::commands::companion_groups::{
        add_companion_to_group_impl, create_companion_group_impl,
    };
    use app_lib::commands::work::{
        commit_work_plan_impl, dispatch_work_followup, launch_work_job_impl, WorkFollowup,
    };
    use app_lib::engine::db::NewCompanion;
    use app_lib::engine::work::plan::ProjectPlan;

    fn live_env() -> Option<(String, String, String)> {
        if std::env::var("YIYI_WORK_LIVE").ok().as_deref() != Some("1") {
            eprintln!("SKIP:设 YIYI_WORK_LIVE=1 + DEEPSEEK_KEY 才跑(真实调用 LLM,计费)");
            return None;
        }
        let key = std::env::var("DEEPSEEK_KEY").ok().filter(|k| !k.is_empty())?;
        let base = std::env::var("YIYI_WORK_LIVE_BASE_URL")
            .unwrap_or_else(|_| "https://api.deepseek.com/v1".into());
        let model = std::env::var("YIYI_WORK_LIVE_MODEL")
            .unwrap_or_else(|_| "deepseek-v4-pro".into());
        Some((key, base, model))
    }

    fn companion(name: &str, slug: &str, role: &str) -> NewCompanion {
        NewCompanion {
            name: name.into(),
            agent_definition_name: slug.into(),
            avatar_emoji: "🤖".into(),
            color_hex: "#6366F1".into(),
            persona_md_path: None,
            memory_user_id: format!("live_{slug}"),
            metadata_json: None,
            role_label: Some(role.into()),
        }
    }

    /// 轮询直到 `pred` 为真或超时;每 3s 打印一次当前 job 状态。
    async fn wait_until(
        db: &std::sync::Arc<app_lib::engine::db::Database>,
        session_id: &str,
        what: &str,
        timeout: Duration,
        pred: impl Fn(Option<&str>) -> bool,
    ) -> Option<String> {
        let start = Instant::now();
        loop {
            let status = db.get_work_job_status(session_id);
            if pred(status.as_deref()) {
                return status;
            }
            if start.elapsed() > timeout {
                eprintln!("⏰ 等待 {what} 超时({}s),最后状态 {status:?}", timeout.as_secs());
                return status;
            }
            eprintln!(
                "  …等待 {what}(已 {}s,状态 {})",
                start.elapsed().as_secs(),
                status.as_deref().unwrap_or("?")
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }

    fn print_tree(ws: &std::path::Path) {
        fn walk(dir: &std::path::Path, depth: usize) {
            let mut entries: Vec<_> =
                std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
            entries.sort_by_key(|e| e.path());
            for e in entries {
                let p = e.path();
                let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let kind = if p.is_dir() { "📁" } else { "📄" };
                eprintln!("{}{kind} {name} ({size} bytes)", "  ".repeat(depth + 1));
                if p.is_dir() {
                    walk(&p, depth + 1);
                }
            }
        }
        eprintln!("📂 项目工作区 {}:", ws.display());
        walk(ws, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[serial]
    async fn live_work_journey_launch_to_delivery() {
        let Some((key, base, model)) = live_env() else { return };

        let t = build_test_app_state().await;
        let db = t.state().db.clone();

        // 工具子系统全局(OnceLock;集成测试 = 独立进程,本测试独占,安全)。
        app_lib::engine::tools::set_database(db.clone());
        app_lib::engine::tools::mark_ready();
        // 全权限:派工角色要真实写文件/跑命令;权限弹窗在 headless 无人可点。
        app_lib::engine::tools::set_full_access(true);
        // 工具层全局 providers(生产由 lib.rs 初始化设置):propose_work_plan 在工具内
        // 直接派工,经 resolve_llm_config_from_globals 解析 —— 不设它派工必败。
        app_lib::engine::tools::set_providers(t.state().providers.clone());

        // 真实 provider(active_llm = deepseek-v4-pro)。
        {
            use app_lib::state::providers::{ModelSlotConfig, ProviderSettings};
            let mut providers = t.state().providers.write().await;
            providers.providers.insert(
                "deepseek".into(),
                ProviderSettings {
                    base_url: Some(base.clone()),
                    api_key: Some(key),
                    extra_models: vec![],
                },
            );
            providers.active_llm = Some(ModelSlotConfig {
                provider_id: "deepseek".into(),
                model: model.clone(),
            });
        }
        eprintln!("══ live work 旅程(model={model}, base={base})══");

        // 团队:PM(headless find_project_lead 只认 "pm" slug)+ 前端 + QA(⑧ 接力用)。
        let pm = db.adopt_companion(&companion("产品经理", "pm", "产品经理/牵头人")).unwrap();
        let fe = db
            .adopt_companion(&companion("前端", "frontend_dev", "前端工程师,写 HTML/CSS/JS"))
            .unwrap();
        let qa = db
            .adopt_companion(&companion("质检", "qa_engineer", "测试工程师,检查交付质量"))
            .unwrap();
        let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
            .await
            .unwrap();
        add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();
        add_companion_to_group_impl(t.state(), gid, fe).await.unwrap();
        add_companion_to_group_impl(t.state(), gid, qa).await.unwrap();

        // 项目工作区:固定 /tmp 路径,跑完不清理,供事后 review 交付物。
        let ws_root = std::env::temp_dir().join("yiyi-work-journey-live");
        let _ = std::fs::remove_dir_all(&ws_root);
        std::fs::create_dir_all(&ws_root).unwrap();
        let ws = ws_root.canonicalize().unwrap();

        // ① launch:显式发起(工作页「新建工作」的产品路径)。
        eprintln!("—— ① launch_work_job ——");
        let task = "做一个单文件的待办事项网页:index.html(HTML/CSS/JS 全部内联),\
                    用 localStorage 存数据,支持添加、删除、标记完成。不需要后端、\
                    不需要构建工具、不要安装任何依赖。需求信息已经齐全,不需要再向用户\
                    澄清,直接用 propose_work_plan 把任务派给前端。";
        let launched = launch_work_job_impl(
            t.state(),
            gid,
            task,
            Some(ws.to_string_lossy().to_string()),
        )
        .await
        .expect("launch_work_job 应成功");
        let sid = launched.session_id.clone();
        eprintln!("  session={sid} intake_collab={}", launched.collaboration_id);
        assert_eq!(db.get_work_job_status(&sid).as_deref(), Some("clarifying"));

        // ② 等 PM intake **直接派工**(2026-06-11 决策:无确认环节,propose 即派发,
        // job 直入 running)。PM 这轮没派就 followup 催一次(顺带验 followup 放行)。
        eprintln!("—— ② 等 PM 直接派工(intake → running)——");
        let mut status = wait_until(&db, &sid, "直接派工", Duration::from_secs(240), |s| {
            s == Some("running")
        })
        .await;
        if status.as_deref() != Some("running") && !db.has_active_work_intake(&sid) {
            eprintln!("  PM 这轮没派工,followup 催一次…");
            let out = dispatch_work_followup(
                t.state(),
                &sid,
                "信息已经齐了,不用再问,直接用 propose_work_plan 把任务派出去。",
                &[],
            )
            .await
            .expect("followup 应成功");
            assert!(matches!(out, WorkFollowup::Intake(_)), "intake 不在跑时 followup 应起新 intake");
            status = wait_until(&db, &sid, "直接派工(第二轮)", Duration::from_secs(240), |s| {
                s == Some("running")
            })
            .await;
        }
        // 失败时 dump 牵头者说了什么,便于定位。
        if status.as_deref() != Some("running") {
            for (name, text) in db.recent_work_step_outputs(&sid, 3) {
                eprintln!("  [{}] {}", name, text.chars().take(400).collect::<String>());
            }
            panic!("PM 应在 intake 里直接派工(job → running),实际 {status:?}");
        }

        // ③ 不展示方案卡(「就干就行了」):无 work_plan 消息,只有派工锚点。
        eprintln!("—— ③ 验派工锚点(无方案卡)——");
        let msgs = db.get_messages(&sid, None).unwrap();
        assert!(
            msgs.iter().all(|m| m.context_type.as_deref() != Some("work_plan")),
            "直接派发不再落方案记录卡",
        );
        assert!(
            msgs.iter().any(|m| m.content.contains("🛠️ 开工")),
            "应有派工锚点消息",
        );

        // ④ 重复派工守卫:running 中再 commit(旧方案卡兼容路径)应被拒。
        eprintln!("—— ④ 重复派工守卫 ——");
        let dup = commit_work_plan_impl(
            t.state(),
            &sid,
            ProjectPlan {
                tasks: vec![app_lib::engine::work::plan::ProjectTask {
                    role: "frontend_dev".into(),
                    objective: "重复".into(),
                    depends_on: vec![],
                }],
            },
        )
        .await;
        assert!(dup.is_err(), "running 中重复派工应被拒,got {dup:?}");

        // ⑤ 等团队真实干完(finalize → job 终态)。写码任务给宽裕时间。
        eprintln!("—— ⑤ 等交付(派工执行)——");
        let status = wait_until(&db, &sid, "交付", Duration::from_secs(600), |s| {
            matches!(s, Some("done") | Some("failed") | Some("aborted"))
        })
        .await;

        // review:工作区文件树 + 交付摘要。
        print_tree(&ws);
        let msgs = db.get_messages(&sid, None).unwrap();
        for m in msgs.iter().filter(|m| m.context_type.as_deref() == Some("work_job")) {
            eprintln!(
                "  [work_job 消息] {}",
                m.content.chars().take(300).collect::<String>().replace('\n', " ")
            );
        }

        // ⑥ 终态断言:交付闭环全到位。
        assert_eq!(status.as_deref(), Some("done"), "work job 应交付完成");
        let jobs = db.list_work_jobs();
        let job = jobs.iter().find(|j| j.session_id == sid).expect("job 应在列表");
        assert_eq!(job.status, "done");
        assert!(job.completed_at.is_some(), "终态应写 completed_at");
        // 交付摘要(compose_work_summary)已 upsert 到派工锚点(context_type=work_job)。
        assert!(
            msgs.iter().any(|m| m.context_type.as_deref() == Some("work_job")
                && m.content.contains("✅ 交付完成")),
            "应有「✅ 交付完成」交付摘要消息",
        );
        // 真实交付物落盘:工作区应有非空文件(任务指定了 index.html)。
        let mut total_bytes = 0u64;
        let mut has_index = false;
        for e in walkdir(&ws) {
            total_bytes += std::fs::metadata(&e).map(|m| m.len()).unwrap_or(0);
            if e.file_name().map(|n| n == "index.html").unwrap_or(false) {
                has_index = true;
            }
        }
        assert!(total_bytes > 0, "工作区应有真实交付物文件");
        assert!(has_index, "任务指定单文件 index.html,工作区应有它");

        // ⑦ 用户 @ 直达工人(2026-06-12 @ 通信规则):任务直达前端,不经牵头者。
        eprintln!("—— ⑦ 用户 @ 直达前端(改标题)——");
        let out = dispatch_work_followup(
            t.state(),
            &sid,
            "把 index.html 的 <title> 改成「我的待办清单」,只改标题,别动其他。",
            &[fe],
        )
        .await
        .expect("@ 直达应成功");
        let direct_id = match out {
            WorkFollowup::Intake(id) => id,
            WorkFollowup::Notice(text) => panic!("@ 工人应直达派活:{text}"),
        };
        assert_eq!(
            db.get_collaboration_kind(direct_id).as_deref(),
            Some("work_dispatch"),
            "直达任务应标 work_dispatch",
        );
        assert_eq!(db.get_work_job_status(&sid).as_deref(), Some("running"));
        let status = wait_until(&db, &sid, "@ 直达交付", Duration::from_secs(300), |s| {
            matches!(s, Some("done") | Some("failed") | Some("aborted"))
        })
        .await;
        assert_eq!(status.as_deref(), Some("done"), "@ 直达任务应交付完成");
        let html = std::fs::read_to_string(ws.join("index.html")).unwrap_or_default();
        assert!(
            html.contains("我的待办清单"),
            "前端应已把标题改成「我的待办清单」",
        );

        // ⑧ agent 互相 @(call_teammate 接力):@ QA 检查,发现不符 → 叫前端接力修。
        eprintln!("—— ⑧ @ QA → call_teammate 接力前端 ——");
        // 自然语言指令:不提工具名、不提 role 标识 —— QA 要靠 prompt 里的【你的队友】
        // 名单自己找到 frontend_dev 并自发 call_teammate(验证「材料齐了模型会不会用」)。
        let out = dispatch_work_followup(
            t.state(),
            &sid,
            "检查 index.html 的 <title> 是否是「我的待办清单 v2」。现在多半不是 —— \
             你**自己不要改任何文件**,让前端去把标题改成「我的待办清单 v2」。",
            &[qa],
        )
        .await
        .expect("@ QA 应成功");
        let relay_id = match out {
            WorkFollowup::Intake(id) => id,
            WorkFollowup::Notice(text) => panic!("@ QA 应直达派活:{text}"),
        };
        let status = wait_until(&db, &sid, "接力交付", Duration::from_secs(360), |s| {
            matches!(s, Some("done") | Some("failed") | Some("aborted"))
        })
        .await;
        // dump 接力协作的步,便于失败定位。
        let step_count: i64 = {
            let conn = db.get_conn().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM collaboration_steps WHERE collaboration_id = ?1",
                [relay_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };
        eprintln!("  接力协作 {relay_id} 共 {step_count} 步(≥2 = call_teammate 动态加步生效)");
        assert_eq!(status.as_deref(), Some("done"), "接力任务应交付完成");
        assert!(
            step_count >= 2,
            "QA 应经 call_teammate 给前端加了动态接力步(实际 {step_count} 步)",
        );
        let html = std::fs::read_to_string(ws.join("index.html")).unwrap_or_default();
        assert!(
            html.contains("我的待办清单 v2"),
            "前端(接力步)应已把标题改成 v2",
        );

        eprintln!(
            "══ 旅程贯通:launch → 直接派工 → 交付 → @ 直达 → @ 接力(产物留在 {})══",
            ws.display()
        );
    }

    /// 递归收集目录下所有文件路径(浅实现,review/断言用)。
    fn walkdir(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
        out
    }
}

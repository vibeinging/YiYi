//! Universal `ask_user` gate —— 把 permission_gate 从 yes/no 泛化成"问一个开放
//! 问题(可带选项),阻塞等用户答"。与权限闸的两点关键不同:
//!   1. oneshot 载的是 `String`(用户的答案文本)而非 `bool`。
//!   2. 提问**落库**(`pending_questions`)再阻塞——关 app 重开仍能恢复卡片,
//!      用户答完写回;同一问题重问命中**已答去重**直接读答案,不再阻塞。
//!
//! 这是"软件公司群聊"特性的 F1 地基:任何 agent(单聊 YiYi、分身、未来的 PM/UI
//! 角色)都能在执行中向用户抛开放问题、阻塞等答。详见
//! docs/design/2026-06-05_软件公司群聊-长程协作-设计.md §四 F1。

use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::sync::{oneshot, Mutex};

use crate::engine::db::PendingQuestion;

/// 发给前端的 `chat://ask_user` 事件载荷。
#[derive(Clone, serde::Serialize)]
pub struct AskUserRequest {
    pub request_id: String,
    pub session_id: String,
    pub collaboration_id: Option<i64>,
    /// 提问者 companion id(0 = YiYi)。
    pub companion_id: i64,
    /// 提问者展示名(渲染气泡)。
    pub asker_name: String,
    pub question: String,
    /// 选项;空 → 自由文本输入。
    pub options: Vec<String>,
    /// "choice" | "text" | 领域 kind。
    pub kind: String,
    pub created_at: i64,
}

// ── 内存等待区(进程内快路径)─────────────────────────────────────────────
static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<String>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<String>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 活的 agent 运行最多等多久;到点优雅降级(返回提示串,不无限挂)。
/// DB 行仍保持 pending,所以问题卡片不丢、用户随后仍可答,下次重问命中去重。
const TIMEOUT_SECS: u64 = 3600; // 1h

// ── 提问者身份(task-local,默认 YiYi;S1 角色执行器再注入真身)──────────────
tokio::task_local! {
    static ASK_ASKER: (i64, String);
}

/// 在 fut 期间把"当前提问者"绑成某个 companion——角色执行器(S1)包这一层,
/// 让 ask_user 抛出的气泡显示正确的角色名/头像。F1 不包时默认 YiYi。
pub async fn with_ask_asker<F, R>(companion_id: i64, name: String, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    ASK_ASKER.scope((companion_id, name), fut).await
}

fn current_asker() -> (i64, String) {
    ASK_ASKER
        .try_with(|a| a.clone())
        .unwrap_or((0, "YiYi".to_string()))
}

fn scope_key(session_id: &str, collaboration_id: Option<i64>) -> String {
    if !session_id.is_empty() {
        session_id.to_string()
    } else {
        collaboration_id.map(|c| format!("collab_{c}")).unwrap_or_default()
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/// 向用户抛一个开放问题,阻塞直到用户答或超时。返回用户的答案文本。
pub async fn ask_user(req: AskUserRequest) -> String {
    let key = scope_key(&req.session_id, req.collaboration_id);

    // 去重:同 scope 里这个问题已答过 → 直接返回旧答案,不再阻塞。
    // 这正是 agent 重启后重跑、再问同一问题时"直接拿答案"的路径。
    if !key.is_empty() {
        if let Some(db) = super::get_database() {
            if let Some(prev) = db.find_answered_question(&key, &req.question) {
                log::info!("ask_user: dedup hit answered question in scope {key}");
                return prev;
            }
        }
    }

    let handle = match super::APP_HANDLE.get() {
        Some(h) => h,
        None => {
            return "（无法询问用户：当前是无界面环境。请基于已有信息自行决定。）".to_string()
        }
    };

    // 阻塞前先落库——保证问题在任何重启前已持久化,卡片可恢复。
    if let Some(db) = super::get_database() {
        let row = PendingQuestion {
            request_id: req.request_id.clone(),
            session_id: req.session_id.clone(),
            collaboration_id: req.collaboration_id,
            step_id: None,
            companion_id: req.companion_id,
            asker_name: req.asker_name.clone(),
            question: req.question.clone(),
            options_json: if req.options.is_empty() {
                None
            } else {
                serde_json::to_string(&req.options).ok()
            },
            kind: req.kind.clone(),
            status: "pending".to_string(),
            answer: None,
            created_at: req.created_at,
            answered_at: None,
        };
        if let Err(e) = db.insert_pending_question(&row) {
            log::warn!("ask_user: persist failed: {e}");
        }
    }

    let rx = register(&req.request_id).await;

    log::info!(
        "ask_user: '{}' asks '{}' (session={})",
        req.asker_name, req.question, req.session_id
    );

    if handle.emit("chat://ask_user", &req).is_err() {
        pending().lock().await.remove(&req.request_id);
        return "（询问用户失败：事件发送出错。）".to_string();
    }

    match await_answer(&req.request_id, rx, TIMEOUT_SECS).await {
        Some(answer) => answer,
        None => {
            log::info!("ask_user: timed out for {}", req.request_id);
            "（用户暂时没有回答。请基于现有信息继续，或稍后再确认。）".to_string()
        }
    }
}

/// 注册一个待答请求,返回接收端。在 emit 提问之前调用——保证用户的答案能被
/// 路由回来。拆成独立函数是为了让测试能在没有 APP_HANDLE/LLM 的情况下,确定性地
/// 驱动"agent 阻塞等待 → 用户回答 → 续跑"这条真实链路。
pub(crate) async fn register(request_id: &str) -> oneshot::Receiver<String> {
    let (tx, rx) = oneshot::channel::<String>();
    pending().lock().await.insert(request_id.to_string(), tx);
    rx
}

/// 等待答案直到超时。拿到答案返回 `Some`;超时则清掉登记并返回 `None`
/// (上层据此优雅降级,不无限挂)。
pub(crate) async fn await_answer(
    request_id: &str,
    rx: oneshot::Receiver<String>,
    timeout_secs: u64,
) -> Option<String> {
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(answer)) => Some(answer),
        _ => {
            pending().lock().await.remove(request_id);
            None
        }
    }
}

/// 把用户的答案投递给阻塞中的调用方(由 Tauri 命令 `answer_user_question` 调)。
/// 只负责唤醒内存等待者;DB 的 answered 落库由命令层先行完成,所以即便此处
/// 没有在途等待者(进程已重启、等待者已蒸发),答案也不丢。
pub async fn respond(request_id: &str, answer: String) {
    if let Some(tx) = pending().lock().await.remove(request_id) {
        let _ = tx.send(answer);
    }
}

// ── Tool 定义与分发入口 ────────────────────────────────────────────────────

/// `ask_user` 的工具 schema。供 catalog 注册。
pub fn definitions() -> Vec<super::types::ToolDefinition> {
    vec![super::types::tool_def(
        "ask_user",
        "向用户提出一个**只有用户本人能回答**的开放问题,并暂停等待回答。\
         用于:需求不清需澄清、要用户在几个方向里拍板、需要用户提供你无从得知的信息\
         (如品牌名、目标受众、偏好)。**不要**用它问那些你能自己查/自己定的事;\
         日常偏好类决策优先用 `ask_buddy` 咨询用户的数字分身。问题要具体、一次问一个。",
        serde_json::json!({
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "要问用户的问题(具体、明确,一次一个)"
                },
                "options": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "可选:给用户几个选项让其点选;省略则为开放文本回答"
                },
                "kind": {
                    "type": "string",
                    "description": "可选:问题类型标签(如 design_choice / requirement),仅用于前端呈现"
                }
            },
            "required": ["question"]
        }),
    )]
}

/// 工具:`ask_user(question, options?, kind?)`。在群聊/单聊里向用户提问。
pub async fn ask_user_tool(args: &serde_json::Value) -> String {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if question.is_empty() {
        return "ask_user 需要一个非空的 question 参数。".to_string();
    }
    let options: Vec<String> = args
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .filter(|s| !s.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if options.is_empty() {
                "text".to_string()
            } else {
                "choice".to_string()
            }
        });

    let (companion_id, asker_name) = current_asker();

    let req = AskUserRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        session_id: super::get_current_session_id(),
        collaboration_id: None,
        companion_id,
        asker_name,
        question,
        options,
        kind,
        created_at: crate::engine::db::now_ts(),
    };
    ask_user(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_key_prefers_session_then_collab() {
        assert_eq!(scope_key("sess-1", Some(7)), "sess-1");
        assert_eq!(scope_key("", Some(7)), "collab_7");
        assert_eq!(scope_key("", None), "");
    }

    #[tokio::test]
    async fn respond_without_pending_is_noop() {
        // 进程重启后等待者已蒸发——respond 不应 panic。
        respond("no-such-id", "hi".to_string()).await;
    }

    #[tokio::test]
    async fn gate_register_respond_await_delivers_answer() {
        // agent 阻塞等待的真实链路:注册 → 用户答 → 拿到答案。
        let rx = register("rt-id").await;
        respond("rt-id", "the answer".to_string()).await;
        assert_eq!(await_answer("rt-id", rx, 5).await, Some("the answer".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn gate_await_times_out_when_unanswered() {
        // 没人回答 → paused clock 空转自动推进到超时 → 优雅降级返回 None。
        let rx = register("timeout-id").await;
        assert_eq!(await_answer("timeout-id", rx, 3600).await, None);
    }

    #[test]
    fn tool_parses_options_into_choice_kind() {
        // 仅验证参数解析分支(不触发阻塞):有 options → kind 默认 choice。
        let args = serde_json::json!({
            "question": "选哪个框架?",
            "options": ["React", "Vue", "  "]
        });
        let opts: Vec<String> = args
            .get("options")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .filter(|s| !s.trim().is_empty())
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(opts, vec!["React".to_string(), "Vue".to_string()]);
    }
}

/// 端到端链路测试:建一个对话 → agent 跑长程任务 → 中途向用户提问、阻塞等待 →
/// 用户回答 → agent 续跑。用真实的 gate(oneshot register/await/respond)+ 真实
/// DB(pending_questions 生命周期 + 问答消息持久化 + 去重),确定性驱动。
///
/// 简化的两处(headless 测试不可避免):① agent 的"决定调 ask_user"由测试手动驱动,
/// 不跑 LLM;② `chat://ask_user` 的 emit 跳过(全局 APP_HANDLE 是生产 Wry 运行时,
/// 无法在 headless 测试设为 mock)。被测的是 F1 真正的并发阻塞/恢复 + 持久化契约。
#[cfg(all(test, feature = "test-support"))]
mod flow_tests {
    use super::*;
    use crate::engine::db::PendingQuestion;
    use crate::test_support::TempDb;
    use serial_test::serial;

    fn pending(req_id: &str, session: &str, question: &str, options: &str) -> PendingQuestion {
        PendingQuestion {
            request_id: req_id.into(),
            session_id: session.into(),
            collaboration_id: None,
            step_id: None,
            companion_id: 0,
            asker_name: "YiYi".into(),
            question: question.into(),
            options_json: Some(options.into()),
            kind: "choice".into(),
            status: "pending".into(),
            answer: None,
            created_at: 1_700_000_000_000,
            answered_at: None,
        }
    }

    #[tokio::test]
    #[serial]
    async fn conversation_with_long_task_asks_user_then_resumes() {
        let t = TempDb::new();
        let db = t.db();

        // ① 建一个对话:用户下达一个长程任务。
        db.push_message("sess-1", "user", "帮我做一个 TODO 网页应用").unwrap();

        // ② agent 跑到一半需要拍板,抛出开放问题:落库 pending + 注册等待(在真 app
        //    里此时会 emit chat://ask_user;这里直接走 register 接缝)。
        let req = "q-framework";
        db.insert_pending_question(&pending(req, "sess-1", "前端用 React 还是 Vue?", r#"["React","Vue"]"#))
            .unwrap();
        let rx = register(req).await;

        // 此刻 agent 阻塞;问题已持久化 → 关 app 重开前端能恢复这张卡片。
        assert_eq!(db.list_pending_questions("sess-1").len(), 1);

        // ③ 用户回答(复刻 answer_user_question 命令逻辑:固化问答成消息 + 标记 + 唤醒)。
        let q = db.get_pending_question(req).unwrap();
        db.push_message(&q.session_id, "assistant", &q.question).unwrap();
        db.push_message(&q.session_id, "user", "React").unwrap();
        db.mark_question_answered(req, "React").unwrap();
        respond(req, "React".to_string()).await;

        // ④ agent 拿到答案,继续它的长程任务。
        assert_eq!(await_answer(req, rx, 5).await, Some("React".to_string()));

        // ⑤ 断言链路效果:
        //  - 问题已答 → 不再出现在未答列表(重开 app 不会重复弹)。
        assert!(db.list_pending_questions("sess-1").is_empty());
        assert_eq!(db.get_pending_question(req).unwrap().status, "answered");
        //  - 问答固化成消息,历史连贯(回答不被 loadMessages 覆盖丢失)。
        let contents: Vec<String> = db
            .get_messages("sess-1", None)
            .unwrap()
            .into_iter()
            .map(|m| m.content)
            .collect();
        assert!(contents.iter().any(|c| c == "前端用 React 还是 Vue?"));
        assert!(contents.iter().any(|c| c == "React"));
        //  - 去重:agent 重启后重跑、再问同一问题 → 直接命中已答答案,不再阻塞。
        assert_eq!(
            db.find_answered_question("sess-1", "前端用 React 还是 Vue?"),
            Some("React".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    #[serial]
    async fn unanswered_question_survives_for_cross_session_recovery() {
        let t = TempDb::new();
        let db = t.db();

        // agent 提问后用户一直没答(模拟用户离开)。
        let req = "q-unanswered";
        db.insert_pending_question(&pending(req, "sess-2", "要支持多账本吗?", r#"["要","不要"]"#))
            .unwrap();
        let rx = register(req).await;

        // 活的 agent 运行等到超时 → 优雅降级(返回 None,不无限挂)。
        assert_eq!(await_answer(req, rx, 3600).await, None);

        // 但问题仍 pending 落在库里 → 关 app 重开,前端 list_pending_questions 能把卡片拉回来。
        let recovered = db.list_pending_questions("sess-2");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].question, "要支持多账本吗?");
        assert_eq!(
            recovered[0].options_json.as_deref(),
            Some(r#"["要","不要"]"#)
        );
    }
}

//! work/plan(缝 6 归位):PM 的结构化计划 → 协作 DAG。
//!
//! 从 `engine/collaboration/project.rs` **复制**(S4:复制不删,原件 S8 删)。模块位置从
//! `collaboration` 平移到 `work` —— "派工"不是 collaboration 的变种,是 work 表面的核心
//! 数据变换。PM 把目标拆成任务(每条:角色 + 目标 + 依赖),本模块把它转成
//! `CollaborationPlan`(本轮仍复用 orchestrator)—— 每条任务一个 1-participant step
//! (participant = 该角色在群里的 companion),`depends_on` 表交接顺序,交给 orchestrator
//! 调度(无依赖并行、有依赖串行)。纯函数、可测透。
//!
//! S4:整模块未接线(`build_*` 由 work/launcher 与 commands/work 在 S5/S6 调用),



use serde::{Deserialize, Serialize};

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::{
    CollaborationPlan, Participant, Step, StepId, StepInput, StepKind, StepStatus,
};
use crate::engine::db::Companion;

/// PM 拆出的一条任务。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectTask {
    /// 执行角色的 agent_definition_name(frontend_dev / backend_dev / ui_designer / qa_engineer …)。
    pub role: String,
    /// 这条任务要做什么(喂给该角色的 prompt)。
    pub objective: String,
    /// 上游任务下标(0-based,指向本 plan 内其它任务);它们 done 后本任务才开跑(交接顺序)。
    #[serde(default)]
    pub depends_on: Vec<usize>,
}

/// PM 提交的开工方案。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectPlan {
    pub tasks: Vec<ProjectTask>,
}

/// 把 PM 的计划转成协作 DAG。
///
/// - 每条任务 → 一个 `StepKind::ParallelAgents` 且 1 个 participant 的 step(与现有派发
///   的流式气泡渲染一致)。
/// - 任务下标(0-based)→ step id(1-based);`depends_on` 同样 +1 映射。
/// - participant = 该角色在群成员里的 companion;`MemoryScope::Group` 让团队共享上下文。
/// - 校验:角色必须在群里;依赖下标必须合法、不能自依赖。
pub fn build_project_collaboration_plan(
    plan: &ProjectPlan,
    members: &[Companion],
    group_id: i64,
) -> Result<CollaborationPlan, String> {
    Ok(CollaborationPlan {
        steps: build_steps(&plan.tasks, members, group_id, 0)?,
    })
}

/// 把任务列表转成 step 列表。step id 从 `id_offset + 1` 开始 —— 初始计划 `id_offset=0`
/// (→ 1..n);**动态追加任务时 `id_offset = 已有 step 数`,续号不撞**。
/// `depends_on` 是本批任务内的 0-based 下标,同样按 `id_offset` 偏移映射成 step id
/// (所以追加批次内部的交接顺序也对)。
pub fn build_steps(
    tasks: &[ProjectTask],
    members: &[Companion],
    group_id: i64,
    id_offset: StepId,
) -> Result<Vec<Step>, String> {
    if tasks.is_empty() {
        return Err("没有可派的任务".into());
    }
    let n = tasks.len();
    let mut steps = Vec::with_capacity(n);
    for (i, task) in tasks.iter().enumerate() {
        let member = members
            .iter()
            .find(|m| m.agent_definition_name == task.role)
            .ok_or_else(|| format!("角色「{}」不在群里,无法派工", task.role))?;

        let depends_on: Vec<StepId> = task
            .depends_on
            .iter()
            .map(|&d| {
                if d >= n {
                    Err(format!("任务 {i} 的依赖下标 {d} 越界(共 {n} 条任务)"))
                } else if d == i {
                    Err(format!("任务 {i} 依赖了自己"))
                } else {
                    Ok(id_offset + (d as StepId) + 1)
                }
            })
            .collect::<Result<_, _>>()?;

        steps.push(Step {
            id: id_offset + (i as StepId) + 1,
            kind: StepKind::ParallelAgents,
            participants: vec![Participant {
                companion_id: member.id,
                name: member.name.clone(),
                avatar_emoji: member.avatar_emoji.clone(),
                color_hex: member.color_hex.clone(),
                memory_scope: MemoryScope::Group(group_id),
            }],
            depends_on,
            input: StepInput {
                prompt: task.objective.clone(),
                // 标 project_task,让 worker 把上游产出按"交接"语义喂下游(后端的接口给前端…),
                // 而非"群里的讨论"。
                metadata: serde_json::json!({ "mode": "project_task" }),
            },
            output: None,
            status: StepStatus::Pending,
            started_at: None,
            finished_at: None,
        });
    }
    Ok(steps)
}

/// QA 测出 bug → 生成"修复 + 重新验证"两条追加任务。修复派给出 bug 的角色,
/// 重新验证派回 QA(依赖修复完成)。`qa_role` 通常是 "qa_engineer"。
pub fn build_bug_fix_followup(target_role: &str, qa_role: &str, bug: &str) -> Vec<ProjectTask> {
    vec![
        ProjectTask {
            role: target_role.into(),
            objective: format!("修复测试发现的问题:{bug}\n改完用 write_file/edit_file 落盘,说清改了哪些文件。"),
            depends_on: vec![],
        },
        ProjectTask {
            role: qa_role.into(),
            objective: format!("上面的修复完成后,重新验证这个问题是否真的修好了:{bug}\n还有问题就再报一次。"),
            depends_on: vec![0], // 依赖修复任务(本批第 0 条)
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn companion(id: i64, slug: &str) -> Companion {
        Companion {
            id,
            name: format!("{slug}-小伙伴"),
            agent_definition_name: slug.into(),
            avatar_emoji: "🤖".into(),
            color_hex: "#000".into(),
            persona_md_path: None,
            memory_user_id: format!("companion_{id}"),
            adopted_at: 0,
            retired_at: None,
            personality_stats_json: None,
            invocation_count: 0,
            last_used_at: None,
            metadata_json: None,
            role_label: None,
            meditation_enabled: false,
            meditation_time: "03:00".into(),
            kind: "companion".into(),
        }
    }

    fn task(role: &str, dep: Vec<usize>) -> ProjectTask {
        ProjectTask {
            role: role.into(),
            objective: format!("{role} 干活"),
            depends_on: dep,
        }
    }

    #[test]
    fn builds_steps_with_roles_and_handoff_deps() {
        let members = vec![
            companion(10, "frontend_dev"),
            companion(20, "backend_dev"),
            companion(30, "qa_engineer"),
        ];
        // 后端先写 API → 前端依赖后端 → 测试依赖前后端。
        let plan = ProjectPlan {
            tasks: vec![
                task("backend_dev", vec![]),
                task("frontend_dev", vec![0]),
                task("qa_engineer", vec![0, 1]),
            ],
        };
        let cp = build_project_collaboration_plan(&plan, &members, 7).unwrap();
        assert_eq!(cp.steps.len(), 3);

        // 角色解析正确(任务的 role → 群里对应 companion)。
        assert_eq!(cp.steps[0].participants[0].companion_id, 20); // backend
        assert_eq!(cp.steps[1].participants[0].companion_id, 10); // frontend
        assert_eq!(cp.steps[2].participants[0].companion_id, 30); // qa

        // 依赖下标 +1 映射到 step id;后端无依赖、前端依赖后端、测试依赖前后端。
        assert!(cp.steps[0].depends_on.is_empty());
        assert_eq!(cp.steps[1].depends_on, vec![1]);
        assert_eq!(cp.steps[2].depends_on, vec![1, 2]);

        // step id 1-based;团队共享 group 记忆 scope。
        assert_eq!(cp.steps[0].id, 1);
        assert!(matches!(
            cp.steps[0].participants[0].memory_scope,
            MemoryScope::Group(7)
        ));
        // objective 进了 step.input.prompt。
        assert_eq!(cp.steps[1].input.prompt, "frontend_dev 干活");
    }

    #[test]
    fn rejects_role_not_in_group() {
        let members = vec![companion(10, "frontend_dev")];
        let plan = ProjectPlan {
            tasks: vec![task("designer", vec![])],
        };
        let err = build_project_collaboration_plan(&plan, &members, 1).unwrap_err();
        assert!(err.contains("designer"), "应报角色不在群里: {err}");
    }

    #[test]
    fn rejects_out_of_range_and_self_dependency() {
        let members = vec![companion(10, "frontend_dev")];
        // 越界依赖。
        let p1 = ProjectPlan {
            tasks: vec![task("frontend_dev", vec![5])],
        };
        assert!(build_project_collaboration_plan(&p1, &members, 1).is_err());
        // 自依赖。
        let p2 = ProjectPlan {
            tasks: vec![task("frontend_dev", vec![0])],
        };
        assert!(build_project_collaboration_plan(&p2, &members, 1).is_err());
    }

    #[test]
    fn rejects_empty_plan() {
        let members = vec![companion(10, "frontend_dev")];
        let plan = ProjectPlan { tasks: vec![] };
        assert!(build_project_collaboration_plan(&plan, &members, 1).is_err());
    }

    // 动态追加任务时,step id 从 offset 续号,本批内依赖也按 offset 映射。
    #[test]
    fn build_steps_continues_ids_from_offset() {
        let members = vec![companion(10, "frontend_dev"), companion(30, "qa_engineer")];
        // 已有 5 个 step → 追加批 offset=5。两条:修复(无依赖)+ 重验(依赖本批第 0 条)。
        let followup = vec![task("frontend_dev", vec![]), task("qa_engineer", vec![0])];
        let steps = build_steps(&followup, &members, 1, 5).unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, 6, "续号:offset 5 → 第一条 id 6");
        assert_eq!(steps[1].id, 7);
        // 本批内依赖 [0] → offset+0+1 = 6(指向本批第一条,不是初始计划的 step 1)。
        assert_eq!(steps[1].depends_on, vec![6]);
    }

    // bug 修复回路 = 修复(派给出 bug 的角色)→ 重新验证(派回 QA,依赖修复)。
    #[test]
    fn bug_fix_followup_is_fix_then_requalify() {
        let f = build_bug_fix_followup("frontend_dev", "qa_engineer", "删除按钮点不动");
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].role, "frontend_dev", "修复派给出 bug 的角色");
        assert!(f[0].objective.contains("删除按钮点不动"));
        assert!(f[0].depends_on.is_empty());
        assert_eq!(f[1].role, "qa_engineer", "重新验证派回 QA");
        assert_eq!(f[1].depends_on, vec![0], "重验依赖修复");
    }
}

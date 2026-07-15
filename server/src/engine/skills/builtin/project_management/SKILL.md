---
name: project_management
description: 管理项目入口。用于查看问数项目/工作区列表和详情、创建问数项目、把当前会话迁移到已有问数项目,不用于导入数据或回答数据问题。
category: project
runtime: prompt
side_effect: write
allow_implicit_invocation: false
default_enabled: true
global: true
tags:
  - builtin
  - project
  - workspace
  - session
allowed_tools:
  - update_plan
  - project_list
  - project_detail
  - create_smart_qa_project
  - project_create
  - project_session_move
---

# 目标

处理项目入口和会话归属。只做项目和会话层面的操作,不要导入文件、连接数据库或回答数据问题。

# 工作流

1. 判断用户要做的是产品项目/会话管理,还是本地目录操作、数据导入或问数查询。本地目录操作使用普通文件工具;数据导入必须进入问数项目后使用 data_onboarding,问数查询调用 query_project_data。
2. project_list 和 project_detail 是只读基础能力。用户要求查看项目/工作区列表、其他工作区、项目详情或选择已有项目时,可以直接调用。
3. 用户本轮文本明确说要“创建/新建/重建/转成/升级为智能问数项目或工作区”时,调用 create_smart_qa_project。不要因为创建请求先 project_list,也不要迁移到已有项目。
4. 只有用户本轮文本明确要求把“当前会话/对话/聊天”迁移、移动或转到已有、现有、指定或具名问数项目/工作区时,才能在查找目标项目后调用 project_session_move。
5. 如果能唯一确定目标项目,调用 project_session_move。成功后直接说明当前会话已进入目标项目。
6. 如果有多个候选项目或没有匹配项目,说明匹配结果并请用户确认目标项目名,不要猜。
7. project_create 只是兼容旧名。创建新的智能问数项目时优先调用 create_smart_qa_project。

# 交互规则

- 不要回答“我无法迁移”或建议用户手动切换;已有会话迁移应通过 project_session_move 完成。
- 用户在任意工作区都可以查看自己有权限的其他项目/工作区。不要把 project_list 或 project_detail 误当成迁移前置条件。
- 没有明确迁移命令时,绝不能调用 project_session_move。普通文件分析、发票金额统计、导入数据、读取目录、确认卡都不是迁移命令。
- “把当前会话转成智能问数项目/工作区”是创建新项目,不是迁移到已有项目;应调用 create_smart_qa_project。
- “把当前会话转到智能问数工作区”如果没有已有项目名或“已有/指定/现有”这类词,也按创建新项目处理,不要 project_list。
- 不要把确认卡当作用户主动要求创建项目的证据。确认卡只确认执行已经明确提出的动作。
- 不要把“创建文件夹、打开目录、列出目录、整理本地文件”当成产品项目创建;这些应使用 ls/find/read/write/bash/open 等普通工作区能力。
- 不要把“导入数据”当成已经完成。创建或迁移到问数项目后,只说明已经进入项目,再提示用户在问数项目中继续导入。
- 不要导入文件、解析文档、读取数据内容或生成统计结果;这些不是本 Skill 的职责。
- 缺少目标项目名、目标项目不唯一或当前会话 ID 不可用时,说明缺少什么信息并停止。

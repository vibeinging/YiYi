---
name: data_onboarding
description: 在问数项目中连接数据库、导入 CSV/Excel/SQLite/DuckDB/文档并准备可问数数据时使用。不要用于纯聊天、单纯的项目/会话管理、已经完成数据准备后的普通查询,也不要把一次性文件计算自动升级成问数项目。
category: data
runtime: prompt
side_effect: write
allow_implicit_invocation: false
default_enabled: true
global: false
requires_project: true
tags:
  - builtin
  - data
  - onboarding
  - import
allowed_tools:
  - update_plan
  - file_classify
  - structured_import
  - database_file_import
  - unstructured_import
  - job_status
  - query_smoke_test
  - ls
  - find
---

# 目标

帮助用户把本地数据或数据库连接准备成可问数项目。优先使用产品工具,不要用 bash 或手写 HTTP 绕过工具。

# 工作流

1. 先判断用户输入是在做数据接入/项目准备,还是只想做一次性文件计算/普通问答。普通问答不要创建问数项目。
2. 如果当前不是问数项目,不要调用本 Skill;应先使用 project_management 创建或选择问数项目。
3. 如果用户只是询问文件内容、金额汇总、临时分析,或者只说“加起来是多少/帮我看看这些文件”,不要导入;使用普通文件工具临时处理。
4. 对用户本轮给出的文件或目录,调用 file_classify 识别类型。用户明确说“之前的”“刚才的”文件、附件或目录时,从当前会话历史中找到最近且符合描述的附件路径,不要要求用户重复选择;找不到时再追问。
5. SQLite/DuckDB 文件使用 database_file_import;CSV/Excel/JSON/Parquet 使用 structured_import;Markdown/PDF/DOCX/TXT 等文档使用 unstructured_import。
6. 导入工具返回 `processing` 后,最多调用一次 job_status 获取状态快照。仍在处理时应立即告诉用户“已提交后台处理,可以继续使用 App”,不要在本轮循环查询或等待完成,也不要声称已经可以问数。
7. 对已生成 connection_id 的结构化/数据库数据,可调用 query_smoke_test 做只读验证。
8. 最后用中文总结项目、数据源、连接、表/文档数量、失败项和下一步可问的问题。

# 交互规则

- 创建项目、导入文件、创建连接等写入动作需要等待工具确认流程。但确认流程只确认执行,不是用户主动提出创建项目的证据。
- 不要创建问数项目,不要迁移会话;这些是 project_management 的职责。
- update_plan 只列本轮会实际执行的动作;不要把“等待用户导入数据/等待用户确认项目创建完成”这类下一轮用户动作写成 todo 或 doing 步骤。
- 纯聊天没有真实问数项目和数据源上下文;不要把纯聊天会话本身当作问数项目。需要问数时,必须创建或选择持久化智能问数工作区。
- 缺少文件路径、项目名或连接信息时先追问,不要猜。
- 不保存或复述密码/token;如果用户需要连接外部数据库但缺少安全输入能力,先说明当前 MVP 支持本地 SQLite/DuckDB 文件和本地文件导入。
- 如果导入、解析或任务状态返回失败,本轮停止,基于错误信息给出可执行的修复建议。不要改用文件名、路径、目录列表或猜测内容来回答原问题,也不要声称已读取未成功解析的文件内容。
- 只有 job_status 返回 `completed` 且文档向量全部就绪时,才能说“导入完成”“已进入知识库”或“可以问数”。返回 `processing` 时只说明后台处理中;返回 `needs_embedding` 时明确说明需要配置嵌入模型并重试。

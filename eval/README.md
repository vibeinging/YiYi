# yiw-eval —— app 内的 eval 框架(Node + CDP)

驱动**真 app**做端到端 / 准确率测试。默认页面路径通过 `driver.ui` 像真人一样操作 Electron 的 `/agent` 工作区；数据源、数据库、文档导入等准备动作走同一渲染层 IPC/API,不再打开旧 Web 管理页面。

后端结果读取仍经过渲染层的 `window.electronAPI` → ipc → registry,用于拿会话块、表 ID、文档状态等结构化评分数据,**不直连 HTTP**。与项目级 `eval/`(Python,打 HTTP)分叉:这套测的是用户实际跑的整条链路(真页面 + 真 ipc + 真引擎),能测 HTTP eval 测不到的东西(按钮状态、历史刷新、会话流式、app 路由边界等)。

任务文件只调用 `driver.ui` 和 driver 高层动作。`driver.raw` 保留在 driver 内部,只用于评分读取、同步兜底或当前没有页面入口的评测数据准备。

## 运行

```bash
# 自启一个 Electron 实例跑全部任务(测完自杀)。默认使用正常 app 本地库: ~/.yiw/local.db
node eval/run.mjs

# 连已在跑的 app(需带 --remote-debugging-port=9223)
CDP_PORT=9223 node eval/run.mjs

# 只跑某些任务(按 id 子串过滤)
CDP_PORT=9223 node eval/run.mjs nl2sql

# 只跑 Trace 与优化生成的 Benchmark task
CDP_PORT=9223 node eval/run.mjs trace-benchmark

# 需要隔离库时显式打开。适合 CI 或不想污染正常 app 侧边栏的长跑。
YIW_EVAL_ISOLATED=1 node eval/run.mjs kdd

# 指定固定隔离目录,方便复盘历史。
YIW_EVAL_HOME=~/.yiw/eval-runs/kdd node eval/run.mjs kdd
```

每次运行都会写一份 JSON 报告到 `eval/results/`。报告在每道任务结束后增量更新；如果 KDD 长跑中途失败,已完成任务的结果和列匹配汇总仍可复盘。

注意:默认模式会复用正常 app 数据库,因此 KDD 等长跑会在侧边栏创建 eval 项目和会话。需要完全隔离时使用 `YIW_EVAL_ISOLATED=1` 或 `YIW_EVAL_HOME=...`。

零依赖(Node v18+ 自带 fetch、v22+ 自带 WebSocket)。

## 结构

```
eval/
├── run.mjs              # CLI:连/启 app → 登录 → 加载 tasks/ → 跑 → 报告
├── lib/
│   ├── cdp.mjs          # CDP 连接/自启 Electron,在真渲染层执行 JS
│   ├── driver.mjs       # 高层 app 动作:login / createProject / importTable / importDatabase / importUnstructured / askQuery
│   ├── ui-driver.mjs    # 页面交互:导航 / 点击 / 填写 / 文本等待 / 截图
│   └── runner.mjs       # 任务运行器 + 断言(assert.*) + 报告
└── tasks/*.task.mjs     # 任务定义
```

`Trace 与优化` 生成的 Benchmark task 不直接放进 `tasks/`，而是写到 `eval/generated/`：

- `generated/tasks/*.task.mjs`
- `generated/trace-benchmark/*.json`

默认全量 `node eval/run.mjs` 不加载 generated tasks，避免项目级草稿污染基线回归。使用 `node eval/run.mjs trace-benchmark`、具体 generated task id，或设置 `YIW_EVAL_INCLUDE_GENERATED=1` 时才会加载。

## 内置任务覆盖

- `smoke`：app 主界面、旧入口防回归。
- `app-model-config`：项目级模型配置创建、列表、更新、删除、测试连接响应。
- `app-structured-import`：CSV 结构化导入、DuckDB 连接、表/字段元数据、项目绑定。
- `app-database-import-offline`：SQLite 文件导入、schema 同步、示例值采样、表/列元数据维护、向量化端点。
- `app-unstructured-import`：Markdown 文档导入、后台解析、描述编辑、重新处理、删除。
- `app-project-settings-dashboard`：项目详情、工作区、成员/角色、Dashboard、Panel、报告模板校验/预览/CRUD。
- `app-integrations`：IM connector CRUD,飞书、企业微信应用、企业微信智能机器人 worker supervisor 启停/状态/心跳/停止。
- `im-gateway-core`：统一 IM Gateway connector、pairing、workspace/session 解析、命令、幂等、群聊隔离策略、飞书/企微 raw adapter 标准化。
- `im-gateway-agent-runner`：IM 远程消息复用 app agent runner,验证模型输出进入 IM 出站内容和 app session。
- `skill-runtime`：Skill CRUD、按需加载和工具白名单。
- `mcp-provider-runtime`：MCP Provider 连接测试、创建、重新发现和 agent 工具投影。
- `trace-multiturn-flow`：从 functional 多轮对话抽前 5 问，验证 Trace DB 对每轮用户问题、root span、工具子流程、流程日志和 attrs 的记录完整性。
- `nl2sql-*` / `kdd-*` / `func-*`：问数准确率与功能数据集。

## 写一个任务

```js
// tasks/20-chart-pie.task.mjs
export default {
  id: 'chart-pie',
  desc: '问占比 → 应出饼图',
  async run({ driver, assert, writeFixture }) {
    const fx = writeFixture('sales.csv', 'region,amount\nEast,100\nWest,200\n');
    const pid = await driver.createProject('t-' + Date.now());
    const { connId, table } = await driver.importTable(pid, fx);   // 导入(后端自动绑项目)
    const r = await driver.askQuery(pid, connId, `各 region 的 amount 占比`);
    assert.ok(r.blocks.length > 0, '有输出');
    assert.blockType(r.blocks, 'chart', '产出图表块');
    assert.contains(r.blocks, 'pie', '是饼图');
  },
};
```

## 像真人一样操作页面

`driver.ui` 走 CDP 的鼠标和键盘事件,适合测试 app 主界面、弹窗、表单填写、按钮点击、历史列表刷新等 UI 行为。app 不注册旧 Web 管理页面,任务不要依赖 `/projects`、`/database`、`/project/:id/settings` 等地址。

```js
export default {
  id: 'ui-agent-ready',
  desc: 'app 主界面可用',
  async run({ driver, assert }) {
    await driver.login();
    await driver.ensureProject('ui-eval');
    await driver.ui.goto('/agent');
    await driver.ui.waitFor('[data-testid="agent-message-input"]', { timeout: 10000 });
    assert.eq(await driver.ui.exists('#Sidebar'), false, '不显示旧侧边栏');
  },
};
```

常用动作:

- `driver.ui.goto(path)` —— 用浏览器级导航打开真实页面。
- `driver.ui.click(selector)` / `driver.ui.clickText(text)` —— 鼠标移动到元素中心并点击。
- `driver.ui.clickByTestId(testId)` —— 按页面稳定测试标记点击。
- `driver.ui.fill(selector, value)` / `driver.ui.fillByPlaceholder(placeholder, value)` —— 聚焦、全选、清空、键盘输入。
- `driver.ui.fillByTestId(testId, value)` —— 按测试标记填写输入框。
- `driver.ui.setFiles(selector, files)` —— 给 `<input type="file">` 设置文件并触发 `input/change`,例如 `driver.ui.setFiles('input[type=file]', ['/abs/data.csv'])`。
- `driver.ui.setFilesByTestId(testId, files)` —— 对测试标记下的文件输入框选择本地文件。
- `driver.ui.press('Enter')` / `driver.ui.press('Meta+A')` —— 键盘快捷键。
- `driver.ui.waitFor(selector)` / `driver.ui.waitForText(text)` / `driver.ui.waitForUrl(pattern)` —— 等元素、文本或 URL。
- `driver.ui.text(selector)` / `driver.ui.exists(selector)` —— 读取页面状态。
- `driver.ui.screenshot()` —— 返回 PNG base64,用于失败留证。

## 断言

- `assert.ok(cond, msg)` / `assert.eq(a, b, msg)` / `assert.status(resp, code, msg)`
- `assert.contains(blocks, sub, msg)` —— 终态块文本含某串(比 gold)
- `assert.hasSql(blocks, msg)` —— 产出了 SQL
- `assert.blockType(blocks, type, msg)` —— 有某类型块(sql/table/chart/markdown…)
- `assert.columnsMatch(predCols, goldCols, msg, opts)` —— KDD 列签名判分。默认 `passMetric: 'recall'`,即 gold 列全覆盖算 task pass；报告会额外输出官方连续 `score = recall - λ * extra_cols / pred_cols` 的平均分、平均 recall、gold 覆盖率和满分率。

KDD 口径:

- 官方 leaderboard 看所有 task 的平均连续 `score`。
- 本地回归 pass/fail 默认看 `recall == 1.0`,用于回答“答案是否覆盖 gold”。
- `score == 1.0` 表示既覆盖 gold,又没有多余列；这不是唯一有用的准确率口径。
- KDD 任务如果在导入/问数阶段失败、没有进入列判分,报告汇总按 `score=0`、`recall=0` 计入。
- KDD 问题默认会追加输出约束:最终答案必须用 Markdown 表格展示,且只保留题目要求的答案列。这不改变判分规则,只是让 agent 输出更接近官方 `prediction.csv` 需要的结构。

## driver 高层动作

- `login()` —— 本地自动鉴权,强制使用内置默认用户 token,避免历史孤儿用户 token 影响数据归属
- `createProject(name) -> pid` —— 通过 app 后端能力创建项目,并把前端上下文切到该项目
- `ensureProject(name) -> pid` —— 选择或创建同名 eval 项目;只清理旧数据源绑定,保留历史会话
- `ensureProjectRecord(name) -> pid` —— 只准备项目记录,不导航页面;适合模型、集成、看板、报告等配置型 eval
- `importTable(pid, fixturePath) -> { dsid, connId, table }` —— 通过结构化文档 API 登记本地文件并处理;后端 `process` 自动绑定项目,导入即可问数
- `importDatabase(pid, dbPath) -> { connId, tables }` —— 通过数据库 API 登记 SQLite/DuckDB 本地文件、创建连接并同步 schema
- `importUnstructured(pid, files) -> { dsid }` —— 通过非结构化文档 API 登记本地文件并提交后台处理
- `askQuery(pid, connId, question) -> { sid, blocks, raw }` —— 保持 app 停在 `/agent`,通过渲染层 ipc 调用问数流接口并读取终态块;旧 `/session` 页面路由已移除
- `askAgent(pid, message) -> { sid, blocks, raw }` —— yiw 通用 agent
- `ui` —— 页面交互 driver,用于点击、填写、等待和截图
- `raw.api(method, url, body)` / `raw.streamBlocks(url, body)` / `raw.ev(expr)` —— 底层逃生舱。任务文件不要直接使用;默认只用于读取评分数据、同步兜底或尚无页面入口的低层能力。

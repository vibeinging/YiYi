# YiW 项目查看报告

日期：2026-07-15

## 结论

这是一个名为“YiW”的本地 AI 数据分析桌面应用。项目主体已经比较完整，包含桌面外壳、React 界面、本地 Node 后端、数据分析 Agent、数据源管理、Trace 与优化、以及真 App 评测框架。

前端当前状态较好：TypeScript 检查通过，前端 36 个单元测试全部通过。后端原本因为 x86_64 原生依赖无法加载，现已在当前 arm64 环境完成修复，并通过真实启动和健康检查。

项目根目录当前不是 Git 仓库，因此无法查看分支、提交历史和未提交改动。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `electron/` | Electron 主进程、预加载脚本、窗口和本地系统能力 |
| `renderer/` | React 18 + TypeScript + Vite 前端 |
| `server/` | Express/IPC 共用的本地 Node 后端和 Agent/数据引擎 |
| `eval/` | 通过 CDP 操作真实 Electron 应用的端到端和准确率评测 |
| `scripts/` | 本地开发启动脚本 |
| `release/` | 桌面发布产物目录；旧品牌产物已删除，等待重新打包 |

项目总占用约 1.8 GB，其中 `renderer/` 约 818 MB、`server/` 约 667 MB、`electron/` 约 306 MB、`eval/` 约 4.1 MB，`release/` 当前为空。大部分空间来自依赖和构建结果。

## 启动和通信链路

开发入口是根目录的 `npm run dev`：

1. Vite 启动 React 页面。
2. Electron 打开开发页面。
3. Electron 主进程启动 `server/src/index.js` 子进程。
4. 前端通过 `window.electronAPI` 调用 Electron IPC。
5. Electron 再通过子进程消息通道调用后端能力。

生产环境主要走进程消息通道，不需要开放本地 HTTP 端口。开发环境的前端默认使用 `57131`，开发和评测后端默认使用 `57138`；两个端口都可以通过环境变量覆盖。

应用默认页面是 `/agent`。对外路由已经收窄，主要保留主工作台、分享页、错误页和工作流编辑器；其他设置和数据管理功能大多在工作台内部打开。

## 主要能力

- 本地聊天和项目工作区
- CSV、Excel、SQLite、DuckDB 和常见数据库连接
- 结构化与非结构化文档导入
- 自然语言问数、SQL 生成和结果图表
- 模型配置、Skill、MCP Provider 和工作流
- Dashboard、报告模板和项目成员管理
- 飞书、企业微信等集成
- Trace 记录、问题分析、优化草稿和 Benchmark
- 后台文档处理、向量任务续跑和元数据定时同步

## 本次检查结果

### 通过

- `npm run typecheck`：通过。
- `npm run test:renderer`：7 个测试文件、36 个测试全部通过；命令会自动使用本机架构的 Node。
- Electron 本体是 arm64。

### 已完成：产品统一改名为 YiW

项目自有代码、配置、界面文字和构建配置已统一使用新名称：

- 对外产品名统一为 `YiW`。
- 内部小写标识统一为 `yiw`，包名改为 `yiw-desktop`、`yiw-electron`、`yiw-renderer` 和 `@yiw/server`。
- 环境变量前缀统一为 `YIW_`。
- 本地数据目录改为 `~/.yiw`，本地文件协议改为 `yiw-file`。
- 相关组件、样式和 API 文件名已改为 `YiW*` 或 `yiw*`。
- 应用图标、导航 Logo、favicon、macOS ICNS、Windows ICO 和商店尺寸图标已统一为 YiW“多工作台”标记：藏红花黄底、墨绿工作区、暖白活动区，不使用字母、紫色或渐变。
- 应用配色已统一为暖黄、深绿、暖白体系；默认主题改为 `yiw-warm`，Element Plus、Mantine、YiW 工作台和旧页面中的紫色及紫色渐变均已清理。详细规则见 `docs/design/2026-07-15_yiw-color-system.md`。
- 删除了三份未使用的旧品牌图片，避免旧视觉继续进入构建产物。
- 开发前端端口统一为 `57131`，开发和评测后端端口统一为 `57138`，Electron、Vite、代理、评测和测试配置已同步。
- 删除了带旧产品名的约 1.4 GB macOS 发布目录和 zip，避免旧界面、旧源码继续留在发布产物中。新发布包需要基于当前代码重新打包。

旧名称没有保留兼容入口，因此旧目录中的用户数据不会被新版本自动读取或迁移。

### 已修复：ARM 原生依赖

根因不是业务代码，而是机器上同时存在 ARM 和 Intel 两套 Node 工具链，`server/node_modules` 也是旧的 Intel 安装结果：

- 当前终端使用 `/opt/homebrew/bin/node`，为 arm64 Node.js 26。
- 旧 `better_sqlite3.node` 是 x86_64，且生成时间早于当前项目目录。
- 第一次直接重建时，npm 安装脚本又串到了 `/usr/local/bin/node` 的 x86_64 Node.js 22 和 Python 3.6。
- `server/package.json` 还明确依赖了 `@duckdb/node-bindings-darwin-x64`，导致修好 SQLite 后 DuckDB 仍无法加载。

处理结果：

- 使用明确的 ARM Node、Python 和编译环境重建 `better-sqlite3`。
- 移除写死的 DuckDB x86_64 直接依赖，让 `@duckdb/node-bindings` 自动选择当前平台包。
- 移除前端写死的 `@rollup/rollup-darwin-x64` 直接依赖，让 Rollup 自动选择当前平台包；前端 ARM 安装不再报 `EBADPLATFORM`。
- 根启动和构建命令会按机器架构选择配套 Node/npm，避免 ARM Mac 的终端误用 Intel Node 后又寻找 x64 Rollup。
- 重新安装后，SQLite 和 DuckDB 原生文件均为 arm64。
- `npm --prefix server run check:capabilities` 通过，能力覆盖为 `317/325（97.54%）`。
- 真实启动后端并访问 `/api/health`，返回 HTTP 200 和 `{ "ok": true }`。

### 剩余测试失败已修复

原来的 26 个测试失败已经全部处理：

- 将测试中的 `app/server/...`、`app/eval/...` 更新为当前真实目录。
- 补齐 32 轮对话的 `task.json` 和 `trade_dist.sqlite` 测试夹具。
- 修正三个多轮评测任务在目录迁移后仍指向旧位置的问题。
- `data_onboarding` 和 `project_management` 都涉及写入动作，且说明要求用户明确提出，因此改为 `allow_implicit_invocation: false`，避免模型仅凭索引自动启用。
- 更新 Skill 选择测试，明确区分“允许自动选择的 prompt Skill”“只能明确路由激活的 prompt Skill”和“service Skill”。
- 更新导航按钮测试，使其接受真实的 `showNavEdgeToggle` 显示条件，同时继续保证按钮不只在导航收起时存在。
- 将评测文档和 `eval/run.mjs` 示例中的 `app/eval` 更新为 `eval`。

最终验证：

- `node --test eval/tests/*.test.mjs`：131/131 通过，无失败、无跳过。
- `npm run test:renderer`：36/36 通过。
- `npm run typecheck`：通过。
- `npm run build:renderer`：生产构建通过。
- `npm --prefix server run check:capabilities`：通过，能力覆盖 `317/325（97.54%）`。
- 后端真实启动后，`/api/health` 返回 HTTP 200 和 `{ "ok": true }`。
- 新端口实测：前端 `57131` 返回 HTTP 200，后端 `57138` 健康接口返回 HTTP 200。
- `better-sqlite3`、DuckDB 和 Rollup 的本机原生文件均确认为 arm64。
- 对项目自有源码、构建产物、配置、锁文件和文件名做旧品牌扫描，结果为 0。

当前仍有一个工程管理问题：根目录缺少总 README，也没有统一的后端测试脚本和桌面打包脚本。从根 `package.json` 看不到完整、可重复的打包入口。

## 最近评测情况

- 2026-07-14 最近三次 `query-agent-service-smoke` 都通过。
- 历史 32 轮智能问数报告实际路由和答案均为 32/32，但旧测试写死期望 30 轮，因此当时被记为失败。当前测试已改为跟随夹具中的问题数量并通过；本次没有重新执行需要真实模型的 32 轮长跑。
- 2026-07-14 的 KDD 51 题合并结果为 25 题通过、26 题失败，通过率约 49.0%，平均官方分约 0.498；其中 11 题是报错或没有分数，15 题是答案列不匹配。

这些是已有评测报告。当前 arm64 后端已经可以启动，但完整评测仍依赖模型配置和对应测试数据。

## 建议处理顺序

1. 增加根 README。
2. 在根 `package.json` 增加统一的后端测试和全量检查命令。
3. 补充可重复的桌面打包命令。

## 本次未做的操作

已修复 `server` 的 ARM 原生依赖、测试路径、Skill 自动选择规则和多轮评测夹具。没有执行 Git 提交或推送。

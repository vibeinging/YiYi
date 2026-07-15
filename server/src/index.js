// 智能问数 桌面后端 —— bootstrap + 传输层启动(去 Express 重构后)。
//
//   app 路径   :渲染层 → ipc → 主进程 process.send → transport/ipc_server(registry 用例),零 express。
//   eval/CI 路径:独立启动 或 YIW_TCP=1 → transport/http_server(薄 express,跑同一 registry)。
//
//   业务逻辑全在 app/<域>/*.js(L1 用例,async fn(ctx,input)->data | throw ApiError);
//   传输/鉴权/信封/路由在 transport/;engine/(L2)+ db.js 不变。
import "./config/network.js";
import { query, queryOne } from "./db.js";
import { closeYiTraceDb, warmupYiTraceDb } from "./app/traces/yitrace_service.js";
import { registerDbModelConfigProvider } from "./engine/core/model_config_provider.js";

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await closeYiTraceDb();
  } finally {
    process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 0);
  }
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("disconnect", () => { void shutdown("disconnect"); });

// ── 注册模型配置 provider(供引擎各处 chat/embed 解析 LLM/embedding 模型)——启动时一次 ──
// 使非 chat 的流程(schema 同步、指标/文档 embed)也能解析模型。Vastbase/SQLite 空串当 NULL:api_key 用 IS NOT NULL。
registerDbModelConfigProvider({ queryOne });

// yiTrace DB 在 worker 子进程里持有。启动时预热一次，避免第一次打开 Trace 面板才触发 open/recovery。
if (process.env.YIW_TRACE_STARTUP_WARMUP !== "0") {
  setTimeout(() => warmupYiTraceDb(), 0);
}

// ── 轻量迁移:补 api_format 列(老库无此列)。重复执行无害 ──
(async () => {
  try {
    await query(`ALTER TABLE llm_models ADD COLUMN api_format TEXT DEFAULT 'chat_completions'`);
    console.info("[migrate] llm_models.api_format 列已补齐");
  } catch (e) {
    if (!String(e?.message || e).toLowerCase().includes("duplicate column")) {
      console.warn("[migrate] api_format 列迁移跳过:", e?.message || e);
    }
  }
})();

const PORT = Number(process.env.SERVER_PORT || 57138);

// ── app 路径:被 Electron 主进程以 ipc 通道 fork(process.send 可用)→ 进程消息派发到 registry 用例 ──
// app 内实例零 HTTP/端口/express;仅当独立启动 或 YIW_TCP=1 时下方再起 TCP(给 eval/CI)。
if (typeof process.send === "function") {
  import("./transport/ipc_server.js").then(({ handleIpcMessage, abortIpcStream }) => {
    process.on("message", (msg) => {
      if (!msg || msg.id == null) return;
      if (msg.type === "abort") { abortIpcStream(msg.id); return; }
      handleIpcMessage(msg, (m) => { try { process.send(m); } catch { /* main 退出 */ } });
    });
    console.log("🟢 desktop server (node) ready on process IPC channel (registry, express-free app path)");
  });
}

// ── eval/CI 路径:独立启动(无 ipc 通道)或 YIW_TCP=1 → 薄 express 跑同一 registry,监听 TCP ──
if (typeof process.send !== "function" || process.env.YIW_TCP === "1") {
  import("./transport/http_server.js").then(({ startHttpServer }) => startHttpServer(PORT));
}

// 文档解析和向量生成是离线任务，App 重启后继续执行；问数任务没有启动续跑入口。
import("./engine/datasources/unstructured/document_processing_service.js")
  .then(({ resumePendingDocuments }) => resumePendingDocuments())
  .catch((e) => console.warn("[startup] 文档续跑失败:", e?.message || e));
import("./app/datasource/tables.js")
  .then(({ resumeInterruptedVectorJobs }) => resumeInterruptedVectorJobs({ query, queryOne, userId: null }))
  .then((count) => { if (count) console.info(`[startup] 续跑 ${count} 个 schema 向量任务`); })
  .catch((e) => console.warn("[startup] schema 向量续跑失败:", e?.message || e));

// ── 元数据自动同步调度── 每分钟检查启用的数据库同步策略。
import("./app/datasource/sync_settings.js")
  .then(({ startMetadataSyncScheduler }) => startMetadataSyncScheduler())
  .catch((e) => console.warn("[startup] 元数据同步调度启动失败:", e?.message || e));

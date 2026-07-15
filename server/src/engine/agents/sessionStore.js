/**
 * agent 会话转写存储 —— JSONL 追加式(对齐本地运行时 SessionManager 形态)。
 *
 * - 每会话一份 JSONL:~/.yiw/agent-sessions/<sessionId>.jsonl
 *   首行 = session header,之后每行一个 entry。当前 entry 类型:{ type:"message", message:<AgentMessage> }。
 * - 存的是运行时的**原始 AgentMessage**(含 user/assistant/toolCall/toolResult/thinking,无损)。
 * - **追加为主**:每轮(turn_end)把新产生的消息 append 进去 → 崩溃只丢进行中的那一轮。
 * - **compaction 检查点**:整份重写为 header + 压缩后的消息(摘要 user 消息 + 近期消息)。
 * - SQL 的 session_messages 仍服务「会话列表 / 标题 / GUI 渲染」;此处仅服务 LLM 上下文。
 *
 * 与底层运行时的差异:底层是逐事件 append + parentId 树(支持分支 fork);这里逐轮 append、线性(无分支)。
 * 分支需要前端会话树 UI,另作。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const DIR = join(homedir(), ".yiw", "agent-sessions");
const VERSION = 1;

function ensureDir() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function fileFor(sessionId) {
  const safe = String(sessionId || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
  return join(DIR, `${safe}.jsonl`);
}

function headerLine(sessionId) {
  return JSON.stringify({ type: "session", version: VERSION, id: String(sessionId) }) + "\n";
}

/** 读取某会话的原始转写(所有 message entry,按序)。无文件 → null(调用方据此回退到 SQL 重建)。 */
export function loadTranscript(sessionId) {
  if (!sessionId) return null;
  try {
    const f = fileFor(sessionId);
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").split("\n");
    const msgs = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let e;
      try {
        e = JSON.parse(s);
      } catch {
        continue; // 跳过损坏行(崩溃可能留下半行)
      }
      if (e && e.type === "message" && e.message) msgs.push(e.message);
    }
    return msgs;
  } catch {
    return null;
  }
}

/** 追加若干消息(append-only)。文件不存在则先写 header。 */
export function appendMessages(sessionId, messages) {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) return;
  try {
    ensureDir();
    const f = fileFor(sessionId);
    let out = existsSync(f) ? "" : headerLine(sessionId);
    for (const m of messages) out += JSON.stringify({ type: "message", message: m }) + "\n";
    appendFileSync(f, out);
  } catch {
    /* 落盘失败不阻断本轮 */
  }
}

/** 整份重写(compaction 检查点 / 老会话引导):header + message entries。 */
export function rewriteTranscript(sessionId, messages) {
  if (!sessionId || !Array.isArray(messages)) return;
  try {
    ensureDir();
    let out = headerLine(sessionId);
    for (const m of messages) out += JSON.stringify({ type: "message", message: m }) + "\n";
    writeFileSync(fileFor(sessionId), out);
  } catch {
    /* ignore */
  }
}

export function replaceToolResultText(sessionId, toolCallId, text, details = {}) {
  const messages = loadTranscript(sessionId);
  if (!Array.isArray(messages) || !toolCallId) return false;
  let changed = false;
  const next = messages.map((message) => {
    if (message?.role !== "toolResult" || message.toolCallId !== toolCallId) return message;
    changed = true;
    return {
      ...message,
      content: [{ type: "text", text: String(text || "") }],
      details: { ...(message.details || {}), ...details },
      isError: false,
      timestamp: Date.now(),
    };
  });
  if (!changed) return false;
  rewriteTranscript(sessionId, next);
  return true;
}

/**
 * 体量预算裁剪(喂给 LLM 前的兜底,不改文件):总体量超 maxChars 时只在 user 边界切窗,
 * 保证窗口要么为空、要么以 user 起头(不悬空 toolResult)。compaction 是主力,这是保险丝。
 */
export function trimToBudget(messages, maxChars = 200000) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];
  // 单遍:各消息体量算一次 → 反向前缀和。窗口只在 user 边界切,保证以 user 起头(不悬空 toolResult)。
  const sz = new Array(messages.length);
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    try {
      sz[i] = JSON.stringify(messages[i]).length;
    } catch {
      sz[i] = 0;
    }
    total += sz[i];
  }
  if (total <= maxChars) return messages;

  // 从尾部累加,记录「从此处到末尾」体量;遇到 user 且窗口仍在预算内 → 记为可行起点(取最早可行)。
  let suffix = 0;
  let bestUser = -1; // 能放进预算的最早 user 起点
  let recentUser = -1; // 最近(最大下标)的 user —— 兜底:都放不下时取最小窗口
  for (let i = messages.length - 1; i >= 0; i--) {
    suffix += sz[i];
    if (messages[i]?.role === "user") {
      if (recentUser === -1) recentUser = i; // 反向扫描首个命中 = 最大下标
      if (suffix <= maxChars) bestUser = i;
    }
  }
  if (bestUser >= 0) return messages.slice(bestUser);
  if (recentUser >= 0) return messages.slice(recentUser);
  return []; // 没有 user 边界 → 无法安全重放
}

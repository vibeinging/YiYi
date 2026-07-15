/**
 * 摘要式 compaction —— 复用本地运行时的 generateSummary(同款 prompt/质量)。
 *
 * 触发:上下文估算 token 超过 contextWindow - reserveTokens 时。
 * 动作:把「旧消息」交给模型摘成一段结构化 summary,替换为**一条 user 消息**(含摘要),
 *       再接上「近期消息」(约 keepRecentTokens)。摘要做成 user 消息而非运行时内部的
 *       compactionSummary 自定义角色 —— 因为本项目 Agent 用默认 convertToLlm(只放行
 *       user/assistant/toolResult,自定义角色会被丢弃)。
 * 迭代:旧摘要本身就是一条 user 消息,下次 compaction 会被一并纳入再摘要,天然合并。
 */
import {
  estimateTokens,
  shouldCompact,
  generateSummary,
  DEFAULT_COMPACTION_SETTINGS,
} from "../../../vendor/pi/coding-agent/dist/core/compaction/index.js";

// 手动 /compact 是用户显式要求“把更早轮次摘要掉”,不应复用自动压缩的 20k 近期窗口。
// 保留约最近 1200 tokens,足够承接当前追问,其余进入摘要。
export const MANUAL_COMPACTION_SETTINGS = {
  ...DEFAULT_COMPACTION_SETTINGS,
  keepRecentTokens: 1200,
};

// 从尾部往回累积(用预先算好的 per-message tokens),保留约 keepRecentTokens 的近期消息;
// 切点必须落在 user/assistant(不可落在 toolResult,否则丢了它的 toolCall 配对,破坏消息序列)。
function findCutIndex(messages, tokens, keepRecentTokens) {
  let acc = 0;
  let idx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += tokens[i];
    idx = i;
    if (acc >= keepRecentTokens) break;
  }
  while (idx > 0 && messages[idx]?.role === "toolResult") idx--;
  return idx;
}

/**
 * 超阈值则做摘要式压缩;未触发或失败 → 原样返回。
 * @returns {Promise<{messages: any[], compacted: boolean, tokensBefore?: number, reason?: string, error?: string}>}
 */
export async function compactIfNeeded(messages, { model, apiKey, streamFn, contextWindow, settings = DEFAULT_COMPACTION_SETTINGS, force = false } = {}) {
  if (!Array.isArray(messages) || messages.length < 4) {
    return { messages, compacted: false, reason: "too_short" };
  }

  // 各消息 token 估算一次,total 与切点共用,避免二次 tokenize。
  const tokens = messages.map((m) => estimateTokens(m));
  const total = tokens.reduce((a, b) => a + b, 0);
  const cw = contextWindow || model?.contextWindow || 128000;
  // force(手动 /compact)跳过阈值判断,直接压;否则按阈值自动触发。
  if (!force && !shouldCompact(total, cw, settings)) {
    return { messages, compacted: false, reason: "below_threshold", tokensBefore: total };
  }

  const cut = findCutIndex(messages, tokens, settings.keepRecentTokens);
  if (cut <= 0) {
    return { messages, compacted: false, reason: "no_older_messages", tokensBefore: total };
  }
  const toSummarize = messages.slice(0, cut);
  const kept = messages.slice(cut);
  if (!toSummarize.length) {
    return { messages, compacted: false, reason: "no_older_messages", tokensBefore: total };
  }

  let summary;
  try {
    summary = await generateSummary(
      toSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      undefined, // headers
      undefined, // signal
      undefined, // customInstructions
      undefined, // previousSummary(旧摘要已作为 user 消息在 toSummarize 内,自动合并)
      "off", // thinkingLevel
      streamFn,
      undefined, // env
    );
  } catch (e) {
    // 摘要失败不阻断本轮:交还原消息,由上层的预算裁剪兜底
    console.error("[compaction generateSummary]", e?.message || e);
    return { messages, compacted: false, reason: "summary_failed", error: e?.message || String(e), tokensBefore: total };
  }
  if (!summary || !summary.trim()) {
    return { messages, compacted: false, reason: "empty_summary", tokensBefore: total };
  }

  const summaryMsg = {
    role: "user",
    content: `[早前对话的摘要 / summary of earlier conversation]\n\n${summary}`,
    timestamp: 0,
  };
  return { messages: [summaryMsg, ...kept], compacted: true, tokensBefore: total };
}

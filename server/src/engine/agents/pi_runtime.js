import { registerBuiltInApiProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { normalizeTokenUsage } from "../core/token_usage.js";

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const MIN_CONTEXT_WINDOW = 32768;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_QUERY_MODEL_TIMEOUT_MS = 120_000;
export const DEFAULT_QUERY_MAX_MODEL_TURNS = 20;

const API_FORMAT_TO_PI_API = {
  anthropic: "anthropic-messages",
  chat_completions: "openai-completions",
  responses: "openai-responses",
};

let providersReady = false;

export function ensurePiProviders() {
  if (providersReady) return;
  try {
    registerBuiltInApiProviders();
  } catch {
    /* pi-ai registers builtins on import; repeated registration is harmless but keep this defensive. */
  }
  providersReady = true;
}

export function positiveInt(value, fallback = undefined) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function normalizePiUsageForTrace(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) return null;
  if (!normalized.total_tokens && !normalized.cached_tokens && !normalized.cache_write_tokens && !normalized.cost_usd) return null;
  return normalized;
}

export function assistantMessageTraceText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const out = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && part.text) out.push(String(part.text));
    else if (part.type === "thinking" && (part.thinking || part.text)) out.push(String(part.thinking || part.text));
    else if (part.type === "toolCall") {
      let args = "";
      try {
        args = JSON.stringify(part.arguments || {});
      } catch {
        args = String(part.arguments || "");
      }
      out.push(`tool_call ${part.name || ""} ${args}`.trim());
    }
  }
  return out.filter(Boolean).join("\n\n").trim() || (message?.stopReason ? `stopReason: ${message.stopReason}` : "");
}

export function resolvePiContextWindow(cfg, fallback = DEFAULT_CONTEXT_WINDOW) {
  const raw = cfg?.context_window ?? cfg?.contextWindow ?? cfg?.extra_config?.context_window ?? cfg?.extra_config?.contextWindow;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_CONTEXT_WINDOW ? Math.floor(n) : fallback;
}

export function resolvePiExtraConfig(cfg) {
  const raw = cfg?.extra_config ?? cfg?.extraConfig ?? {};
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function resolvePiApi(cfg) {
  const extra = resolvePiExtraConfig(cfg);
  const raw = String(cfg?.api_format ?? cfg?.apiFormat ?? extra.api_format ?? extra.apiFormat ?? "chat_completions");
  return API_FORMAT_TO_PI_API[raw] || API_FORMAT_TO_PI_API.chat_completions;
}

export function resolvePiProvider(cfg) {
  const extra = resolvePiExtraConfig(cfg);
  const raw = cfg?.provider ?? cfg?.provider_kind ?? cfg?.providerKind ?? extra.provider ?? extra.provider_kind ?? extra.providerKind;
  const provider = String(raw || "gateway").trim();
  if (provider && provider !== "gateway") return provider;
  const apiFormat = String(cfg?.api_format ?? cfg?.apiFormat ?? extra.api_format ?? extra.apiFormat ?? "chat_completions");
  if (apiFormat === "anthropic") return "anthropic";
  if (apiFormat === "responses") return "openai";
  return "gateway";
}

function objectFromJsonLike(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeHeaders(raw) {
  const obj = objectFromJsonLike(raw);
  const headers = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key || value == null) continue;
    headers[key] = String(value);
  }
  return headers;
}

function normalizeCacheRetention(raw) {
  const value = String(raw || "").trim();
  return ["none", "short", "long"].includes(value) ? value : undefined;
}

function isDashScopeOpenAIBaseUrl(baseUrl) {
  const url = String(baseUrl || "").toLowerCase();
  return url.includes("dashscope") || url.includes("maas.aliyuncs.com");
}

function resolvePiCompat(cfg, { api, baseUrl } = {}) {
  const extra = resolvePiExtraConfig(cfg);
  const explicitCompat = objectFromJsonLike(extra.compat);
  const dashScopeCompat = api === "openai-completions" && isDashScopeOpenAIBaseUrl(baseUrl)
    ? {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
        thinkingFormat: "qwen",
        cacheControlFormat: "anthropic",
        supportsLongCacheRetention: false,
      }
    : {};
  const compat = { ...dashScopeCompat, ...explicitCompat };
  return Object.keys(compat).length ? compat : undefined;
}

function setByPath(data, path, value) {
  const keys = String(path || "").split(".").filter(Boolean);
  if (!keys.length || !data || typeof data !== "object") return;
  let cursor = data;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function mergeJsonInto(data, raw) {
  if (!data || typeof data !== "object") return;
  Object.assign(data, objectFromJsonLike(raw));
}

function applyThinking(data, extra) {
  const thinking = extra?.thinking;
  if (thinking && typeof thinking === "object" && thinking.param) {
    setByPath(data, thinking.param, thinking.value !== undefined ? thinking.value : false);
    return;
  }
  const disabled = extra?.disable_thinking;
  if (disabled && typeof disabled === "object" && disabled.enabled) {
    mergeJsonInto(data, disabled.params);
  }
}

export function applyPiPayloadConfig(payload, cfg, model) {
  if (!payload || typeof payload !== "object") return payload;
  const extra = resolvePiExtraConfig(cfg);
  if (model?.api === "openai-completions") applyThinking(payload, extra);
  mergeJsonInto(payload, extra.extra_body);
  return payload;
}

export function buildPiModel(cfg, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const api = resolvePiApi(cfg);
  const extra = resolvePiExtraConfig(cfg);
  const headers = normalizeHeaders(extra.extra_headers);
  const baseUrl = cfg.api_base;
  const compat = resolvePiCompat(cfg, { api, baseUrl });
  return {
    id: cfg.model_name,
    name: cfg.model_name,
    api,
    provider: resolvePiProvider(cfg),
    baseUrl,
    ...(compat ? { compat } : {}),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolvePiContextWindow(cfg),
    maxTokens,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function createPiStreamFn({
  apiKey,
  extraConfig,
  timeoutMs,
  maxModelTurns,
  turnLimitMessage = (limit) => `模型轮数超过上限(${limit}),已停止以避免无限工具循环。`,
  baseStreamFn = streamSimple,
} = {}) {
  let modelTurnCount = 0;
  const resolvedExtraConfig = resolvePiExtraConfig({ extra_config: extraConfig });
  const cacheRetention = normalizeCacheRetention(
    resolvedExtraConfig.cache_retention
      ?? resolvedExtraConfig.cacheRetention,
  );
  return async (model, context, options) => {
    if (Number.isFinite(Number(maxModelTurns)) && Number(maxModelTurns) > 0) {
      modelTurnCount += 1;
      if (modelTurnCount > Number(maxModelTurns)) {
        throw new Error(typeof turnLimitMessage === "function" ? turnLimitMessage(maxModelTurns) : String(turnLimitMessage));
      }
    }
    const callerOnPayload = options?.onPayload;
    return baseStreamFn(model, context, {
      ...options,
      apiKey,
      ...(Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {}),
      ...(cacheRetention && !options?.cacheRetention ? { cacheRetention } : {}),
      onPayload: async (payload, currentModel) => {
        const configuredPayload = applyPiPayloadConfig(payload, { extra_config: resolvedExtraConfig }, currentModel);
        if (!callerOnPayload) return configuredPayload;
        const callerPayload = await callerOnPayload(configuredPayload, currentModel);
        return callerPayload === undefined ? configuredPayload : callerPayload;
      },
    });
  };
}

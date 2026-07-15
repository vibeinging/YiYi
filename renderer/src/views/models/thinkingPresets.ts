// 关闭推理模型「思考」的请求参数预设。
// 不同端点关思考的 key 不一样：vLLM 自托管 Qwen3 走 chat_template_kwargs.enable_thinking，
// 阿里云 DashScope 走顶层 enable_thinking；其它模型走「自定义」手填 JSON。
// 这段 params 会被后端 build_request_data 合并进请求 body（见 extra_config.disable_thinking）。

export const THINKING_PRESETS: Record<string, any> = {
  vllm_qwen: { chat_template_kwargs: { enable_thinking: false } },
  dashscope: { enable_thinking: false },
}

export const DEFAULT_THINKING_PRESET = 'vllm_qwen'

// 反推一段 params 命中哪个预设；不匹配任何预设则为 'custom'。
export function matchThinkingPreset(params: any): string {
  if (!params || typeof params !== 'object') return 'custom'
  const target = JSON.stringify(params)
  for (const [key, preset] of Object.entries(THINKING_PRESETS)) {
    if (JSON.stringify(preset) === target) return key
  }
  return 'custom'
}

// 由 preset + 自定义文本解析出最终要提交的 params（提交与预览共用）。
// preset 非 custom 用预设；custom 解析用户 JSON，非法则返回 null。
export function resolveThinkingParams(preset: string, customText: string): any {
  if (preset !== 'custom') return THINKING_PRESETS[preset] || null
  try {
    const parsed = JSON.parse(customText)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

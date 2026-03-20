# 模型原生工具对接策略：让 AI 能力无缝触达普通用户

> 状态：Draft
> 日期：2026-03-12
> 作者：产品团队

---

## 一、背景与动机

### 1.1 行业现状

国内主流模型厂商正在将越来越多的"工具能力"直接内置到模型中：

| 厂商 | 原生工具 |
|------|----------|
| **智谱 z.ai** | Web Search、Web Reader、Vision (GLM-4.6V)、OCR、图片生成 (GLM-Image)、语音转写 (ASR)、视频生成 (CogVideoX/Vidu)、PPT/海报 Agent |
| **DashScope (通义)** | Web Search、Vision、Code Interpreter，Coding Plan 代码套餐 |
| **Moonshot (Kimi)** | Web Search ($web_search)、Vision、文件解析 |
| **MiniMax** | Web Search、Vision、语音合成/识别 |

这些能力不再需要第三方 API 拼接，而是模型**原生支持**——只需在请求参数中声明即可自动触发。

### 1.2 YiYi 的机会

YiYi 作为多 Provider 桌面 AI 助手，天然具备接入所有厂商的基础设施。核心问题是：

> **如何让完全不懂 AI 的普通用户，通过一句自然语言，自动享受到各家模型最强的原生能力？**

用户不应该需要知道什么是 "tool calling"、"function call"、"MCP"。他们只需要说：
- "帮我搜一下最近 AI 的新闻"
- "看看这张发票上写了什么"
- "帮我画一张猫的图"
- "把这段录音整理成文字"

---

## 二、对接模式分析

### 2.1 三种对接模式

#### 模式 A：Tool-Native（原生工具透传）⭐ 主力模式

在 Chat Completion 的 `tools` 参数中直接启用厂商原生工具。模型自己决定何时调用。

```
用户输入 → ReAct Agent → 带 tools 配置调用 LLM → 模型自动决定搜索/看图/生成
```

**优势**：
- 零额外开发成本，模型对自己的工具理解最深
- 用户无感知，Agent 自动路由
- 效果最好（模型内部优化过）

**适用**：Web Search、Vision、OCR、图片生成、Code Interpreter

**技术要点**：
- 智谱 Web Search：在 `tools` 数组中加入 `{"type": "web_search", "web_search": {"enable": "True", "search_engine": "search-prime"}}`
- DashScope Web Search：通过 `extra_body` 注入 `enable_search: true`
- Moonshot Web Search：在 `tools` 数组中加入 `{"type": "builtin_function", "function": {"name": "$web_search"}}`
- 各家 Vision：在 message content 中使用 `image_url` 类型的 content part

#### 模式 B：MCP Server 对接（补充模式）

对接厂商提供的 MCP Server（如智谱的 Web Reader MCP、Web Search MCP）。YiYi 已有 `mcp_runtime.rs` 基础设施。

**优势**：
- 标准化协议，一次实现多处复用
- 可混合不同厂商的 MCP 能力
- 与现有 MCP 基础设施无缝整合

**适用**：Web Reader、知识库检索、需要多步交互的工具

#### 模式 C：Agent Delegation（代理委托）

将特定重型任务委托给专门的外部 Agent 执行。类似当前 Claude Code 的对接方式。

**适用**：PPT 生成、视频生成、代码执行等异步重型任务

### 2.2 模式选择决策树

```
该能力是否可以通过 tools 参数一步启用？
├── 是 → 模式 A（Tool-Native）
└── 否 → 是否有标准 MCP Server？
    ├── 是 → 模式 B（MCP Server）
    └── 否 → 模式 C（Agent Delegation）
```

---

## 三、技术方案

### 3.1 核心改动：Provider 能力声明系统

当前 `ProviderDefinition` 只有模型列表，需要扩展**能力声明**。

#### 新增数据结构

```rust
/// 厂商原生工具能力声明
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NativeToolCapabilities {
    /// 支持的原生工具列表
    #[serde(default)]
    pub native_tools: Vec<NativeToolDef>,
    /// 厂商提供的 MCP Server 端点
    #[serde(default)]
    pub mcp_endpoints: Vec<McpEndpointDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeToolDef {
    /// 工具类型标识 (如 "web_search", "vision", "image_gen", "ocr", "asr", "code_interpreter")
    pub tool_type: String,
    /// 该工具在 Chat Completion tools 参数中的 JSON 配置
    pub tool_config: serde_json::Value,
    /// 适用的模型列表（空 = 全部模型适用）
    #[serde(default)]
    pub supported_models: Vec<String>,
    /// 是否默认启用
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpEndpointDef {
    /// 端点名称
    pub name: String,
    /// SSE / stdio / http 类型
    pub transport: String,
    /// 端点地址
    pub url: String,
    /// 是否需要 API key
    #[serde(default)]
    pub requires_auth: bool,
}
```

#### 修改 ProviderDefinition

```rust
pub struct ProviderDefinition {
    pub id: String,
    pub name: String,
    pub default_base_url: String,
    pub api_key_prefix: String,
    pub models: Vec<ModelInfo>,
    pub is_custom: bool,
    pub is_local: bool,
    // ── 新增 ──
    #[serde(default)]
    pub capabilities: NativeToolCapabilities,
}
```

#### 内置 Provider 能力声明示例

```rust
// 智谱
ProviderDefinition {
    id: "zhipu",
    capabilities: NativeToolCapabilities {
        native_tools: vec![
            NativeToolDef {
                tool_type: "web_search",
                tool_config: json!({
                    "type": "web_search",
                    "web_search": {
                        "enable": "True",
                        "search_engine": "search-prime"
                    }
                }),
                supported_models: vec![],  // 全部模型
                enabled_by_default: true,
            },
        ],
        mcp_endpoints: vec![
            McpEndpointDef {
                name: "zhipu-web-reader",
                transport: "sse",
                url: "https://open.bigmodel.cn/api/mcp/web_reader/sse",
                requires_auth: true,
            },
        ],
    },
    ..
}

// DashScope (通义)
ProviderDefinition {
    id: "dashscope",
    capabilities: NativeToolCapabilities {
        native_tools: vec![
            NativeToolDef {
                tool_type: "web_search",
                tool_config: json!({
                    "extra_body": {
                        "enable_search": true,
                        "search_options": {
                            "forced_search": false,
                            "search_strategy": "pro"
                        }
                    }
                }),
                supported_models: vec![
                    "qwen-plus", "qwen3-max", "qwen3.5-plus",
                    "qwen3.5-flash", "qwen-turbo"
                ],
                enabled_by_default: true,
            },
        ],
        ..
    },
    ..
}

// Moonshot (Kimi)
ProviderDefinition {
    id: "moonshot",
    capabilities: NativeToolCapabilities {
        native_tools: vec![
            NativeToolDef {
                tool_type: "web_search",
                tool_config: json!({
                    "type": "builtin_function",
                    "function": { "name": "$web_search" }
                }),
                supported_models: vec![],  // 全部模型
                enabled_by_default: true,
            },
        ],
        ..
    },
    ..
}
```

### 3.2 ReAct Agent 改动

在 `react_agent.rs` 的 `run_react_with_options_persist` 中，根据当前 Provider 自动注入原生工具：

```rust
// 伪代码
let provider_caps = get_provider_capabilities(config.provider_id);
let mut tools = builtin_tools();
tools.extend(extra_tools.iter().cloned());

// 注入原生工具配置到 tools 数组
for native_tool in &provider_caps.native_tools {
    if native_tool.enabled_by_default {
        if native_tool.supported_models.is_empty()
            || native_tool.supported_models.contains(&config.model)
        {
            // 将 native_tool.tool_config 加入到 API 请求的 tools 参数中
            native_tools_config.push(native_tool.tool_config.clone());
        }
    }
}
```

### 3.3 LLM Client 改动

`llm_client` 模块需要在构建 API 请求时，区分两种 tools：
1. **Function tools**：当前已有的 `{"type": "function", "function": {...}}` 格式
2. **Native tools**：厂商特有格式，直接透传到 `tools` 数组

```rust
// 在构建请求体时
let mut tools_json = Vec::new();

// 1. Function tools (现有的)
for tool in &function_tools {
    tools_json.push(json!({
        "type": "function",
        "function": { "name": tool.name, "description": tool.desc, "parameters": tool.params }
    }));
}

// 2. Native tools (新增，直接透传)
for native_config in &native_tools_config {
    tools_json.push(native_config.clone());
}
```

### 3.4 MCP 自动注册

对于声明了 `mcp_endpoints` 的 Provider，在用户配置好 API key 后自动注册到 `mcp_runtime`：

```
用户配置智谱 API key
→ ProvidersState 检测到 zhipu 已 configured
→ 自动将 zhipu 的 mcp_endpoints 注册到 McpRuntime
→ Agent 获得 web_reader 等额外工具
```

---

## 四、用户体验设计

### 4.1 核心原则：用户不选择，系统替他们决定

| 传统 AI 产品 | YiYi 方式 |
|-------------|--------------|
| 用户选模型 | 系统根据任务自动选 |
| 用户开启"联网搜索"开关 | 默认开启，Agent 自动判断 |
| 用户手动上传图片到"视觉模型" | 直接拖图到对话框，自动识别 |
| 用户学习 Prompt 模板 | Skills 一句话触发 |

### 4.2 前端交互

#### 对话框增强
- **拖拽/粘贴图片**：自动走 Vision 通道
- **拖拽音频文件**：自动走 ASR 转写
- **联网搜索指示器**：当 Agent 使用 web_search 时，显示搜索来源卡片
- **图片生成预览**：内联显示生成的图片

#### Settings 页面
- Provider 配置区显示已解锁的能力徽章（如 🔍 搜索、👁 视觉、🎨 生图）
- 高级用户可以手动开关特定原生工具

### 4.3 Skills 快捷入口

针对普通用户，通过 Skills 将复杂能力包装为一句话操作：

| Skill 名称 | 触发方式 | 底层能力 |
|-----------|---------|---------|
| 联网搜索 | "搜索 XXX" | Provider web_search |
| 图片识别 | 拖入图片 | Provider vision |
| OCR 取字 | "识别这张图的文字" | Provider OCR |
| AI 画图 | "画一张 XXX" | Provider image_gen |
| 语音转文字 | 拖入音频 | Provider ASR |
| 做 PPT | "帮我做一个关于 XXX 的PPT" | 智谱 Slide Agent / 内置 pptx skill |

---

## 五、实施优先级

### P0 - 基础设施 + Web Search（第一阶段）

**目标**：让用户配好任意一个 Provider 的 key 后，自动获得联网搜索能力。

| 任务 | 涉及文件 | 工作量 |
|------|---------|--------|
| 定义 `NativeToolCapabilities` 数据结构 | `state/providers.rs` | S |
| 为内置 Provider 添加能力声明 | `state/providers.rs` | S |
| `ProviderPlugin` 支持 capabilities | `state/providers.rs` | S |
| `llm_client` 支持透传 native tools | `engine/llm_client/` | M |
| `react_agent` 根据 Provider 注入原生工具 | `engine/react_agent.rs` | M |
| 前端搜索来源卡片展示 | `pages/Chat.tsx` | M |
| 智谱 + DashScope + Moonshot web_search 端到端验证 | - | M |

### P1 - Vision + OCR + 图片生成（第二阶段）

| 任务 | 涉及文件 |
|------|---------|
| 对话框支持图片拖拽/粘贴 | `pages/Chat.tsx`, `components/` |
| `LLMMessage` content 支持 image_url 类型 | `engine/llm_client/` |
| 图片生成结果内联展示 | `pages/Chat.tsx` |
| OCR 结果格式化展示 | `pages/Chat.tsx` |

### P2 - MCP 自动注册 + ASR（第三阶段）

| 任务 | 涉及文件 |
|------|---------|
| Provider configured 时自动注册 MCP endpoints | `engine/mcp_runtime.rs`, `state/providers.rs` |
| 音频文件拖拽 + ASR 转写 | `pages/Chat.tsx`, `engine/tools.rs` |
| 能力徽章 UI | `pages/Settings.tsx` |

### P3 - Agent Delegation 扩展（第四阶段）

| 任务 | 涉及文件 |
|------|---------|
| PPT 生成对接（智谱 Slide Agent 或内置 skill） | `engine/skills_hub.rs` |
| 视频生成异步任务框架 | `engine/scheduler.rs` |
| 任务进度展示 UI | `components/TaskExecutionDetail.tsx` |

---

## 六、各厂商原生工具对接详情

### 6.1 智谱 (z.ai / bigmodel.cn)

| 工具 | API 参数 | 备注 |
|------|---------|------|
| Web Search | `{"type": "web_search", "web_search": {"enable": "True", "search_engine": "search-prime", "count": "5"}}` | 支持 domain_filter, recency_filter |
| Vision | 使用 GLM-4.6V/4.5V 模型 + image_url content | 自动识别图片内容 |
| OCR | 使用 GLM-OCR 模型 | 专用模型，返回结构化文本 |
| Image Gen | 使用 GLM-Image 模型，异步 API | 返回图片 URL |
| ASR | GLM-ASR-2512 模型 | 上传音频文件 |
| MCP | SSE 端点：Web Reader / Web Search / Vision / Zread | 需要 API key |

### 6.2 DashScope / Coding Plan (通义千问)

#### Web Search 基础配置

通过 `extra_body` 注入搜索参数（兼容 OpenAI SDK 格式）：

```json
{
  "model": "qwen-plus",
  "messages": [...],
  "extra_body": {
    "enable_search": true
  }
}
```

#### search_options 高级配置

```json
{
  "extra_body": {
    "enable_search": true,
    "search_options": {
      "forced_search": false,
      "search_strategy": "pro",
      "search_prompt": "自定义搜索改写提示词"
    }
  }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `enable_search` | bool | 启用联网搜索 |
| `search_options.forced_search` | bool | 强制每次都搜索（默认 false，模型自行判断） |
| `search_options.search_strategy` | string | 搜索策略：`"standard"` / `"pro"`（pro 更深度） |
| `search_options.search_prompt` | string | 自定义搜索 query 改写提示词 |

#### 支持模型

| 模型 | Web Search | Vision | Code Interpreter |
|------|-----------|--------|-----------------|
| qwen-plus | ✅ | ✅ | ✅ |
| qwen3-max | ✅ | ✅ | ✅ |
| qwen3.5-plus | ✅ | ✅ | ✅ |
| qwen3.5-flash | ✅ | ✅ | - |
| qwen-turbo | ✅ | - | - |
| qwen-vl-max | - | ✅ | - |

#### 其他原生工具

| 工具 | API 参数 | 备注 |
|------|---------|------|
| Vision | qwen-vl-max / qwen3-max + image_url content | 多模态模型，支持 base64 和 URL |
| Code Interpreter | Qwen Agent / Coding Plan 套餐 | 沙盒执行 Python，需要额外设置 |

### 6.3 Moonshot / Kimi

#### Web Search 配置

通过 `tools` 数组注入内置函数：

```json
{
  "model": "moonshot-v1-auto",
  "messages": [...],
  "tools": [
    {
      "type": "builtin_function",
      "function": {
        "name": "$web_search"
      }
    }
  ]
}
```

搜索结果会作为 `tool_calls` 返回，`function.name` 为 `$web_search`，`arguments` 中包含搜索结果的结构化数据。

#### 响应处理

模型返回搜索结果后，需要将结果以 `tool` role 消息回传：

```json
{
  "role": "tool",
  "tool_call_id": "<tool_call_id>",
  "name": "$web_search",
  "content": "<搜索结果 JSON>"
}
```

#### 其他原生工具

| 工具 | API 参数 | 备注 |
|------|---------|------|
| Vision | moonshot-v1-auto + image_url content | 支持图片理解 |
| 文件解析 | file content（先通过 files API 上传） | 支持 PDF、Word、Excel 等格式 |

---

## 七、风险与考量

### 7.1 API 兼容性

各厂商的 native tools 格式不统一：
- 智谱：`tools` 数组，自定义 `web_search` 类型
- DashScope：`extra_body` 注入 `enable_search` + `search_options`
- Moonshot：`tools` 数组，`builtin_function` 类型

**应对**：在 `llm_client` 层按 Provider 做适配，`react_agent` 层统一接口。

### 7.2 成本控制

原生工具调用可能产生额外费用（如 web_search 按次计费）。

**应对**：
- 在能力声明中标注 `cost_type`（free / per_call / per_token）
- 前端提供费用提示
- 高级设置允许关闭特定工具

### 7.3 向后兼容

新增 `capabilities` 字段使用 `#[serde(default)]`，不影响现有 Provider 配置。已配置的自定义 Provider 和 Plugin 无需修改。

---

## 八、成功指标

| 指标 | 目标 |
|------|------|
| 用户配置 Provider 后自动获得原生工具 | 零额外配置 |
| Web Search 首次调用成功率 | > 95% |
| 用户感知到的能力数量增长 | 从当前工具集 → +5 种以上原生能力 |
| 新用户首次成功使用高级功能的时间 | < 30 秒（拖入图片/说"搜一下"） |

---

## 九、总结

**核心思路**：不造轮子，抱大腿。把各家模型最强的原生能力，通过 Provider 能力声明系统自动暴露给用户。用户只需要配一个 API key，就能获得该厂商的全部能力——搜索、看图、画图、语音、视频——而无需理解任何技术概念。

**一句话**：让 YiYi 成为连接普通人和 AI 能力的最短路径。

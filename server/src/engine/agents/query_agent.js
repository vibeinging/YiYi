/**
 * QueryAgent —— 问数引擎,运行在统一函数调用运行时上。
 *
 * 契约与旧 SuperAgent.execute 完全一致:execute(agentContext, stream_callback) → { success }。
 * chat.js 按 engine flag 在二者间二选一,其余(业务解析/数据源/agentContext/持久化)零改。
 *
 * 问数的算子(NL2SQL / 语义算子 / 指标视图 / grep)、中间表、出图都以工具形式收编进来
 * (见 query_tool_adapter.js)。编排靠 LLM 自主 function-calling + system prompt 策略,
 * 多跳通过工具结果回灌的中间表名驱动,不再用 SuperAgent 的 orchestration 状态机。
 */
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ModelConfigResolver } from "../core/llm.js";
import { BaseAgent } from "../core/base_agent.js";
import { AnalysisSession } from "../core/analysis_session.js";
import { AgentSettings } from "../tools/agent_settings.js";
import { buildQueryTools } from "./query_tool_adapter.js";
import { probeCapabilities } from "./capabilities.js";
import { withAgentToolLifecycles } from "../trace/trace_context.js";
import { appendMessages, loadTranscript, trimToBudget } from "./sessionStore.js";
import {
  assistantMessageTraceText,
  buildPiModel,
  createPiStreamFn,
  DEFAULT_QUERY_MAX_MODEL_TURNS,
  DEFAULT_QUERY_MODEL_TIMEOUT_MS,
  ensurePiProviders,
  normalizePiUsageForTrace,
  positiveInt,
} from "./pi_runtime.js";

function extractParts(content) {
  let text = "";
  let thinking = "";
  for (const part of content || []) {
    if (!part) continue;
    if (part.type === "text") text += part.text || "";
    else if (part.type === "thinking") thinking += part.thinking || part.text || "";
  }
  return { text, thinking };
}

const shortArgs = (args) => {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return "";
  }
};

const TRACE_TEXT_MAX = Math.max(0, Number(process.env.YIW_TRACE_TEXT_MAX || 0));
const QUERY_AGENT_TYPE = "query_agent";

const traceJson = (value, max = TRACE_TEXT_MAX) => {
  if (value == null || value === "") return "";
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    const limit = Math.max(0, Number(max || 0));
    return limit > 0 && s.length > limit ? `${s.slice(0, limit).trimEnd()}...` : s;
  } catch {
    const s = String(value);
    const limit = Math.max(0, Number(max || 0));
    return limit > 0 && s.length > limit ? `${s.slice(0, limit).trimEnd()}...` : s;
  }
};

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const c = result.content;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (!p) return "";
        if (p.type === "text") return p.text || "";
        if (p.text) return p.text;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// 不在对话流里显示 running/done 进度块的工具(它们各自推自己的块:计划/提问)
const SILENT_TOOLS = new Set(["update_plan", "ask_user"]);

// 兜底 prompt:正常走 agent_configs.zh.json 的 query_agent.system_prompt(见 execute);仅配置加载失败时用此。
const FALLBACK_PROMPT =
  "你是数据分析师,帮助用户查询数据库以及非结构化文件回答问题。" +
  "通过函数调用使用工具:多步任务先用 update_plan 公布步骤,逐个调用 sql_scan_operator 等算子取数,需要图表时调 format_result。最终答案直接自然语言输出。永远不要自己编写 SQL。";

export const QUERY_PLANNING_GUARDRAILS = `
### 语义保真补充规则

- **计数主语保真**：用户问“多少/总数/count/total X with/where/containing Y”时，最终聚合的对象是 X，不是 Y 所在容器的全部成员。例：“atoms with triple-bond molecules containing phosphorus or bromine”要数满足元素条件且属于三键分子的 atoms，不能先找分子再统计这些分子的所有 atoms。
- **计数对象行级标识必须保留到最终聚合**：如果最终要 count/sum 的对象是 X，前置 raw 步骤不能只输出 X 的父级/容器 id；必须保留 X 的行级 id 以及后续 JOIN 需要的父级 key。只有最后一步才能聚合。
  - ❌ 错误：先把“含某属性的 atom”压缩成 molecule_id，再统计这些 molecule 的全部 atom。
  - ✅ 正确：先输出满足属性的 atom_id + molecule_id，再与其他条件表 JOIN，最后 COUNT(atom_id)。
- **跨源关联键保留**：跨数据源任务中，每个 raw 步骤必须同时保留后续关联需要的稳定键(id/code/registry code)和用户最终要看的可读字段。不能只取 id，也不能只取 name。
- **文档与结构化表混合时优先用稳定键**：如果结构化表能把可读名称映射到 id/code，而非结构化文档更可能记录 id/code/registry code，则后续 semantic_extract / semantic_filter 应抽取并过滤这些 id/code，再回到中间结果 JOIN 出名称。不要假设文档一定包含用户给出的可读名称。
- **文档实体分散字段合并**：如果同一实体的类别、金额、状态、关联 id 等事实分散在多个文档切片，不能用 semantic_filter 要求单行同时具备所有字段。应先 semantic_scan 全量读取，再 semantic_extract 抽取稳定实体键和当前行可见字段，最后用 sql_scan_operator 在中间表按稳定键 group/coalesce 非空字段后再过滤、JOIN 或计算。
- **文档抽取重复行去重**：semantic_extract / semantic_filter 针对文档切片会保留逐行结果，同一个 record_id 可能出现多次。预算金额、状态、类别等实体属性默认应先按 record_id 或 (record_id,event_id) 去重合并，取 MAX/ANY_VALUE/COALESCE；不要把同一实体在多个切片里的重复金额 SUM 成多笔预算。
- **中间结果补数**：当中间表只包含筛选键或候选列表，不能完成最终指标计算时，必须新增单数据源步骤补齐原子级明细或指标值，再在中间数据源聚合。
`.trim();

function buildRuntimeUserMessage(userMessage, { taskPlanSection = "", intermediateSection = "" } = {}) {
  const blocks = [
    userMessage,
    taskPlanSection,
    intermediateSection,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return blocks.join("\n\n");
}

function stripRuntimeSectionsForTranscript(message) {
  if (message?.role !== "user" || typeof message.content !== "string") return message;
  const markers = ["\n\n## 任务计划", "\n\n## 中间结果"];
  const cuts = markers.map((marker) => message.content.indexOf(marker)).filter((idx) => idx >= 0);
  if (!cuts.length) return message;
  return { ...message, content: message.content.slice(0, Math.min(...cuts)).trimEnd() };
}

function stripRuntimeSectionMessages(messages) {
  return Array.isArray(messages) ? messages.map(stripRuntimeSectionsForTranscript) : [];
}

export class QueryAgent extends BaseAgent {
  constructor(opts = {}) {
    super({ name: "QueryAgent", description: "问数编排 Agent" });
    this.opts = opts; // { dbctx, bds, businessId, capabilities }
  }

  // 按 project 能力门控注册问数工具(去 BaseAgent:用 probeCapabilities 替代 SuperAgent.probe_capabilities)
  static async from_business_context(
    dbctx,
    bds = null,
    businessId = null,
    maxIterations = 50,
    maxEmpty = 3,
    executionOptions = {},
  ) {
    const capabilities = await probeCapabilities(bds, businessId, dbctx);
    return new QueryAgent({
      dbctx,
      bds,
      businessId,
      capabilities,
      maxIterations,
      maxEmpty,
      ...(executionOptions && typeof executionOptions === "object" ? executionOptions : {}),
    });
  }

  async execute(agentContext, stream_callback) {
    ensurePiProviders();
    const q = agentContext?.input_data?.user_message || "";
    const projectId = agentContext?.project_id || null;
    const bds = this.opts?.bds || agentContext?.input_data?.data_sources_info?.business_data_sources || null;
    const businessId = this.opts?.businessId || agentContext?.input_data?.business_id || null;
    const capabilities = this.opts?.capabilities || null;
    const transcriptMode = this.opts?.transcriptMode === "embedded" ? "embedded" : "root";
    const outputMode = this.opts?.outputMode === "tool_result" ? "tool_result" : "direct";
    const embedded = transcriptMode === "embedded";
    const emitAssistantText = outputMode !== "tool_result";
    const externalSignal = this.opts?.signal || agentContext?.signal || null;
    const runtimeSettings = agentContext?.settings || agentContext?.input_data?.settings || {};
    const timeoutMs = positiveInt(
      runtimeSettings.timeoutMs ?? runtimeSettings.queryTimeoutMs ?? process.env.YIW_QUERY_MODEL_TIMEOUT_MS,
      DEFAULT_QUERY_MODEL_TIMEOUT_MS,
    );
    const maxModelTurns = positiveInt(
      runtimeSettings.maxQueryTurns ?? runtimeSettings.maxModelTurns ?? process.env.YIW_QUERY_MAX_MODEL_TURNS,
      DEFAULT_QUERY_MAX_MODEL_TURNS,
    );

    let cfg;
    try {
      cfg = await ModelConfigResolver.resolve({ project_id: projectId, category: "PRIMARY" });
    } catch (e) {
      if (emitAssistantText) {
        await stream_callback(`⚠️ 未配置可用大模型:${e?.message || e}\n请在「项目设置 → 模型配置」配置后再试。`, {
          content_id: randomUUID(),
          content_type: "markdown",
          title: "提示",
        });
      }
      return { success: false, error: "no model configured" };
    }

    const model = buildPiModel(cfg);
    const apiKey = cfg.api_key;
    const sessionId = agentContext?.session_id || agentContext?.input_data?.session_id || null;

    // 会话级状态 + 注册中间数据源(每会话一个 DuckDB 中间库,注入 agentContext 供算子读取)
    const session = new AnalysisSession({ sessionId, agentContext });
    session.registerIntermediate(bds);
    if (agentContext) {
      agentContext.data = agentContext.data || {};
      agentContext.data._finalize_plan = () => session.completeOpenTasks();
    }

    // 加载问数 system prompt(agent_configs.zh.json 的 query_agent;走 AgentSettings 与 SuperAgent 同源,
    // 业务自定义 rules 可经此覆盖)。动态中间结果/任务计划放入本轮 user runtime context,不污染 system prefix。
    const profiles = agentContext?.input_data?.selected_data_profiles || "";
    const queryForPrompt = agentContext?.input_data?.enhanced_user_query || q;
    let systemPrompt = FALLBACK_PROMPT;
    let userMessage = q;
    try {
      const pcfg = await AgentSettings.getAgentConfig(projectId, QUERY_AGENT_TYPE, {
        businessId,
        systemVars: {},
        userVars: {
          question: queryForPrompt,
          data_profiles: profiles ? `## 可用数据\n${profiles}` : "",
          current_date: AgentSettings.getDateContext(),
          intermediate_name: session.intermediateName || `intermediate_${sessionId || "session"}`,
        },
      });
      if (pcfg?.system_prompt) systemPrompt = pcfg.system_prompt;
      if (pcfg?.user_prompt) userMessage = pcfg.user_prompt;
    } catch (e) {
      console.error("[query_agent loadConfig]", e?.message || e);
    }

    // 把「中间结果 / 任务计划」放进本轮 user runtime context,保持 system prompt 稳定以利于 prefix cache。
    let intermediateSection = "";
    try {
      intermediateSection = await session.renderIntermediateSection();
    } catch (e) {
      console.error("[query_agent renderIntermediate]", e?.message || e);
    }
    systemPrompt = systemPrompt
      .split("{intermediate_section}").join("")
      .split("{task_plan_section}").join("");
    systemPrompt = `${systemPrompt}\n\n${QUERY_PLANNING_GUARDRAILS}`;
    userMessage = buildRuntimeUserMessage(userMessage, {
      taskPlanSection: session.renderTaskPlan(),
      intermediateSection,
    });

    // update_plan:LLM 公布/更新计划 → 落 session(权威进度)+ 推前端右栏
    const planTool = {
      name: "update_plan",
      description:
        "公布或更新多步问数计划。每步含 title、source_kind(raw|intermediate|web_search|空)、source_name、status(todo|doing|done)。规划与推进时调用,已完成步骤保持 done;成功完成后框架会兜底关闭未完成步骤。",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            title: Type.String({ description: "子问题标题(业务语言)" }),
            source_kind: Type.Optional(Type.String({ description: "raw | intermediate | web_search | 空" })),
            source_name: Type.Optional(Type.String({ description: "raw 时逐字复制可用数据源名" })),
            status: Type.String({ description: "todo | doing | done" }),
          }),
        ),
      }),
      execute: async (_id, params) => {
        const steps = Array.isArray(params?.steps) ? params.steps : [];
        await session.setTaskPlan(steps); // 内存 + 持久化 analysis_plan_steps(E4)
        await stream_callback(JSON.stringify(steps), { content_id: "plan", content_type: "plan" });
        return { content: [{ type: "text", text: "计划已更新" }] };
      },
    };

    const queryTools = buildQueryTools({
      agentContext,
      session,
      bds,
      businessId,
      capabilities,
      streamCallback: stream_callback,
    });
    const tools = withAgentToolLifecycles([planTool, ...queryTools], { trace_agent: QUERY_AGENT_TYPE });
    // 嵌入模式属于父 Agent 的一次工具调用,不能单独读写父会话转写。
    const resumeRequested = !embedded && Boolean(agentContext?.resume?.continueFromTranscript);
    let historyMessages = [];
    if (resumeRequested) {
      const transcript = loadTranscript(sessionId);
      historyMessages = Array.isArray(transcript) ? trimToBudget(transcript) : [];
    }
    const continueFromTranscript = resumeRequested && historyMessages.length > 0;
    let persistedCount = continueFromTranscript ? historyMessages.length : 0;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        messages: continueFromTranscript ? historyMessages : [],
      },
      toolExecution: "sequential", // 落表确定性必须串行
      streamFn: createPiStreamFn({
        apiKey,
        extraConfig: cfg.extra_config,
        timeoutMs,
        maxModelTurns,
        turnLimitMessage: (limit) => `问数模型轮数超过上限(${limit}),已停止以避免无限工具循环。`,
      }),
    });

    // 根 Agent 与嵌入子 Agent 分开登记,停止父任务时两者都会被 abort。
    const registerAgent = embedded ? agentContext?.onChildAgent : agentContext?.onAgent;
    const unregisterAgent = embedded ? agentContext?.offChildAgent : agentContext?.offAgent;
    if (typeof registerAgent === "function") registerAgent(agent);
    const onExternalAbort = () => agent.abort();
    if (externalSignal?.aborted) {
      if (typeof unregisterAgent === "function") unregisterAgent(agent);
      return { success: false, aborted: true, error: "aborted" };
    }
    externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });

    const flush = () => {
      if (embedded || !sessionId) return;
      try {
        const all = agent.state?.messages || [];
        if (all.length > persistedCount) {
          appendMessages(sessionId, stripRuntimeSectionMessages(all.slice(persistedCount)));
          persistedCount = all.length;
        }
      } catch (e) {
        console.error("[query_agent flush]", e?.message || e);
      }
    };

    // 事件 → stream_callback。文本/思考流式;工具调用推 running/done 进度块(算子各自推表格/图表块)。
    let curTextId = randomUUID();
    let curThinkId = randomUUID();
    let lastText = "";
    let lastThink = "";
    let finalVisibleText = "";
    let finalVisibleTextId = null;
    let lastUsage = null;
    let lastModel = model.id;
    const argsMap = {};

    const unsub = agent.subscribe(async (event) => {
      try {
        switch (event.type) {
          case "turn_start":
            curTextId = randomUUID();
            curThinkId = randomUUID();
            lastText = "";
            lastThink = "";
            lastUsage = null;
            lastModel = model.id;
            break;
          case "turn_end":
            {
              const message = event.message || {};
              const usage = normalizePiUsageForTrace(message.usage) || lastUsage;
              const { text } = extractParts(message.content);
              if (text && text !== finalVisibleText) {
                finalVisibleText = text;
                finalVisibleTextId = curTextId;
              }
              const visibleText = text || lastText;
              const traceText = visibleText || assistantMessageTraceText(message) || lastThink || "LLM turn";
              if (usage && emitAssistantText) {
                await stream_callback(traceText, {
                  content_id: curTextId,
                  content_type: "markdown",
                  title: visibleText ? undefined : "LLM 工具决策",
                  display: Boolean(visibleText),
                  msg_category: visibleText ? "" : "llm_trace",
                  usage,
                  model: message.responseModel || message.model || lastModel || model.id,
                });
              }
            }
            flush();
            break;
          case "message_update": {
            const partial = event.assistantMessageEvent?.partial;
            const { text, thinking } = extractParts(partial?.content);
            const usage = normalizePiUsageForTrace(partial?.usage);
            if (usage) lastUsage = usage;
            lastModel = partial?.responseModel || partial?.model || lastModel || model.id;
            if (thinking && thinking !== lastThink) {
              lastThink = thinking;
              await stream_callback(thinking, { content_id: curThinkId, content_type: "thinking", title: "思考" });
            }
            if (text && text !== lastText) {
              lastText = text;
              finalVisibleText = text;
              finalVisibleTextId = curTextId;
              if (emitAssistantText) {
                await stream_callback(text, {
                  content_id: curTextId,
                  content_type: "markdown",
                  usage: lastUsage,
                  model: lastModel,
                });
              }
            }
            break;
          }
          case "tool_execution_start": {
            argsMap[event.toolCallId] = event.args;
            if (SILENT_TOOLS.has(event.toolName)) break;
            await stream_callback(`${event.toolName} ${shortArgs(event.args)}`, {
              content_id: event.toolCallId,
              content_type: "tool",
              title: "running",
              tool_name: event.toolName,
              trace_input: traceJson(event.args),
            });
            break;
          }
          case "tool_execution_end": {
            if (SILENT_TOOLS.has(event.toolName)) break;
            const args = argsMap[event.toolCallId] || {};
            await stream_callback(`${event.toolName} ${shortArgs(argsMap[event.toolCallId] || {})}`, {
              content_id: event.toolCallId,
              content_type: "tool",
              title: event.isError ? "error" : "done",
              tool_name: event.toolName,
              trace_input: traceJson(args),
              trace_output: traceJson(resultText(event.result)),
            });
            break;
          }
        }
      } catch (e) {
        console.error("[query_agent event]", e?.message || e);
      }
    });

    try {
      if (continueFromTranscript) await agent.continue();
      else await agent.prompt(userMessage);
      if (agentContext?.data?._suspended_by_ask_user) {
        return { success: true, suspended: true, status: "needs_input", answer: "" };
      }
      if (String(finalVisibleText || "").trim()) {
        // assistant stop 且已有可见文本就是正常完成。
        if (emitAssistantText) {
          await stream_callback(finalVisibleText, {
            content_id: finalVisibleTextId || randomUUID(),
            content_type: "markdown",
            title: "回答",
            display: true,
            msg_category: "final_answer",
            usage: lastUsage,
            model: lastModel,
          });
        }
        if (agentContext?.data) agentContext.data._completed_by_natural_answer = true;
        return {
          success: true,
          status: "completed",
          natural_answer: true,
          answer: finalVisibleText,
          provider: model.provider,
          model: lastModel,
        };
      }
      const message = "问数未生成最终答案,已停止。请重试或缩小问题范围。";
      if (emitAssistantText) {
        await stream_callback(`⚠️ ${message}`, {
          content_id: randomUUID(),
          content_type: "markdown",
          title: "错误",
        });
      }
      return { success: false, error: message, error_emitted: true };
    } catch (e) {
      console.error("[query_agent prompt]", e?.stack || e?.message || e);
      if (emitAssistantText) {
        await stream_callback(`⚠️ 问数执行失败:${e?.message || e}`, {
          content_id: randomUUID(),
          content_type: "markdown",
          title: "错误",
        });
      }
      return { success: false, error: e?.message || String(e), error_emitted: true };
    } finally {
      unsub();
      flush();
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
      if (typeof unregisterAgent === "function") unregisterAgent(agent);
    }
  }
}

export default QueryAgent;

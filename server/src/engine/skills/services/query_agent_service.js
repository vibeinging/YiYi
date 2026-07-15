import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { QueryAgent } from "../../agents/query_agent.js";
import { AgentContext } from "../../core/agent_context.js";
import { runAgent } from "../../core/base_agent.js";
import { BusinessDataSources } from "../../datasources/business_data_sources.js";
import { dumpProfilesDesc } from "../../datasources/profile.js";
import { on_task_complete } from "../../semantic/conversation_lifecycle.js";
import { createServiceToolResult } from "../service_skill_contract.js";

const ARTIFACT_TYPES = new Set(["table", "big_table", "chart", "echarts", "vega_lite", "image", "file"]);

function compactCapabilities(capabilities = {}) {
  return {
    structured: Boolean(capabilities.has_structured),
    unstructured: Boolean(capabilities.has_unstructured),
    metrics: Boolean(capabilities.has_metrics || capabilities.has_metric_views),
    web_search: Boolean(capabilities.has_web_search),
  };
}

function listSourceNames(bds) {
  const names = [];
  for (const source of bds?.data_sources?.values?.() || []) {
    const name = String(source?.datasource_name || source?.name || source?.source_name || "").trim();
    if (name) names.push(name);
  }
  for (const name of bds?.web_search_configs?.keys?.() || []) {
    const text = String(name || "").trim();
    if (text) names.push(text);
  }
  return [...new Set(names)];
}

async function loadForeignKeyText(db, bds) {
  if (typeof db?.query !== "function") return "";
  try {
    const connectionIds = bds
      .get_database_sources()
      .map((source) => source.connection_id)
      .filter(Boolean);
    if (!connectionIds.length) return "";
    const relationships = await db.query(
      `SELECT r.source_column, r.target_column, r.relationship_type,
              st.table_name AS source_table, tt.table_name AS target_table
         FROM relationship_metadata r
         LEFT JOIN table_metadata st ON st.id = r.source_table_id
         LEFT JOIN table_metadata tt ON tt.id = r.target_table_id
        WHERE r.database_connection_id::text = ANY($1::text[]) AND r.deleted_at IS NULL`,
      [connectionIds],
    ).catch(() => []);
    if (!relationships.length) return "";
    const lines = relationships.map((relationship) => {
      const type = relationship.relationship_type ? `（${relationship.relationship_type}）` : "";
      return `- ${relationship.source_table || "?"}.${relationship.source_column} → ${relationship.target_table || "?"}.${relationship.target_column}${type}`;
    });
    return `\n### 表间关系（外键）\n${lines.join("\n")}\n`;
  } catch {
    return "";
  }
}

async function buildQueryContext({ db, projectId, sessionId, userId, question, parentContext, skill, toolCallId }) {
  const bds = new BusinessDataSources(projectId, projectId);
  await bds.load_sources();
  const queryAgent = await QueryAgent.from_business_context(
    db,
    bds,
    projectId,
    50,
    3,
    { transcriptMode: "embedded", outputMode: "tool_result" },
  );
  const capabilities = queryAgent.opts?.capabilities || {};
  if (!capabilities.has_any) return { bds, capabilities, childContext: null, queryAgent };

  const profileText = await bds.get_all_profiles(question).then((profiles) => dumpProfilesDesc(profiles)).catch(() => "");
  const foreignKeyText = await loadForeignKeyText(db, bds);
  const childContext = new AgentContext({
    task_id: randomUUID(),
    user_id: userId,
    project_id: projectId,
    session_id: sessionId,
    input_data: {
      user_message: question,
      enhanced_user_query: question,
      selected_data_profiles: profileText + foreignKeyText,
      project_id: projectId,
      business_id: projectId,
      data_sources_info: { business_data_sources: bds },
      session_context: [],
      session_id: sessionId,
      operators: [],
    },
  });
  childContext.parent_task_id = parentContext?.task_id || null;
  childContext.settings = parentContext?.settings || {};
  childContext.db = db;
  childContext.signal = parentContext?.signal || null;
  childContext.skillDecision = {
    skill_name: skill.name,
    runtime: "service",
    reason: "workspace_agent_tool",
    normalized_message: question,
  };
  childContext.onChildAgent = parentContext?.onChildAgent;
  childContext.offChildAgent = parentContext?.offChildAgent;
  childContext.runtime = {
    ...(parentContext?.runtime || {}),
    async requestUserInput(payload = {}, { requestId, checkpoint = {} } = {}) {
      const outerCheckpoint = {
        ...checkpoint,
        tool: skill.tool_name || "query_project_data",
        inner_tool_call_id: checkpoint.tool_call_id || null,
        tool_call_id: toolCallId,
        service: "query_agent",
        skill: skill.name,
        runtime: "service",
        original_user_message: question,
        enhanced_user_query: question,
      };
      const result = typeof parentContext?.runtime?.requestUserInput === "function"
        ? await parentContext.runtime.requestUserInput(payload, { requestId, checkpoint: outerCheckpoint })
        : payload;
      parentContext.data = parentContext.data || {};
      parentContext.data._suspended_by_ask_user = true;
      parentContext.data._pending_user_input_request_id = requestId || payload.request_id || null;
      return result;
    },
  };
  return { bds, capabilities, childContext, queryAgent };
}

export async function executeQueryAgentService({
  skill,
  toolCallId,
  params,
  signal,
  agentContext,
  streamCallback,
} = {}) {
  const projectId = String(agentContext?.project_id || "").trim();
  const sessionId = String(agentContext?.session_id || agentContext?.input_data?.session_id || "").trim();
  const userId = String(agentContext?.user_id || "").trim();
  const question = String(params?.question || "").trim();
  if (!projectId || projectId === "__chat__" || projectId.startsWith("folder:")) {
    return {
      status: "unavailable",
      answer: "",
      warning: "当前不是问数项目，无法查询项目数据。",
      sources: [],
      artifacts: [],
    };
  }
  if (!question) {
    return { status: "failed", answer: "", warning: "查询问题不能为空。", sources: [], artifacts: [] };
  }

  const db = agentContext?.db;
  const artifacts = [];
  const childStream = async (content, options = {}) => {
    const originalId = String(options.content_id || randomUUID());
    const contentId = `service:${toolCallId}:${originalId}`;
    if (ARTIFACT_TYPES.has(options.content_type)) {
      artifacts.push({ id: contentId, type: options.content_type, title: options.title || "" });
    }
    return streamCallback(content, {
      ...options,
      content_id: contentId,
      parent_tool_call_id: toolCallId,
      service: "query_agent",
      skill_name: skill.name,
    });
  };

  try {
    const prepared = await buildQueryContext({
      db,
      projectId,
      sessionId,
      userId,
      question,
      parentContext: agentContext,
      skill,
      toolCallId,
    });
    const sources = listSourceNames(prepared.bds);
    if (!prepared.capabilities?.has_any || !prepared.childContext) {
      return {
        status: "unavailable",
        answer: "",
        warning: "该项目尚未绑定可查询的数据源，请先在项目设置中绑定数据源。",
        sources,
        artifacts,
        capabilities: compactCapabilities(prepared.capabilities),
      };
    }

    prepared.queryAgent.opts.signal = signal || null;
    const result = await runAgent(prepared.queryAgent, prepared.childContext, childStream, { method: "execute" });
    if (signal?.aborted) {
      return {
        status: "cancelled",
        answer: "",
        warning: "查询已取消。",
        sources,
        artifacts,
        capabilities: compactCapabilities(prepared.capabilities),
      };
    }
    const suspended = Boolean(result?.suspended || prepared.childContext.data?._suspended_by_ask_user);
    if (!suspended && result?.success !== false && prepared.childContext.data?._completed_by_natural_answer) {
      await on_task_complete(db, { agent_context: prepared.childContext, project_id: projectId });
    }
    if (!suspended && typeof prepared.childContext.data?._finalize_plan === "function") {
      const finalPlan = await prepared.childContext.data._finalize_plan().catch(() => null);
      if (Array.isArray(finalPlan) && finalPlan.length) {
        await childStream(JSON.stringify(finalPlan), { content_id: "plan", content_type: "plan", display: false });
      }
    }
    return {
      status: suspended ? "needs_input" : result?.success === false ? "failed" : "completed",
      answer: typeof result?.answer === "string" ? result.answer.trim() : "",
      warning: result?.success === false ? String(result.error || result.message || "问数执行失败") : "",
      sources,
      artifacts,
      capabilities: compactCapabilities(prepared.capabilities),
      provider: typeof result?.provider === "string" ? result.provider.trim() : "",
      model: String(result?.model || "").trim(),
    };
  } catch (error) {
    return {
      status: signal?.aborted ? "cancelled" : "failed",
      answer: "",
      warning: error?.message || String(error),
      sources: [],
      artifacts,
    };
  }
}

export function createQueryProjectDataTool({ skill, agentContext, streamCallback } = {}) {
  const toolName = skill?.tool_name || "query_project_data";
  return {
    name: toolName,
    description:
      "查询当前问数项目已经接入的数据。适用于统计、明细、排序、分组、表结构、字段、SQL、图表和数据源内容问题。" +
      "不要用本地文件工具猜项目数据；不要用于创建项目、导入文件或连接数据库。参数 question 要包含完整查询问题。",
    parameters: Type.Object({
      question: Type.String({ description: "要基于当前项目数据回答的完整问题。" }),
      presentation_hint: Type.Optional(Type.String({ description: "可选展示偏好，例如表格、柱状图、折线图。" })),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const details = await executeQueryAgentService({
        skill,
        toolCallId,
        params,
        signal,
        agentContext,
        streamCallback,
      });
      const modelResult = {
        status: details.status,
        answer: details.answer,
        warning: details.warning || undefined,
        sources: details.sources,
        artifacts: details.artifacts,
      };
      return createServiceToolResult({
        modelResult,
        details,
        finalAnswer: details.status === "completed" ? details.answer : "",
        handoffReceipt: {
          status: details.status,
          handed_off: true,
          sources: details.sources,
          artifacts: details.artifacts,
          capabilities: details.capabilities,
        },
        source: {
          type: "service",
          name: "query_agent",
          ...(details.provider ? { provider: details.provider } : {}),
          ...(details.model ? { model: details.model } : {}),
        },
        terminate: details.status === "needs_input",
      });
    },
  };
}

export default createQueryProjectDataTool;

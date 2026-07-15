import { randomUUID } from "node:crypto";
import { StreamEventType, StreamVisibility } from "./agent_stream_protocol.js";
import { artifactPayloadFromPath } from "./ui_capabilities.js";

const TRACE_TEXT_MAX = Math.max(0, Number(process.env.YIW_TRACE_TEXT_MAX || 0));

function traceText(value) {
  const text = value == null ? "" : String(value);
  return TRACE_TEXT_MAX > 0 && text.length > TRACE_TEXT_MAX ? text.slice(0, TRACE_TEXT_MAX) : text;
}

function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeUserInputPayload(content, metadata = {}, title = "") {
  const data = parseJson(content) || (content && typeof content === "object" ? content : {});
  const requestId = String(data.request_id || metadata.request_id || metadata.user_input_id || "").trim();
  return {
    ...data,
    request_id: requestId,
    prompt: String(data.prompt || metadata.prompt || title || "需要您确认"),
    options: Array.isArray(data.options) ? data.options : [],
    allow_multiple: Boolean(data.allow_multiple),
  };
}

function toolNameFromContent(content) {
  return String(content || "").trim().split(/\s+/)[0] || "";
}

function toolCallIdFromResultId(contentId) {
  return String(contentId || "").replace(/^result:/, "");
}

function normalizeToolStatus(title) {
  if (title === "error") return "error";
  if (title === "running") return "running";
  return "ok";
}

export function normalizeAgentContent({ content, opts = {} } = {}) {
  const contentId = opts.content_id || randomUUID();
  const contentType = opts.content_type || "text";
  const { content_id: _contentId, content_type: _contentType, title: _title, ...meta } = opts;
  return {
    contentId,
    contentType,
    content,
    title: opts.title,
    metadata: { display: true, ...meta },
  };
}

function displayTypeFromContent(contentType, content, metadata) {
  if (metadata?.display_type) return metadata.display_type;
  if (contentType === "json") {
    const data = parseJson(content);
    return data?.display_type || data?.chart_type || "table";
  }
  if (contentType === "markdown") return "text";
  return contentType;
}

function tracePayloadMetadata(metadata = {}) {
  const out = {};
  for (const key of [
    "msg_category",
    "task_group",
    "tool_name",
    "display_type",
    "service",
    "skill_name",
    "parent_tool_call_id",
    "handoff",
    "handoff_metadata",
  ]) {
    if (metadata?.[key] != null) out[key] = metadata[key];
  }
  if (metadata?.usage && typeof metadata.usage === "object") out.usage = metadata.usage;
  if (metadata?.trace_usage && typeof metadata.trace_usage === "object") out.usage = metadata.trace_usage;
  if (metadata?.model != null) out.model = metadata.model;
  if (metadata?.model_id != null) out.model_id = metadata.model_id;
  return out;
}

export function contentItemFromAgentContent({ contentId, contentType, content, title, metadata } = {}) {
  const displayType = displayTypeFromContent(contentType, content, metadata);
  return {
    id: contentId,
    type: contentType,
    content,
    title,
    metadata,
    display_type: displayType,
    is_streaming: false,
    is_complete: true,
  };
}

export function streamEventsFromAgentContent({ contentId, contentType, content, title, metadata } = {}) {
  if (contentType === "skill_invocation") {
    const data = parseJson(content) || {};
    const name = data.skill_name || metadata?.skill_name || title;
    if (!name) return [];
    return [{
      type: StreamEventType.SKILL_SELECTED,
      visibility: StreamVisibility.SECONDARY,
      payload: {
        name,
        runtime: data.runtime || metadata?.runtime || "prompt",
        status: data.status || metadata?.status || "selected",
        reason: data.reason || metadata?.reason || "",
      },
    }];
  }

  if (contentType === "plan") {
    const steps = parseJson(content);
    return [{
      type: StreamEventType.PLAN_UPDATED,
      visibility: StreamVisibility.SECONDARY,
      payload: { steps: Array.isArray(steps) ? steps : [] },
    }];
  }

  if (contentType === "thinking") {
    return [{
      type: StreamEventType.MESSAGE_DELTA,
      visibility: StreamVisibility.SECONDARY,
      payload: {
        block_id: contentId,
        channel: "thinking",
        format: "text",
        mode: "replace",
        content: String(content || ""),
        title: title || "思考",
        msg_category: metadata?.msg_category || "",
        usage: metadata?.usage || metadata?.trace_usage || null,
        model: metadata?.model || metadata?.model_id || null,
        metadata: tracePayloadMetadata(metadata),
      },
    }];
  }

  if (contentType === "markdown" || contentType === "text" || contentType === "json") {
    return [{
      type: StreamEventType.MESSAGE_DELTA,
      visibility: metadata?.display === false ? StreamVisibility.HIDDEN : StreamVisibility.PRIMARY,
      payload: {
        block_id: contentId,
        channel: contentType === "json" ? "data" : "answer",
        format: contentType,
        mode: metadata?.replace_content === true ? "replace" : "replace",
        content,
        title,
        msg_category: metadata?.msg_category || "",
        usage: metadata?.usage || metadata?.trace_usage || null,
        model: metadata?.model || metadata?.model_id || null,
        metadata: tracePayloadMetadata(metadata),
      },
    }];
  }

  if (contentType === "tool") {
    const name = metadata?.tool_name || toolNameFromContent(content);
    const argsPreview = String(content || "").slice(name.length).trim();
    const traceInput = metadata?.trace_input || metadata?.traceInput || "";
    const traceOutput = metadata?.trace_output || metadata?.traceOutput || "";
    if (title === "running") {
      return [{
        type: StreamEventType.TOOL_STARTED,
        visibility: StreamVisibility.SECONDARY,
        payload: {
          tool_call_id: contentId,
          name,
          where: metadata?.where || (String(name).startsWith("mcp_") ? "cloud" : "local"),
          kind: metadata?.kind || "tool",
          args_preview: argsPreview,
          input: traceInput,
          skill: metadata?.skill_name || null,
        },
      }];
    }
    const toolEvent = {
      type: title === "error" ? StreamEventType.TOOL_FAILED : StreamEventType.TOOL_COMPLETED,
      visibility: StreamVisibility.SECONDARY,
      payload: {
        tool_call_id: contentId,
        name,
        status: normalizeToolStatus(title),
        args_preview: argsPreview,
        input: traceInput,
        result_preview: traceOutput,
        skill: metadata?.skill_name || null,
      },
    };
    const artifact = artifactPayloadFromPath(metadata?.artifact, {
      source_tool_call_id: contentId,
      source_tool_name: name,
    });
    return artifact
      ? [
          toolEvent,
          {
            type: StreamEventType.ARTIFACT_CREATED,
            visibility: StreamVisibility.SECONDARY,
            payload: artifact,
          },
        ]
      : [toolEvent];
  }

  if (contentType === "tool_result") {
    const name = metadata?.tool_name || title || "";
    return [{
      type: StreamEventType.TOOL_OUTPUT,
      visibility: StreamVisibility.SECONDARY,
      payload: {
        tool_call_id: toolCallIdFromResultId(contentId),
        name,
        result_preview: traceText(content),
      },
    }];
  }

  if (contentType === "confirm") {
    const toolCallId = metadata?.tool_call_id || String(contentId).replace(/^confirm:/, "");
    if (title === "approved" || title === "rejected") {
      return [{
        type: StreamEventType.APPROVAL_RESOLVED,
        visibility: StreamVisibility.HIDDEN,
        payload: {
          approval_id: toolCallId,
          tool_call_id: toolCallId,
          approved: title === "approved",
          summary: String(content || ""),
          args_preview: String(content || ""),
        },
      }];
    }
    return [{
      type: StreamEventType.APPROVAL_REQUESTED,
      visibility: StreamVisibility.ACTION,
      payload: {
        approval_id: toolCallId,
        tool_call_id: toolCallId,
        name: title || toolNameFromContent(content),
        risk: metadata?.risk || "tool_use",
        summary: String(content || ""),
        args_preview: String(content || ""),
      },
    }];
  }

  if (contentType === "workspace_event") {
    const data = metadata?.workspace_event || parseJson(content) || {};
    return [{
      type: StreamEventType.WORKSPACE_UPDATED,
      visibility: StreamVisibility.HIDDEN,
      payload: data,
    }];
  }

  if (contentType === "user_input") {
    return [{
      type: StreamEventType.USER_INPUT_REQUESTED,
      visibility: StreamVisibility.ACTION,
      payload: normalizeUserInputPayload(content, metadata, title),
    }];
  }

  return [{
    type: StreamEventType.MESSAGE_DELTA,
    visibility: metadata?.display === false ? StreamVisibility.HIDDEN : StreamVisibility.PRIMARY,
    payload: {
      block_id: contentId,
      channel: contentType === "error" ? "error" : contentType,
      format: contentType,
      mode: metadata?.replace_content === true ? "replace" : "replace",
      content,
      title,
      msg_category: metadata?.msg_category || "",
      usage: metadata?.usage || metadata?.trace_usage || null,
      model: metadata?.model || metadata?.model_id || null,
      metadata: tracePayloadMetadata(metadata),
    },
  }];
}

export function streamEventFromAgentContent(content = {}) {
  return streamEventsFromAgentContent(content)[0] || null;
}

export default {
  normalizeAgentContent,
  contentItemFromAgentContent,
  streamEventFromAgentContent,
  streamEventsFromAgentContent,
};

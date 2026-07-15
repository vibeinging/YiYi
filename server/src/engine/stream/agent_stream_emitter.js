import { randomUUID } from "node:crypto";
import { createStreamEvent, newMessageId, StreamEventType, StreamVisibility } from "./agent_stream_protocol.js";
import {
  contentItemFromAgentContent,
  normalizeAgentContent,
  streamEventsFromAgentContent,
} from "./agent_content_adapter.js";

export class AgentStreamEmitter {
  constructor({ emit, runId, sessionId, messageId } = {}) {
    if (typeof emit !== "function") throw new Error("AgentStreamEmitter requires emit function");
    this.emit = emit;
    this.runId = runId || randomUUID();
    this.sessionId = sessionId || null;
    this.messageId = messageId || newMessageId("assistant");
    this.seq = 0;
  }

  event(type, payload = {}, { visibility = StreamVisibility.HIDDEN } = {}) {
    const event = createStreamEvent({
      type,
      runId: this.runId,
      sessionId: this.sessionId,
      messageId: this.messageId,
      seq: ++this.seq,
      visibility,
      payload,
    });
    this.emit(event);
    return event;
  }

  runStarted({ mode = "chat", skill = null, content = "正在处理…" } = {}) {
    return this.event(StreamEventType.RUN_STARTED, { mode, skill, label: content }, { visibility: StreamVisibility.HIDDEN });
  }

  runCompleted({ status = "completed", message = "处理完成", usage = null } = {}) {
    const type = status === "completed" ? StreamEventType.RUN_COMPLETED : StreamEventType.RUN_FAILED;
    return this.event(type, { status, message, usage }, { visibility: StreamVisibility.HIDDEN });
  }

  runSuspended({ reason = "user_input", request_id = null, resumable = true, ...extra } = {}) {
    return this.event(
      StreamEventType.RUN_SUSPENDED,
      { status: "suspended", reason, request_id, resumable, ...extra },
      { visibility: StreamVisibility.HIDDEN },
    );
  }

  runResumed({ request_id = null, mode = "handle", ...extra } = {}) {
    return this.event(
      StreamEventType.RUN_RESUMED,
      { status: "resumed", request_id, mode, ...extra },
      { visibility: StreamVisibility.HIDDEN },
    );
  }

  runExpired({ request_id = null, reason = "resume_expired", ...extra } = {}) {
    return this.event(
      StreamEventType.RUN_EXPIRED,
      { status: "expired", request_id, reason, ...extra },
      { visibility: StreamVisibility.HIDDEN },
    );
  }

  content(content, opts = {}) {
    const normalized = normalizeAgentContent({ content, opts });
    const mappedEvents = streamEventsFromAgentContent(normalized);
    for (const mapped of mappedEvents) {
      if (mapped) this.event(mapped.type, mapped.payload, { visibility: mapped.visibility });
    }
    return {
      contentId: normalized.contentId,
      item: contentItemFromAgentContent({
        contentId: normalized.contentId,
        contentType: normalized.contentType,
        content,
        title: normalized.title,
        metadata: normalized.metadata,
      }),
    };
  }

  skillSelected({ name, runtime = null, status = "running", reason = "", ...extra } = {}) {
    if (!name) return null;
    return this.event(
      StreamEventType.SKILL_SELECTED,
      { name, runtime, status, reason, ...extra },
      { visibility: StreamVisibility.SECONDARY },
    );
  }

  userInputRequested(payload = {}) {
    const requestId = String(payload.request_id || payload.user_input_id || "").trim();
    if (!requestId) return null;
    return this.event(
      StreamEventType.USER_INPUT_REQUESTED,
      { ...payload, request_id: requestId },
      { visibility: StreamVisibility.ACTION },
    );
  }

  userInputResolved({ request_id, value, status = "answered", ...extra } = {}) {
    const requestId = String(request_id || "").trim();
    if (!requestId) return null;
    return this.event(
      StreamEventType.USER_INPUT_RESOLVED,
      { request_id: requestId, value, status, ...extra },
      { visibility: StreamVisibility.HIDDEN },
    );
  }
}

export function createAgentStreamEmitter(options = {}) {
  return new AgentStreamEmitter(options);
}

export default {
  AgentStreamEmitter,
  createAgentStreamEmitter,
};

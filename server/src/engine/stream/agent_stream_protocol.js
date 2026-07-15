import { randomUUID } from "node:crypto";

export const AGENT_STREAM_VERSION = 1;

export const StreamVisibility = Object.freeze({
  PRIMARY: "primary",
  SECONDARY: "secondary",
  HIDDEN: "hidden",
  ACTION: "action",
});

export const StreamEventType = Object.freeze({
  RUN_STARTED: "run.started",
  RUN_STATUS: "run.status",
  RUN_SUSPENDED: "run.suspended",
  RUN_RESUMED: "run.resumed",
  RUN_EXPIRED: "run.expired",
  RUN_CANCELLED: "run.cancelled",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
  MESSAGE_DELTA: "message.delta",
  PLAN_UPDATED: "plan.updated",
  TOOL_STARTED: "tool.started",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  TOOL_OUTPUT: "tool.output",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  USER_INPUT_REQUESTED: "user_input.requested",
  USER_INPUT_RESOLVED: "user_input.resolved",
  SKILL_SELECTED: "skill.selected",
  WORKSPACE_UPDATED: "workspace.updated",
  ARTIFACT_CREATED: "artifact.created",
});

export function createStreamEvent({
  type,
  runId,
  sessionId,
  messageId,
  seq,
  visibility = StreamVisibility.HIDDEN,
  payload = {},
  ts = new Date().toISOString(),
} = {}) {
  if (!type) throw new Error("stream event type is required");
  return {
    v: AGENT_STREAM_VERSION,
    type,
    run_id: runId || null,
    session_id: sessionId || null,
    message_id: messageId || null,
    seq: Number(seq || 0),
    ts,
    visibility,
    payload: payload && typeof payload === "object" ? payload : {},
  };
}

export function newMessageId(prefix = "msg") {
  return `${prefix}:${randomUUID()}`;
}

export default {
  AGENT_STREAM_VERSION,
  StreamVisibility,
  StreamEventType,
  createStreamEvent,
  newMessageId,
};

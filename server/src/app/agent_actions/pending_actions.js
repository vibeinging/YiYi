import { agentChat } from "../chat/agent_chat.js";

// Control-plane pending action resolver.
// App 内走 Electron IPC registry;HTTP 只是在 eval/CI 下复用同一 usecase 的传输适配。
export async function resolveAgentPendingAction(ctx, input, emit) {
  const { pid, sid, requestId } = input.params || {};
  const body = input.body || {};
  const value = String(body.value ?? body.message ?? body.content ?? "").trim();
  const resumeHandle = body.resume_handle && typeof body.resume_handle === "object" ? body.resume_handle : null;
  const runId = String(body.run_id || resumeHandle?.run_id || "").trim();
  const pendingUserInputResponse = {
    request_id: requestId || body.request_id || resumeHandle?.request_id || "",
    run_id: runId || undefined,
    resume_handle: resumeHandle || undefined,
    value,
  };
  return agentChat(
    ctx,
    {
      ...input,
      params: { pid, sid },
      controlPlaneAction: { type: "pending_action", requestId: pendingUserInputResponse.request_id },
      pendingUserInputResponse,
      body: {
        ...body,
        message: value,
        question: value,
        content: value,
        display_message: value,
      },
    },
    emit,
  );
}

export default {
  resolveAgentPendingAction,
};

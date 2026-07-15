/**
 * Build the common result shape for a service-style skill.
 *
 * `finalAnswer` is an explicit contract: when present, the service owns the
 * complete user-facing answer and the parent Agent may promote it directly.
 * Ordinary tools omit it and keep the existing parent-model synthesis flow.
 */
export function createServiceToolResult({
  modelResult,
  details,
  finalAnswer,
  handoffReceipt,
  source,
  terminate = false,
} = {}) {
  const handoffContent = typeof finalAnswer === "string" ? finalAnswer.trim() : "";
  const receipt = handoffReceipt ?? {
    status: modelResult && typeof modelResult === "object" ? modelResult.status || "completed" : "completed",
    handed_off: true,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(modelResult ?? {}) }],
    details,
    ...(handoffContent
      ? {
          handoff: {
            kind: "final",
            content: handoffContent,
            ...(source && typeof source === "object" ? { source } : {}),
            toolResult: {
              content: [{ type: "text", text: JSON.stringify(receipt) }],
              details: receipt,
            },
          },
        }
      : {}),
    ...(terminate ? { terminate: true } : {}),
  };
}

export default createServiceToolResult;

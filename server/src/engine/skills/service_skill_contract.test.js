import test from "node:test";
import assert from "node:assert/strict";

import { createServiceToolResult } from "./service_skill_contract.js";

test("service tool result promotes an explicit complete answer", () => {
  const result = createServiceToolResult({
    modelResult: { status: "completed", answer: "最终答案" },
    details: { status: "completed" },
    finalAnswer: "  最终答案  ",
    handoffReceipt: { status: "completed", handed_off: true },
    source: { type: "service", name: "query_agent", model: "query-model" },
  });

  assert.deepEqual(result.handoff, {
    kind: "final",
    content: "最终答案",
    source: { type: "service", name: "query_agent", model: "query-model" },
    toolResult: {
      content: [{ type: "text", text: JSON.stringify({ status: "completed", handed_off: true }) }],
      details: { status: "completed", handed_off: true },
    },
  });
  assert.equal(result.terminate, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { status: "completed", answer: "最终答案" });
});

test("ordinary and suspended service results do not claim a final answer", () => {
  const ordinary = createServiceToolResult({ modelResult: { status: "failed" }, details: {}, finalAnswer: "" });
  const suspended = createServiceToolResult({
    modelResult: { status: "needs_input" },
    details: {},
    terminate: true,
  });

  assert.equal(ordinary.handoff, undefined);
  assert.equal(ordinary.terminate, undefined);
  assert.equal(suspended.handoff, undefined);
  assert.equal(suspended.terminate, true);
});

test("non-string final answers never claim a handoff", () => {
  for (const finalAnswer of [{ answer: "wrong shape" }, 42, ["wrong shape"], null]) {
    const result = createServiceToolResult({
      modelResult: { status: "completed", answer: "model answer" },
      details: { status: "completed" },
      finalAnswer,
    });
    assert.equal(result.handoff, undefined);
  }
});

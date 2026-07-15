import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  claimCapabilityInvocation,
  completeCapabilityInvocation,
  deleteCapabilityInvocation,
} from "./capability_idempotency.js";

test("相同幂等键只返回第一次完成结果", () => {
  const key = randomUUID();
  const request = {
    userId: "idempotency-test-user",
    projectId: "idempotency-test-project",
    operationId: "post.projects",
    idempotencyKey: key,
    input: { body: { name: "once" } },
  };
  const first = claimCapabilityInvocation(request);
  try {
    assert.equal(first.state, "claimed");
    assert.equal(claimCapabilityInvocation(request).state, "in_progress");
    completeCapabilityInvocation(first.id, { data: { id: "created-once" } });
    const replay = claimCapabilityInvocation(request);
    assert.equal(replay.state, "replay");
    assert.equal(replay.result.data.id, "created-once");
    assert.equal(
      claimCapabilityInvocation({ ...request, input: { body: { name: "different" } } }).state,
      "conflict",
    );
  } finally {
    deleteCapabilityInvocation(first.id);
  }
});

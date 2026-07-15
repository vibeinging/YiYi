import assert from "node:assert/strict";
import test from "node:test";

import { createProductTools } from "./product_tools.js";

test("capability_invoke 拒绝覆盖当前会话项目", async () => {
  const tools = createProductTools({
    project_id: "project-current",
    user_id: "user-current",
    db: {
      query: async () => [],
      queryOne: async () => null,
    },
  });
  const invoke = tools.find((tool) => tool.name === "capability_invoke");
  const result = await invoke.execute("scope-test", {
    operation_id: "get.projects.by.pid.models",
    params: { pid: "project-other" },
  });
  assert.equal(result.details.success, false);
  assert.equal(result.details.code, "project_scope_violation");
});

test("capability_invoke 在执行写操作前校验声明参数", async () => {
  let writes = 0;
  const tools = createProductTools({
    project_id: "project-current",
    session_id: "session-current",
    user_id: "user-current",
    db: {
      query: async () => { writes += 1; return []; },
      queryOne: async () => { writes += 1; return null; },
    },
  });
  const invoke = tools.find((tool) => tool.name === "capability_invoke");
  const result = await invoke.execute("validation-test", {
    operation_id: "post.projects",
    body: { description: "缺少项目名称" },
  });
  assert.equal(result.details.success, false);
  assert.equal(result.details.code, "invalid_capability_input");
  assert.equal(result.details.corrections[0].path, "body.name");
  assert.equal(writes, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedCapabilityResult,
  buildCapabilityCatalog,
  describeCapability,
  resolveCapabilityProjectScope,
  sanitizeCapabilityResult,
  searchCapabilities,
  validateCapabilityInput,
} from "./capability_bridge.js";
import { ApprovalHook } from "../skills/hooks/prompt_skill_hooks.js";

const routes = [
  { m: "GET", p: "/api/projects/:pid/models", auth: true, fn: async function listProjectModels() {} },
  { m: "POST", p: "/api/projects/:pid/documents/:docId/reprocess", auth: true, fn: async function reprocessDocument() {}, capability: { title: "重新处理文档", long_running: true } },
  { m: "POST", p: "/api/agent-chat", auth: true, stream: true, fn: async function agentChat() {} },
];

test("能力目录排除 Agent 自调用接口并生成稳定 operation_id", () => {
  const catalog = buildCapabilityCatalog(routes);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].operation_id, "get.projects.by.pid.models");
  assert.equal(catalog[1].operation_id, "post.projects.by.pid.documents.by.docid.reprocess");
});

test("搜索只返回少量摘要,describe 才返回参数", () => {
  const catalog = buildCapabilityCatalog(routes);
  const found = searchCapabilities(catalog, { query: "重新处理文档" });
  assert.equal(found.length, 1);
  assert.equal(found[0].operation_id, "post.projects.by.pid.documents.by.docid.reprocess");
  assert.equal(Object.hasOwn(found[0], "input"), false);
  const detail = describeCapability(catalog, found[0].operation_id);
  assert.deepEqual(Object.keys(detail.input.params), ["pid", "docId"]);
  assert.equal(detail.long_running, true);
});

test("结果隐藏密钥并限制数组和文本长度", () => {
  const sanitized = sanitizeCapabilityResult({ api_key: "secret", rows: Array.from({ length: 30 }, (_, i) => i), text: "x".repeat(3000) });
  assert.equal(sanitized.api_key, "[已配置,内容不向 Agent 展示]");
  assert.equal(sanitized.rows.length, 21);
  assert.ok(sanitized.text.length < 2100);
  assert.doesNotThrow(() => JSON.stringify(boundedCapabilityResult(sanitized)));
});

test("ask 模式下只读能力直接执行,写能力仍进入审批", async () => {
  let approvals = 0;
  const hook = new ApprovalHook({
    approval: "ask",
    confirmToolNames: new Set(["capability_invoke"]),
    awaitDecision: async () => { approvals += 1; return true; },
  });
  await hook.beforeToolCall({ toolCall: { name: "capability_invoke" }, args: { operation_id: "get.projects.by.pid.models" } });
  assert.equal(approvals, 0);
  await hook.beforeToolCall({ toolCall: { id: "write-1", name: "capability_invoke" }, args: { operation_id: "post.projects.by.pid.models" } });
  assert.equal(approvals, 1);
});

test("项目会话不能用参数覆盖当前项目", () => {
  const item = { path: "/api/projects/:pid/models", path_params: ["pid"] };
  assert.deepEqual(resolveCapabilityProjectScope(item, {}, "project-current"), {
    params: { pid: "project-current" },
    projectParam: "pid",
    projectId: "project-current",
    needsMembershipCheck: false,
  });
  assert.equal(
    resolveCapabilityProjectScope(item, { pid: "project-other" }, "project-current").error,
    "不能调用当前会话项目之外的能力",
  );
});

test("全局会话显式项目需要成员校验", () => {
  const item = { path: "/api/projects/:id", path_params: ["id"] };
  const scoped = resolveCapabilityProjectScope(item, { id: "project-explicit" }, "__chat__");
  assert.equal(scoped.projectId, "project-explicit");
  assert.equal(scoped.needsMembershipCheck, true);
});

test("声明过的参数结构在调用前返回可修正错误", () => {
  const [item] = buildCapabilityCatalog([{
    m: "POST",
    p: "/api/projects",
    auth: true,
    fn: async function createProject() {},
    capability: {
      input_schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
    },
  }]);
  const invalid = validateCapabilityInput(item, { body: { name: "", unknown: true } });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors.map((error) => error.path), ["body.name", "body.name", "body.unknown"]);
  assert.equal(describeCapability([item], item.operation_id).schema_quality, "declared");
});

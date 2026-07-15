import test from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalHook } from '../../server/src/engine/skills/hooks/prompt_skill_hooks.js';
import { PRODUCT_CONFIRM_TOOL_NAMES } from '../../server/src/engine/agents/product_tool_catalog.js';

test('ApprovalHook full approval skips product confirm tools', async () => {
  const frames = [];
  const decisions = [];
  const hook = new ApprovalHook({
    approval: 'full',
    confirmToolNames: new Set(['skill_create']),
    writeTools: new Set(['write']),
    streamCallback: async (content, metadata) => frames.push({ content, metadata }),
    awaitDecision: async (id) => {
      decisions.push(id);
      return true;
    },
    shortArgs: (args) => JSON.stringify(args),
  });

  const result = await hook.beforeToolCall({
    toolCall: { id: 'call-skill-create', name: 'skill_create' },
    args: { name: 'demo_skill' },
  });

  assert.equal(result, undefined);
  assert.deepEqual(decisions, []);
  assert.deepEqual(frames, []);
});

test('ApprovalHook full approval still skips ordinary write tools', async () => {
  const frames = [];
  const hook = new ApprovalHook({
    approval: 'full',
    confirmToolNames: new Set(),
    writeTools: new Set(['write']),
    streamCallback: async (content, metadata) => frames.push({ content, metadata }),
    awaitDecision: async () => false,
  });

  const result = await hook.beforeToolCall({
    toolCall: { id: 'call-write', name: 'write' },
    args: { path: 'a.txt' },
  });

  assert.equal(result, undefined);
  assert.deepEqual(frames, []);
});

test('ApprovalHook auto approval skips product confirm tools but asks for commands', async () => {
  const frames = [];
  const decisions = [];
  const hook = new ApprovalHook({
    approval: 'auto',
    confirmToolNames: new Set(['skill_create']),
    writeTools: new Set(['write']),
    streamCallback: async (content, metadata) => frames.push({ content, metadata }),
    awaitDecision: async (id) => {
      decisions.push(id);
      return true;
    },
    shortArgs: (args) => JSON.stringify(args),
  });

  const productResult = await hook.beforeToolCall({
    toolCall: { id: 'call-skill-create', name: 'skill_create' },
    args: { name: 'demo_skill' },
  });
  assert.equal(productResult, undefined);
  assert.deepEqual(decisions, []);
  assert.deepEqual(frames, []);

  const bashResult = await hook.beforeToolCall({
    toolCall: { id: 'call-bash', name: 'bash' },
    args: { cmd: 'pwd' },
  });
  assert.equal(bashResult, undefined);
  assert.deepEqual(decisions, ['call-bash']);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].metadata.title, 'bash');
  assert.equal(frames[1].metadata.title, 'approved');
});

test('ApprovalHook asks for MCP product tools outside full approval mode', async () => {
  assert.ok(PRODUCT_CONFIRM_TOOL_NAMES.has('mcp_provider_create'));
  assert.ok(PRODUCT_CONFIRM_TOOL_NAMES.has('mcp_provider_test'));
  assert.ok(PRODUCT_CONFIRM_TOOL_NAMES.has('project_mcp_provider_enable'));

  const frames = [];
  const decisions = [];
  const hook = new ApprovalHook({
    approval: 'ask',
    confirmToolNames: PRODUCT_CONFIRM_TOOL_NAMES,
    writeTools: new Set(['write']),
    streamCallback: async (content, metadata) => frames.push({ content, metadata }),
    awaitDecision: async (id) => {
      decisions.push(id);
      return true;
    },
    shortArgs: (args) => JSON.stringify(args),
  });

  const result = await hook.beforeToolCall({
    toolCall: { id: 'call-mcp-provider-create', name: 'mcp_provider_create' },
    args: { provider_name: 'demo_mcp', command: 'node' },
  });

  assert.equal(result, undefined);
  assert.deepEqual(decisions, ['call-mcp-provider-create']);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].metadata.title, 'mcp_provider_create');
  assert.equal(frames[1].metadata.title, 'approved');
});

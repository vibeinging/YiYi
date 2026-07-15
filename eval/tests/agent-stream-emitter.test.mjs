import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStreamEmitter } from '../../server/src/engine/stream/agent_stream_emitter.js';

test('AgentStreamEmitter emits Agent Stream v1 events by default', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'assistant-1',
  });

  stream.runStarted({ mode: 'chat', skill: 'data_onboarding', content: '处理中' });
  stream.content('你好', { content_id: 'answer-1', content_type: 'markdown' });
  stream.content('read {"path":"a.md"}', {
    content_id: 'tool-1',
    content_type: 'tool',
    title: 'running',
    tool_name: 'read',
  });
  stream.content('read {"path":"a.md"}', {
    content_id: 'tool-1',
    content_type: 'tool',
    title: 'done',
    tool_name: 'read',
  });
  stream.content('file content', {
    content_id: 'result:tool-1',
    content_type: 'tool_result',
    title: 'read',
    tool_name: 'read',
  });
  stream.runCompleted({ status: 'completed', message: '完成' });

  assert.equal(events.every((event) => event.v === 1), true);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events.map((event) => event.type), [
    'run.started',
    'message.delta',
    'tool.started',
    'tool.completed',
    'tool.output',
    'run.completed',
  ]);
});

test('AgentStreamEmitter maps approval, skill, and workspace events into the correct v1 display lanes', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-2',
    sessionId: 'session-2',
    messageId: 'assistant-2',
  });

  stream.skillSelected({ name: 'data_onboarding', runtime: 'prompt', status: 'selected', reason: 'file import' });
  stream.content('bash {"cmd":"python clean.py"}', {
    content_id: 'confirm:tool-2',
    content_type: 'confirm',
    title: 'bash',
    tool_call_id: 'tool-2',
  });
  stream.content('bash {"cmd":"python clean.py"}', {
    content_id: 'confirm:tool-2',
    content_type: 'confirm',
    title: 'approved',
    tool_call_id: 'tool-2',
  });
  stream.content(JSON.stringify({ event: 'project_ready_for_query', project_id: 'project-1' }), {
    content_id: 'workspace:tool-3',
    content_type: 'workspace_event',
    title: 'project_ready_for_query',
    display: false,
    workspace_event: { event: 'project_ready_for_query', project_id: 'project-1' },
  });

  const skill = events.find((event) => event.type === 'skill.selected');
  assert.equal(skill.visibility, 'secondary');
  assert.equal(skill.payload.name, 'data_onboarding');

  const approvalRequest = events.find((event) => event.type === 'approval.requested');
  assert.equal(approvalRequest.visibility, 'action');
  assert.equal(approvalRequest.payload.tool_call_id, 'tool-2');

  const approvalResolved = events.find((event) => event.type === 'approval.resolved');
  assert.equal(approvalResolved.visibility, 'hidden');
  assert.equal(approvalResolved.payload.approved, true);

  const workspace = events.find((event) => event.type === 'workspace.updated');
  assert.equal(workspace.visibility, 'hidden');
  assert.equal(workspace.payload.project_id, 'project-1');
});

test('AgentStreamEmitter maps user input requests into action events', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-user-input',
    sessionId: 'session-user-input',
    messageId: 'assistant-user-input',
  });

  stream.content(JSON.stringify({
    request_id: 'ask-1',
    run_id: 'run-user-input',
    resume_handle: { type: 'user_input_resume', run_id: 'run-user-input', session_id: 'session-user-input', request_id: 'ask-1' },
    prompt: '请选择客户',
    options: [{ label: '宏远科技' }],
  }), {
    content_id: 'user_input:ask-1',
    content_type: 'user_input',
    title: '需要确认',
    request_id: 'ask-1',
  });
  stream.userInputResolved({ request_id: 'ask-1', value: '宏远科技' });

  assert.deepEqual(events.map((event) => event.type), ['user_input.requested', 'user_input.resolved']);
  assert.equal(events[0].visibility, 'action');
  assert.equal(events[0].payload.request_id, 'ask-1');
  assert.equal(events[0].payload.run_id, 'run-user-input');
  assert.equal(events[0].payload.resume_handle.request_id, 'ask-1');
  assert.equal(events[0].payload.prompt, '请选择客户');
  assert.equal(events[1].visibility, 'hidden');
  assert.equal(events[1].payload.value, '宏远科技');
});

test('AgentStreamEmitter emits suspended and resumed run lifecycle events', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-lifecycle',
    sessionId: 'session-lifecycle',
    messageId: 'assistant-lifecycle',
  });

  stream.runStarted({ mode: 'agent' });
  stream.runSuspended({ reason: 'user_input', request_id: 'ask-2', resumable: true });
  stream.runResumed({ request_id: 'ask-2', mode: 'handle' });

  assert.deepEqual(events.map((event) => event.type), ['run.started', 'run.suspended', 'run.resumed']);
  assert.equal(events[1].payload.status, 'suspended');
  assert.equal(events[1].payload.request_id, 'ask-2');
  assert.equal(events[2].payload.mode, 'handle');
});

test('AgentStreamEmitter maps persisted skill invocation content into skill.selected events', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-skill-content',
    sessionId: 'session-skill-content',
    messageId: 'assistant-skill-content',
  });

  stream.content(JSON.stringify({ skill_name: 'data_onboarding', runtime: 'prompt', status: 'running' }), {
    content_id: 'skill:data_onboarding',
    content_type: 'skill_invocation',
    title: 'data_onboarding',
    skill_name: 'data_onboarding',
    display: false,
  });

  assert.deepEqual(events.map((event) => event.type), ['skill.selected']);
  assert.equal(events[0].visibility, 'secondary');
  assert.deepEqual(events[0].payload, {
    name: 'data_onboarding',
    runtime: 'prompt',
    status: 'running',
    reason: '',
  });
});

test('AgentStreamEmitter emits artifacts as first-class v1 events', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-artifact',
    sessionId: 'session-artifact',
    messageId: 'assistant-artifact',
  });

  stream.content('bash {"cmd":"python generate.py"}', {
    content_id: 'tool-image',
    content_type: 'tool',
    title: 'done',
    tool_name: 'bash',
    artifact: '/Users/Four/.yiw/projects/__chat__/red_solid.png',
  });

  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(events.map((event) => event.type), ['tool.completed', 'artifact.created']);
  assert.equal(events[0].payload.artifact, undefined);
  assert.equal(events[1].visibility, 'secondary');
  assert.equal(events[1].payload.kind, 'image');
  assert.equal(events[1].payload.name, 'red_solid.png');
  assert.equal(events[1].payload.source_tool_call_id, 'tool-image');
  assert.equal(events[1].payload.source_tool_name, 'bash');
});

test('AgentStreamEmitter does not emit legacy stream frames', () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    runId: 'run-3',
    sessionId: 'session-3',
    messageId: 'assistant-3',
  });

  stream.runStarted({ content: '处理中' });
  stream.content('你好', { content_id: 'answer-1', content_type: 'markdown' });
  stream.runCompleted();

  assert.equal(events.every((event) => event.v === 1), true);
  assert.deepEqual(events.map((event) => event.type), ['run.started', 'message.delta', 'run.completed']);
});

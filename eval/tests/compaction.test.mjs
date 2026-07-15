import test from 'node:test';
import assert from 'node:assert/strict';

import { compactIfNeeded, MANUAL_COMPACTION_SETTINGS } from '../../server/src/engine/agents/compaction.js';

function message(role, text) {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: 0,
  };
}

function transcript(turns, charsPerMessage) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push(message('user', `question-${i} ${'u'.repeat(charsPerMessage)}`));
    messages.push(message('assistant', `answer-${i} ${'a'.repeat(charsPerMessage)}`));
  }
  return messages;
}

const model = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'test',
  contextWindow: 128000,
  maxTokens: 4096,
};

const summaryStream = async () => ({
  result: async () => ({
    stopReason: 'complete',
    content: [{ type: 'text', text: 'summary checkpoint' }],
  }),
});

test('manual compaction summarizes earlier turns below the automatic 20k recent window', async () => {
  const messages = transcript(12, 300);

  const result = await compactIfNeeded(messages, {
    model,
    settings: MANUAL_COMPACTION_SETTINGS,
    force: true,
    streamFn: summaryStream,
  });

  assert.equal(result.compacted, true);
  assert.ok(result.tokensBefore > MANUAL_COMPACTION_SETTINGS.keepRecentTokens);
  assert.ok(result.messages.length < messages.length);
  assert.equal(result.messages[0].role, 'user');
  assert.match(result.messages[0].content, /summary checkpoint/);
});

test('manual compaction reports no_older_messages for genuinely short conversations', async () => {
  const result = await compactIfNeeded(transcript(2, 20), {
    model,
    settings: MANUAL_COMPACTION_SETTINGS,
    force: true,
    streamFn: summaryStream,
  });

  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'no_older_messages');
  assert.ok(result.tokensBefore < MANUAL_COMPACTION_SETTINGS.keepRecentTokens);
});

test('compaction surfaces summary generation failures as summary_failed', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await compactIfNeeded(transcript(12, 300), {
      model,
      settings: MANUAL_COMPACTION_SETTINGS,
      force: true,
      streamFn: async () => ({
        result: async () => ({
          stopReason: 'error',
          errorMessage: 'model unavailable',
          content: [],
        }),
      }),
    });

    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'summary_failed');
    assert.match(result.error, /model unavailable/);
  } finally {
    console.error = originalError;
  }
});

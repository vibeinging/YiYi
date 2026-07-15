import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import multiturnTask from '../tasks/25-chat-smart-query-routing-multiturn.task.mjs';

const SOURCE_TASK_FILE = new URL('../datasets/functional/input/task_多轮对话/task.json', import.meta.url);

function createEvalAssert() {
  return {
    ok(value, message) {
      assert.ok(value, message);
    },
    eq(actual, expected, message) {
      assert.equal(actual, expected, message);
    },
  };
}

test('App 多轮路由评测跟随源库问题和 gold 数量', async () => {
  const sourceTask = JSON.parse(readFileSync(SOURCE_TASK_FILE, 'utf8'));
  const perTurnRule = sourceTask.assertions.find((item) => item.type === 'per_turn');
  const captured = {};
  const sid = 'source-driven-multiturn-session';

  const driver = {
    async login() {},
    async ensureProject() {
      return 'source-driven-multiturn-project';
    },
    async importDatabase() {
      return { connId: 'source-driven-connection' };
    },
    async askAgentMultiTurn(_pid, questions, options) {
      captured.questions = questions;
      captured.title = options.title;
      return questions.map((_question, index) => {
        const expected = Array.isArray(perTurnRule.expected[index])
          ? perTurnRule.expected[index]
          : [perTurnRule.expected[index]];
        return {
          sid,
          blocks: [
            {
              type: 'tool',
              content: 'query_project_data',
              metadata: { tool_name: 'query_project_data' },
            },
            { type: 'markdown', content: expected.join(' ') },
          ],
        };
      });
    },
  };

  await multiturnTask.run({ driver, assert: createEvalAssert() });

  assert.equal(captured.questions.length, sourceTask.questions.length);
  assert.equal(perTurnRule.expected.length, sourceTask.questions.length);
  assert.equal(captured.title, `chat-smart-query-routing-multiturn-${sourceTask.questions.length}`);
});

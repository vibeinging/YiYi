import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUILTIN_PI_SKILLS,
  renderPiSkillsIndexPrompt,
} from '../../server/src/engine/agents/pi_skill_registry.js';

test('smart_query is only a migration id for the query_project_data service tool', () => {
  const skill = BUILTIN_PI_SKILLS.find((item) => item.name === 'smart_query');
  assert.ok(skill);
  assert.equal(skill.runtime, 'service');
  assert.equal(skill.handler, 'query_agent');
  assert.equal(skill.tool_name, 'query_project_data');

  const source = readFileSync('server/src/engine/skills/service_skill_registry.js', 'utf8');
  assert.match(source, /\["query_agent", createQueryProjectDataTool\]/);
});

test('custom service declarations cannot register executable tools', () => {
  const source = readFileSync('server/src/engine/skills/service_skill_registry.js', 'utf8');
  assert.match(source, /if \(!skill\?\.builtin \|\| \(skill\.runtime \|\| "prompt"\) !== "service"\) continue/);
});

test('only implicit prompt skills stay model-selectable in the use_skill index', () => {
  const prompt = renderPiSkillsIndexPrompt([
    ...BUILTIN_PI_SKILLS.map((skill) => ({
      ...skill,
      effective_enabled: true,
      is_enabled: true,
    })),
    {
      name: 'visible_prompt',
      runtime: 'prompt',
      allow_implicit_invocation: true,
      effective_enabled: true,
      is_enabled: true,
    },
  ]);
  assert.match(prompt, /visible_prompt/);
  assert.doesNotMatch(prompt, /data_onboarding/);
  assert.doesNotMatch(prompt, /project_management/);
  assert.doesNotMatch(prompt, /smart_query/);
});

test('legacy and current chat URLs use the same WorkspaceAgent handler', () => {
  const source = readFileSync('server/src/transport/registry.chat.js', 'utf8');
  const handlers = source.match(/fn: agentChat\.agentChat/g) || [];
  assert.equal(handlers.length, 2);
  assert.match(source, /\/api\/projects\/:pid\/sessions\/:sid\/chat/);
  assert.match(source, /\/api\/agent\/projects\/:pid\/sessions\/:sid\/chat/);
});

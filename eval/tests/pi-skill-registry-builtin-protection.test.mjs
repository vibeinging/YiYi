import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deletePiSkill,
  listPiSkills,
  setAppSkillEnabled,
  setPiSkillEnabled,
} from '../../server/src/engine/agents/pi_skill_registry.js';

function makeCtx({ projectRows = [] } = {}) {
  return {
    async query(sql, params = []) {
      if (sql.includes('FROM app_skills')) return [];
      if (sql.includes('FROM project_skills')) {
        const projectId = params[0];
        return projectRows.filter((row) => row.project_id === projectId);
      }
      return [];
    },
    async queryOne(sql, params = []) {
      if (sql.includes('FROM app_skills')) throw new Error('not found');
      if (sql.includes('FROM project_skills')) {
        const [projectId, skillName] = params;
        const row = projectRows.find((item) => item.project_id === projectId && item.skill_name === skillName);
        if (row) return row;
      }
      throw new Error('not found');
    },
  };
}

test('builtin app skills cannot be disabled', async () => {
  const ctx = makeCtx();

  await assert.rejects(
    () => setAppSkillEnabled(ctx, 'smart_query', { default_enabled: false }),
    /系统内置 Skill 不能关闭/,
  );
  await assert.rejects(
    () => setAppSkillEnabled(ctx, 'smart_query', { is_active: false }),
    /系统内置 Skill 不能关闭/,
  );

  const enabled = await setAppSkillEnabled(ctx, 'smart_query', { default_enabled: true });
  assert.equal(enabled.builtin, true);
  assert.equal(enabled.is_enabled, true);
});

test('builtin project skills cannot be disabled or deleted', async () => {
  const ctx = makeCtx();
  const projectId = 'project-123';

  await assert.rejects(
    () => setPiSkillEnabled(ctx, projectId, 'smart_query', false),
    /系统内置 Skill 不能关闭/,
  );
  await assert.rejects(
    () => deletePiSkill(ctx, projectId, 'smart_query'),
    /系统内置 Skill 不能删除/,
  );
});

test('legacy disabled bindings do not close builtin project skills', async () => {
  const projectId = 'project-123';
  const ctx = makeCtx({
    projectRows: [
      {
        id: 'binding-1',
        project_id: projectId,
        skill_id: 'builtin:smart_query',
        skill_name: 'smart_query',
        is_enabled: 0,
        enabled_override: 0,
        config: '{}',
        skill_template: '',
        created_at: null,
        updated_at: null,
      },
    ],
  });

  const skills = await listPiSkills(ctx, projectId);
  const smartQuery = skills.find((skill) => skill.name === 'smart_query');

  assert.equal(smartQuery?.builtin, true);
  assert.equal(smartQuery?.is_enabled, true);
  assert.equal(smartQuery?.effective_enabled, true);
  assert.equal(smartQuery?.enabled_override, null);
});

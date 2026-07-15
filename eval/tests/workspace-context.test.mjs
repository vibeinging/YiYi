import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WORKSPACE_AGENTS_FILE,
  buildDataSourceOverviewMarkdown,
  buildProjectAgentsMarkdown,
  ensureProjectWorkspaceContext,
  isAskDataProjectWorkspaceId,
  loadProjectDataSourceOverview,
  loadWorkspaceAgentsPrompt,
} from '../../server/src/engine/agents/workspace_context.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'yiw-workspace-context-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('workspace context recognizes only ask-data project ids', () => {
  assert.equal(isAskDataProjectWorkspaceId('project-1'), true);
  assert.equal(isAskDataProjectWorkspaceId('__chat__'), false);
  assert.equal(isAskDataProjectWorkspaceId('folder:abc'), false);
  assert.equal(isAskDataProjectWorkspaceId(''), false);
});

test('ensureProjectWorkspaceContext creates AGENTS.md with project description', () => {
  withTempDir((dir) => {
    const filePath = ensureProjectWorkspaceContext({
      cwd: dir,
      projectId: 'project-1',
      project: { name: '销售分析', description: '门店销售数据' },
    });

    assert.equal(filePath, join(dir, WORKSPACE_AGENTS_FILE));
    const content = readFileSync(filePath, 'utf8');
    assert.match(content, /销售分析 问数项目工作区/);
    assert.match(content, /项目描述: 门店销售数据/);
    assert.match(content, /不要把本地工作区文件列表当作项目已接入的数据源/);
  });
});

test('ensureProjectWorkspaceContext does not overwrite a custom AGENTS.md', () => {
  withTempDir((dir) => {
    const filePath = join(dir, WORKSPACE_AGENTS_FILE);
    writeFileSync(filePath, '# Custom\n\nKeep this.', 'utf8');

    ensureProjectWorkspaceContext({
      cwd: dir,
      projectId: 'project-1',
      project: { name: '销售分析' },
    });

    assert.equal(readFileSync(filePath, 'utf8'), '# Custom\n\nKeep this.');
  });
});

test('managed data source overview uses neutral labels and preserves custom content', () => {
  withTempDir((dir) => {
    const filePath = join(dir, WORKSPACE_AGENTS_FILE);
    writeFileSync(filePath, '# Custom\n\nKeep this.', 'utf8');

    ensureProjectWorkspaceContext({
      cwd: dir,
      projectId: 'project-1',
      project: { name: '销售分析' },
      dataSources: [
        { name: '销售库', kind: 'database', db_type: 'sqlite', table_count: 12 },
        { name: '合同资料', kind: 'document_library', document_count: 128 },
      ],
    });

    const content = readFileSync(filePath, 'utf8');
    assert.match(content, /# Custom/);
    assert.match(content, /Keep this/);
    assert.match(content, /## 已接入数据源概览/);
    assert.match(content, /销售库: SQLITE, 12 张表/);
    assert.match(content, /合同资料: 文档库, 128 个文档/);
    assert.doesNotMatch(content, /结构化数据源|非结构化数据源/);
  });
});

test('loadWorkspaceAgentsPrompt injects local context file content', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, WORKSPACE_AGENTS_FILE), '# Project Rules\n\nUse query_project_data for data.', 'utf8');

    const prompt = loadWorkspaceAgentsPrompt({ cwd: dir });

    assert.match(prompt, /<project_context>/);
    assert.match(prompt, /Project Rules/);
    assert.match(prompt, /Use query_project_data for data/);
    assert.match(prompt, new RegExp(join(dir, WORKSPACE_AGENTS_FILE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('buildProjectAgentsMarkdown includes stable ask-data routing guidance', () => {
  const content = buildProjectAgentsMarkdown({ projectId: 'project-1', project: { name: '测试项目' } });
  assert.match(content, /query_project_data/);
  assert.match(content, /data_onboarding 工作流/);
});

test('buildDataSourceOverviewMarkdown omits structured/unstructured wording', () => {
  const content = buildDataSourceOverviewMarkdown([
    { name: '导入数据', kind: 'file_dataset', table_count: 2 },
    { name: '资料库', kind: 'document_library', document_count: 8 },
  ]);
  assert.match(content, /导入数据: 文件数据集, 2 张表/);
  assert.match(content, /资料库: 文档库, 8 个文档/);
  assert.doesNotMatch(content, /结构化数据源|非结构化数据源/);
});

test('loadProjectDataSourceOverview builds neutral source summaries from project bindings', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('FROM business_data_sources')) {
        return [
          { source_type: 'database_connection', source_id: 'db-1' },
          { source_type: 'structured_data_source', source_id: 'file-1' },
          { source_type: 'unstructured_data_source', source_id: 'doc-1' },
        ];
      }
      if (sql.includes('FROM database_connections')) {
        return [{ id: 'db-1', name: '销售库', db_type: 'sqlite', description: '', table_count: 12 }];
      }
      if (sql.includes('FROM structured_data_sources')) {
        return [{ id: 'file-1', name: '导入数据', description: '', is_active: true, table_count: 2, document_count: 1 }];
      }
      if (sql.includes('FROM unstructured_data_sources')) {
        return [{ id: 'doc-1', name: '资料库', description: '', is_active: true, document_count: 8 }];
      }
      return [];
    },
  };

  const sources = await loadProjectDataSourceOverview(db, 'project-1');

  assert.deepEqual(
    sources.map((source) => ({ name: source.name, kind: source.kind })),
    [
      { name: '销售库', kind: 'database' },
      { name: '导入数据', kind: 'file_dataset' },
      { name: '资料库', kind: 'document_library' },
    ],
  );
});

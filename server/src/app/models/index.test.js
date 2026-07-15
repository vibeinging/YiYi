import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldResumeEmbeddingDocuments } from './index.js';

test('启用的嵌入模型会触发失败文档恢复', () => {
  assert.equal(shouldResumeEmbeddingDocuments({ category: 'EMBEDDING', is_enabled: true }), true);
  assert.equal(shouldResumeEmbeddingDocuments({ category: 'embedding', is_enabled: true }), true);
});

test('普通模型或禁用的嵌入模型不会触发恢复', () => {
  assert.equal(shouldResumeEmbeddingDocuments({ category: 'PRIMARY', is_enabled: true }), false);
  assert.equal(shouldResumeEmbeddingDocuments({ category: 'EMBEDDING', is_enabled: false }), false);
});

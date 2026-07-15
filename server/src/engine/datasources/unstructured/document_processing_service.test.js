import assert from 'node:assert/strict';
import test from 'node:test';

import { embeddingResultStatus } from './document_processing_service.js';

test('全部切片有向量时才标记 completed', () => {
  assert.deepEqual(embeddingResultStatus([[1, 2], [3, 4]]), {
    status: 'completed', success: true, error: null, generated: 2, total: 2,
  });
});

test('未配置嵌入模型时标记 embedding_failed 而不是 completed', () => {
  assert.deepEqual(embeddingResultStatus([null, null], ['未找到可用的 EMBEDDING 模型']), {
    status: 'embedding_failed',
    success: false,
    error: '未找到可用的 EMBEDDING 模型',
    generated: 0,
    total: 2,
  });
});

test('部分切片有向量时保留可重试状态', () => {
  assert.deepEqual(embeddingResultStatus([[1, 2], null], ['请求超时']), {
    status: 'embedding_partial',
    success: false,
    error: '仅完成 1/2 个切片的向量生成: 请求超时',
    generated: 1,
    total: 2,
  });
});

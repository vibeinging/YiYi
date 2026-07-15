import test from 'node:test';
import assert from 'node:assert/strict';

import { extractUsageFromResponse } from '../../server/src/engine/core/llm.js';

test('extractUsageFromResponse preserves cache read and write fields', () => {
  const usage = extractUsageFromResponse({
    usage: {
      prompt_tokens: 1600,
      completion_tokens: 10,
      total_tokens: 1610,
      cost_usd: 0.001,
      prompt_tokens_details: {
        cached_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
    },
  });

  assert.deepEqual(usage.to_dict(), {
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    cached_tokens: 1200,
    cache_write_tokens: 300,
    cost_usd: 0.001,
  });
});

test('extractUsageFromResponse accepts nested cache creation details', () => {
  const usage = extractUsageFromResponse({
    usage: {
      prompt_tokens: 1600,
      completion_tokens: 10,
      prompt_tokens_details: {
        cache_creation: {
          cache_creation_input_tokens: 1200,
        },
      },
    },
  });

  assert.equal(usage.total_tokens, 1610);
  assert.equal(usage.cached_tokens, 0);
  assert.equal(usage.cache_write_tokens, 1200);
});

test('extractUsageFromResponse keeps positive compatibility fields after zero standard fields', () => {
  const usage = extractUsageFromResponse({
    usage: {
      prompt_tokens: 1600,
      completion_tokens: 10,
      total_tokens: 1610,
      prompt_cache_hit_tokens: 1200,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_creation_input_tokens: 300,
      },
    },
  });

  assert.equal(usage.cached_tokens, 1200);
  assert.equal(usage.cache_write_tokens, 300);
});

test('extractUsageFromResponse adds Anthropic cache components to input tokens', () => {
  const usage = extractUsageFromResponse({
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 300,
    },
  });

  assert.deepEqual(usage.to_dict(), {
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    cached_tokens: 1200,
    cache_write_tokens: 300,
    cost_usd: 0,
  });
});

test('extractUsageFromResponse treats camelCase inputTokens as an existing prompt total', () => {
  const usage = extractUsageFromResponse({
    usage: {
      inputTokens: 1600,
      outputTokens: 10,
      totalTokens: 1610,
      cachedTokens: 1200,
      cacheWriteTokens: 300,
    },
  });

  assert.deepEqual(usage.to_dict(), {
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    cached_tokens: 1200,
    cache_write_tokens: 300,
    cost_usd: 0,
  });
});

test('extractUsageFromResponse reads OpenAI Responses input token details', () => {
  const usage = extractUsageFromResponse({
    usage: {
      input_tokens: 1600,
      output_tokens: 10,
      input_tokens_details: {
        cached_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
    },
  });

  assert.deepEqual(usage.to_dict(), {
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    cached_tokens: 1200,
    cache_write_tokens: 300,
    cost_usd: 0,
  });
});

test('extractUsageFromResponse sums cache retention write buckets', () => {
  const usage = extractUsageFromResponse({
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 300,
      },
    },
  });

  assert.deepEqual(usage.to_dict(), {
    prompt_tokens: 600,
    completion_tokens: 10,
    total_tokens: 610,
    cached_tokens: 0,
    cache_write_tokens: 500,
    cost_usd: 0,
  });
});

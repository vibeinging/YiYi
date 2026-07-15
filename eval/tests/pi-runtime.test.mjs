import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPiPayloadConfig,
  buildPiModel,
  createPiStreamFn,
  DEFAULT_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  normalizePiUsageForTrace,
  resolvePiApi,
  resolvePiContextWindow,
  resolvePiProvider,
} from '../../server/src/engine/agents/pi_runtime.js';

test('buildPiModel maps model API format and context window consistently', () => {
  const cfg = {
    model_name: 'claude-sonnet',
    api_base: 'https://api.anthropic.com',
    api_format: 'anthropic',
    extra_config: {
      context_window: 65536,
      extra_headers: { 'X-Eval': '1' },
    },
  };

  const model = buildPiModel(cfg);

  assert.equal(model.id, 'claude-sonnet');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.provider, 'anthropic');
  assert.equal(model.baseUrl, 'https://api.anthropic.com');
  assert.equal(model.contextWindow, 65536);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(model.headers, { 'X-Eval': '1' });
});

test('resolvePiContextWindow falls back when configured value is below the app minimum', () => {
  assert.equal(resolvePiContextWindow({ extra_config: { context_window: MIN_CONTEXT_WINDOW - 1 } }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolvePiContextWindow({ extra_config: { context_window: MIN_CONTEXT_WINDOW } }), MIN_CONTEXT_WINDOW);
});

test('resolvePiApi defaults unknown formats to chat completions', () => {
  assert.equal(resolvePiApi({ api_format: 'responses' }), 'openai-responses');
  assert.equal(resolvePiApi({ api_format: 'chat_completions' }), 'openai-completions');
  assert.equal(resolvePiApi({ api_format: 'unknown' }), 'openai-completions');
});

test('resolvePiProvider defaults to gateway and allows explicit overrides', () => {
  assert.equal(resolvePiProvider({}), 'gateway');
  assert.equal(resolvePiProvider({ api_format: 'anthropic' }), 'anthropic');
  assert.equal(resolvePiProvider({ api_format: 'responses' }), 'openai');
  assert.equal(resolvePiProvider({ extra_config: { provider: 'openrouter' } }), 'openrouter');
});

test('buildPiModel adds DashScope chat-completions cache compat', () => {
  const model = buildPiModel({
    model_name: 'qwen3.6-plus',
    api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_format: 'chat_completions',
    extra_config: {},
  });

  assert.equal(model.api, 'openai-completions');
  assert.equal(model.compat.cacheControlFormat, 'anthropic');
  assert.equal(model.compat.maxTokensField, 'max_tokens');
  assert.equal(model.compat.supportsStrictMode, false);
  assert.equal(model.compat.supportsLongCacheRetention, false);
});

test('normalizePiUsageForTrace preserves DashScope cache usage fields', () => {
  const usage = normalizePiUsageForTrace({
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    prompt_tokens_details: {
      cached_tokens: 1200,
      cache_creation_input_tokens: 300,
    },
  });

  assert.deepEqual(usage, {
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    cached_tokens: 1200,
    cache_write_tokens: 300,
    cost_usd: 0,
  });
});

test('normalizePiUsageForTrace accepts nested DashScope cache creation details', () => {
  const usage = normalizePiUsageForTrace({
    prompt_tokens: 1600,
    completion_tokens: 10,
    prompt_tokens_details: {
      cached_tokens: 0,
      cache_creation: {
        cache_creation_input_tokens: 1200,
      },
    },
  });

  assert.equal(usage.cached_tokens, 0);
  assert.equal(usage.cache_write_tokens, 1200);
});

test('normalizePiUsageForTrace accepts legacy cache input fields', () => {
  const usage = normalizePiUsageForTrace({
    prompt_tokens: 1600,
    completion_tokens: 10,
    cache_input_tokens: 1200,
  });

  assert.equal(usage.prompt_tokens, 1600);
  assert.equal(usage.cached_tokens, 1200);
});

test('normalizePiUsageForTrace does not let zero canonical fields hide positive compatibility fields', () => {
  const usage = normalizePiUsageForTrace({
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cached_tokens: 1200,
    cache_creation_input_tokens: 300,
  });

  assert.deepEqual(usage, {
    prompt_tokens: 1600,
    completion_tokens: 10,
    total_tokens: 1610,
    cached_tokens: 1200,
    cache_write_tokens: 300,
    cost_usd: 0,
  });
});

test('applyPiPayloadConfig merges extra body and chat-completions thinking params', () => {
  const payload = { model: 'qwen', messages: [] };
  const result = applyPiPayloadConfig(
    payload,
    {
      extra_config: {
        thinking: { param: 'chat_template_kwargs.enable_thinking', value: false },
        extra_body: { temperature: 0.2 },
      },
    },
    { api: 'openai-completions' },
  );

  assert.equal(result, payload);
  assert.equal(result.chat_template_kwargs.enable_thinking, false);
  assert.equal(result.temperature, 0.2);
});

test('applyPiPayloadConfig does not apply chat thinking params to non-chat APIs', () => {
  const payload = { model: 'claude' };
  applyPiPayloadConfig(
    payload,
    { extra_config: { thinking: { param: 'enable_thinking', value: false }, extra_body: { top_k: 1 } } },
    { api: 'anthropic-messages' },
  );

  assert.equal(payload.enable_thinking, undefined);
  assert.equal(payload.top_k, 1);
});

test('createPiStreamFn applies timeout and max-turn guard', async () => {
  const calls = [];
  const streamFn = createPiStreamFn({
    apiKey: 'sk-test',
    extraConfig: { cache_retention: 'none' },
    timeoutMs: 1234,
    maxModelTurns: 1,
    baseStreamFn: async (model, context, options) => {
      calls.push({ model, context, options });
      return { ok: true };
    },
  });

  const model = { id: 'm' };
  const context = { messages: [] };

  assert.deepEqual(await streamFn(model, context, { signal: 'sig' }), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.apiKey, 'sk-test');
  assert.equal(calls[0].options.timeoutMs, 1234);
  assert.equal(calls[0].options.cacheRetention, 'none');
  assert.equal(calls[0].options.signal, 'sig');

  await assert.rejects(() => streamFn(model, context, {}), /模型轮数超过上限\(1\)/);
  assert.equal(calls.length, 1);
});

test('createPiStreamFn chains runtime payload config with caller onPayload', async () => {
  const payloads = [];
  const streamFn = createPiStreamFn({
    apiKey: 'sk-test',
    extraConfig: { extra_body: { top_p: 0.8 } },
    baseStreamFn: async (model, context, options) => {
      const payload = await options.onPayload({ model: 'm' }, model);
      payloads.push(payload);
      return { ok: true };
    },
  });

  await streamFn(
    { id: 'm', api: 'openai-completions' },
    { messages: [] },
    {
      onPayload: (payload) => {
        payload.temperature = 0.1;
        return payload;
      },
    },
  );

  assert.deepEqual(payloads[0], { model: 'm', top_p: 0.8, temperature: 0.1 });
});

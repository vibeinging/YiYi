function objectFrom(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function positiveField(source, keys) {
  for (const key of keys) {
    const number = Number(source?.[key] || 0);
    if (Number.isFinite(number) && number > 0) return { key, value: number };
  }
  return null;
}

function retentionCacheWrite(...sources) {
  for (const source of sources) {
    const value = objectFrom(source);
    if (!value) continue;
    const total = positiveNumber(value.ephemeral_5m_input_tokens)
      + positiveNumber(value.ephemeral_1h_input_tokens);
    if (total > 0) return total;
  }
  return 0;
}

export function usageObjectFromResponse(responseData) {
  if (!responseData || typeof responseData !== "object") return null;
  if (objectFrom(responseData.usage)) return responseData.usage;
  return objectFrom(responseData.output)?.usage && objectFrom(responseData.output.usage);
}

export function normalizeTokenUsage(usage) {
  if (!objectFrom(usage)) return null;

  const promptDetails = objectFrom(usage.prompt_tokens_details) || {};
  const inputDetails = objectFrom(usage.input_tokens_details) || {};
  const promptCacheCreation = objectFrom(promptDetails.cache_creation);
  const inputCacheCreation = objectFrom(inputDetails.cache_creation);
  const topLevelCacheCreation = objectFrom(usage.cache_creation);

  const cachedTokens = positiveNumber(
    usage.cacheRead,
    usage.cache_read,
    usage.cacheReadTokens,
    usage.cachedTokens,
    usage.cached_tokens,
    usage.cache_read_tokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cache_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cachedContentTokenCount,
    promptDetails.cached_tokens,
    promptDetails.cache_read_tokens,
    promptDetails.cache_read_input_tokens,
    inputDetails.cached_tokens,
    inputDetails.cache_read_tokens,
    inputDetails.cache_read_input_tokens,
  );

  const explicitCacheWrite = positiveNumber(
    usage.cacheWrite,
    usage.cache_write,
    usage.cacheWriteTokens,
    usage.cache_write_tokens,
    usage.cache_write_input_tokens,
    usage.cacheWriteInputTokens,
    usage.cache_creation_input_tokens,
    promptDetails.cache_write_tokens,
    promptDetails.cache_write_input_tokens,
    promptDetails.cache_creation_input_tokens,
    inputDetails.cache_write_tokens,
    inputDetails.cache_write_input_tokens,
    inputDetails.cache_creation_input_tokens,
    promptCacheCreation?.cache_creation_input_tokens,
    inputCacheCreation?.cache_creation_input_tokens,
    topLevelCacheCreation?.cache_creation_input_tokens,
  );
  const cacheWriteTokens = explicitCacheWrite || retentionCacheWrite(
    promptCacheCreation,
    inputCacheCreation,
    topLevelCacheCreation,
  );

  const promptField = positiveField(usage, ["prompt_tokens", "promptTokens", "promptTokenCount"]);
  const inputTokensField = positiveField(usage, ["input_tokens"]);
  const camelInputTokensField = positiveField(usage, ["inputTokens"]);
  let promptTokens = 0;
  if (promptField) {
    promptTokens = promptField.value;
  } else if (camelInputTokensField) {
    promptTokens = camelInputTokensField.value;
  } else if (inputTokensField) {
    const providerInputIncludesCache = Boolean(
      objectFrom(usage.input_tokens_details) || objectFrom(usage.prompt_tokens_details),
    );
    promptTokens = inputTokensField.value
      + (providerInputIncludesCache ? 0 : cachedTokens + cacheWriteTokens);
  } else {
    promptTokens = positiveNumber(usage.input) + cachedTokens + cacheWriteTokens;
  }

  const completionTokens = positiveNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.outputTokens,
    usage.completionTokens,
    usage.candidatesTokenCount,
    usage.output,
  );
  const totalTokens = positiveNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.totalTokenCount,
    promptTokens + completionTokens,
  );

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: cachedTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd: positiveNumber(usage.cost_usd, usage.costUsd, usage.cost?.total),
  };
}

import { ModelConfigResolver } from "./llm.js";

function parseExtraConfig(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createDbModelConfigProvider({ queryOne, notFoundMessage, catchErrors = false } = {}) {
  if (typeof queryOne !== "function") {
    throw new Error("createDbModelConfigProvider requires queryOne");
  }
  return async ({ project_id, category }) => {
    const requestedCategory = String(category || "PRIMARY").toUpperCase();
    const strictCategory = requestedCategory === "EMBEDDING";
    const sql = strictCategory
      ? `SELECT id, model_name, api_base, api_key, category, extra_config, api_format FROM llm_models
          WHERE api_key IS NOT NULL AND deleted_at IS NULL AND (project_id = $1 OR project_id IS NULL)
            AND category = $2
          ORDER BY (project_id = $1) DESC, created_at DESC LIMIT 1`
      : `SELECT id, model_name, api_base, api_key, category, extra_config, api_format FROM llm_models
          WHERE api_key IS NOT NULL AND deleted_at IS NULL AND (project_id = $1 OR project_id IS NULL)
          ORDER BY (category = COALESCE($2,'PRIMARY')) DESC, (project_id = $1) DESC, created_at DESC LIMIT 1`;
    const queryPromise = queryOne(sql, [project_id || null, requestedCategory]);
    const m = catchErrors ? await queryPromise.catch(() => null) : await queryPromise;
    if (!m) {
      throw new Error(notFoundMessage || `未找到可用模型(category=${requestedCategory})`);
    }
    const extra_config = parseExtraConfig(m.extra_config);
    return {
      id: m.id,
      model_name: m.model_name,
      api_base: m.api_base,
      api_key: m.api_key,
      category: m.category || category || "PRIMARY",
      supports_streaming: true,
      is_enabled: true,
      extra_config,
      context_window: extra_config.context_window,
      api_format: m.api_format || "chat_completions",
    };
  };
}

export function registerDbModelConfigProvider(options = {}) {
  ModelConfigResolver.setProvider(createDbModelConfigProvider(options));
}

export function ensureDbModelConfigProvider(options = {}) {
  if (ModelConfigResolver.hasProvider()) return;
  registerDbModelConfigProvider(options);
}

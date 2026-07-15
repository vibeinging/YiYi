const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_RESULT_CHARS = 12_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_CHARS = 2_000;
const SECRET_KEY = /(?:api[_-]?key|password|passwd|secret|token|authorization|cookie|private[_-]?key)/i;
const SELF_AGENT_PATH = /(?:agent-chat|query-chat|agent-actions|\/chat(?:\/|$))/i;
const INTERNAL_AUTH_PATH = /\/api\/(?:auth|login)(?:\/|$)/i;
const QUERY_ALIASES = new Map([
  ["重新", ["reprocess", "retry", "regenerate", "refresh"]],
  ["重试", ["retry", "reprocess"]],
  ["生成", ["generate", "create"]],
  ["文档", ["document", "documents", "docs", "unstructured"]],
  ["文件", ["file", "document", "upload"]],
  ["向量", ["embedding", "embeddings", "vector"]],
  ["模型", ["model", "models", "llm"]],
  ["项目", ["project", "projects"]],
  ["数据源", ["datasource", "datasources", "source"]],
  ["数据库", ["database", "databases", "connection"]],
  ["表", ["table", "tables"]],
  ["字段", ["column", "columns", "field"]],
  ["删除", ["delete", "remove"]],
  ["更新", ["update", "edit"]],
  ["创建", ["create", "add"]],
  ["查询", ["query", "search", "list", "get"]],
  ["搜索", ["search", "query"]],
]);

const words = (value) => String(value || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, " ")
  .toLowerCase()
  .trim()
  .split(/\s+/)
  .filter(Boolean);

function operationId(route) {
  const path = String(route?.p || "")
    .replace(/^\/api\//, "")
    .replace(/:([a-zA-Z0-9_]+)/g, "by_$1")
    .replace(/[^a-zA-Z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  return `${String(route?.m || "GET").toLowerCase()}.${path}`;
}

function inferredSafety(route) {
  const method = String(route?.m || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "DELETE") return "delete";
  return "write";
}

function pathParams(path) {
  return [...String(path || "").matchAll(/:([a-zA-Z0-9_]+)/g)].map((match) => match[1]);
}

function isExposedRoute(route) {
  if (!route?.fn || route.stream || route.auth === false) return false;
  const path = String(route.p || "");
  if (SELF_AGENT_PATH.test(path) || INTERNAL_AUTH_PATH.test(path)) return false;
  return route.capability?.exposed !== false;
}

export function buildCapabilityCatalog(routes = []) {
  const seen = new Set();
  const items = [];
  for (const route of routes) {
    if (!isExposedRoute(route)) continue;
    const id = route.capability?.operation_id || operationId(route);
    if (!id || seen.has(id)) throw new Error(`Capability operation_id 冲突: ${id}`);
    seen.add(id);
    const meta = route.capability || {};
    const fnName = route.fn?.name || "unnamed";
    const item = {
      operation_id: id,
      title: meta.title || fnName,
      description: meta.description || `${route.m} ${route.p}`,
      domain: meta.domain || String(route.p || "").split("/").filter(Boolean)[1] || "app",
      safety: meta.safety || inferredSafety(route),
      long_running: meta.long_running === true,
      method: route.m,
      path: route.p,
      path_params: pathParams(route.p),
      input_schema: meta.input_schema || null,
      schema_quality: meta.input_schema ? "declared" : "inferred",
      route,
    };
    item.search_text = words([id, item.title, item.description, item.domain, route.p, fnName].join(" "));
    items.push(item);
  }
  return items;
}

export function searchCapabilities(catalog, { query = "", domain = "", safety = "", limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const rawQuery = String(query || "");
  const queryWords = [...new Set([
    ...words(rawQuery),
    ...[...QUERY_ALIASES.entries()]
      .filter(([source]) => rawQuery.includes(source))
      .flatMap(([, aliases]) => aliases),
  ])];
  const safeLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(limit) || DEFAULT_SEARCH_LIMIT));
  return catalog
    .filter((item) => !domain || item.domain === domain)
    .filter((item) => !safety || item.safety === safety)
    .map((item) => {
      const score = queryWords.reduce((total, word) => {
        if (item.operation_id.includes(word)) return total + 6;
        if (words(item.title).includes(word)) return total + 5;
        if (item.search_text.includes(word)) return total + 2;
        return total;
      }, 0);
      return { item, score };
    })
    .filter(({ score }) => queryWords.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.item.operation_id.localeCompare(b.item.operation_id))
    .slice(0, safeLimit)
    .map(({ item }) => ({
      operation_id: item.operation_id,
      title: item.title,
      description: item.description,
      domain: item.domain,
      safety: item.safety,
      long_running: item.long_running,
    }));
}

export function describeCapability(catalog, operationIdValue) {
  const item = catalog.find((entry) => entry.operation_id === operationIdValue);
  if (!item) return null;
  return {
    operation_id: item.operation_id,
    title: item.title,
    description: item.description,
    domain: item.domain,
    safety: item.safety,
    long_running: item.long_running,
    method: item.method,
    path: item.path,
    input: {
      params: Object.fromEntries(item.path_params.map((name) => [name, { type: "string", required: true }])),
      query: item.input_schema?.query || { type: "object", additionalProperties: true },
      body: item.input_schema?.body || { type: "object", additionalProperties: true },
    },
    schema_quality: item.schema_quality,
  };
}

export function sanitizeCapabilityResult(value, depth = 0) {
  if (depth > 6) return "[内容层级过深,已省略]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeCapabilityResult(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[其余 ${value.length - MAX_ARRAY_ITEMS} 项已省略]`);
    return items;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[已配置,内容不向 Agent 展示]" : sanitizeCapabilityResult(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function boundedCapabilityResult(value) {
  const sanitized = sanitizeCapabilityResult(value);
  const text = JSON.stringify(sanitized);
  if (text.length <= MAX_RESULT_CHARS) return sanitized;
  return {
    truncated: true,
    summary: text.slice(0, MAX_RESULT_CHARS),
    original_chars: text.length,
  };
}

export function findCapability(catalog, operationIdValue) {
  return catalog.find((entry) => entry.operation_id === operationIdValue) || null;
}

export function resolveCapabilityProjectScope(item, routeParams = {}, currentProjectId = "") {
  const params = { ...routeParams };
  const projectParam = item?.path_params?.includes("pid")
    ? "pid"
    : (/^\/api\/projects\/:id(?:\/|$)/.test(String(item?.path || "")) ? "id" : null);
  if (!projectParam) return { params, projectParam: null, projectId: null, needsMembershipCheck: false };

  const current = String(currentProjectId || "").trim();
  const hasCurrent = Boolean(current && current !== "__chat__" && !current.startsWith("folder:"));
  const supplied = String(params[projectParam] || "").trim();
  if (hasCurrent && supplied && supplied !== current) {
    return { error: "不能调用当前会话项目之外的能力" };
  }
  const projectId = hasCurrent ? current : supplied;
  if (projectId) params[projectParam] = projectId;
  return {
    params,
    projectParam,
    projectId: projectId || null,
    needsMembershipCheck: !hasCurrent && Boolean(projectId),
  };
}

function valueMatchesType(value, type) {
  if (Array.isArray(type)) return type.some((candidate) => valueMatchesType(value, candidate));
  if (type === "object") return value != null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function validateSchemaValue(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type && !valueMatchesType(value, schema.type)) {
    errors.push({ path, keyword: "type", message: `应为 ${schema.type}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, keyword: "enum", message: `只支持: ${schema.enum.join(", ")}` });
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    errors.push({ path, keyword: "minLength", message: `长度不能小于 ${schema.minLength}` });
  }
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (value[required] == null || value[required] === "") {
        errors.push({ path: `${path}.${required}`, keyword: "required", message: "不能为空" });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateSchemaValue(child, properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, keyword: "additionalProperties", message: "不支持该参数" });
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((child, index) => validateSchemaValue(child, schema.items, `${path}[${index}]`, errors));
  }
}

export function validateCapabilityInput(item, input = {}) {
  const errors = [];
  const schema = item?.input_schema;
  if (!schema) return { valid: true, errors, schemaQuality: "inferred" };
  for (const section of ["params", "query", "body"]) {
    validateSchemaValue(input[section] || {}, schema[section] || { type: "object" }, section, errors);
  }
  return { valid: errors.length === 0, errors, schemaQuality: "declared" };
}

export function capabilityCoverage(routes = []) {
  const catalog = buildCapabilityCatalog(routes);
  const discoverableRoutes = new Set(catalog.map((item) => item.route));
  const excluded = { unauthenticated: 0, streaming: 0, agent_self: 0, explicitly_hidden: 0, invalid: 0 };
  for (const route of routes) {
    if (discoverableRoutes.has(route)) continue;
    if (!route?.fn) excluded.invalid += 1;
    else if (route.capability?.exposed === false) excluded.explicitly_hidden += 1;
    else if (route.auth === false) excluded.unauthenticated += 1;
    else if (route.stream) excluded.streaming += 1;
    else if (SELF_AGENT_PATH.test(String(route.p || "")) || INTERNAL_AUTH_PATH.test(String(route.p || ""))) excluded.agent_self += 1;
    else excluded.invalid += 1;
  }
  return {
    total_routes: routes.length,
    discoverable_routes: catalog.length,
    declared_schema: catalog.filter((item) => item.schema_quality === "declared").length,
    inferred_schema: catalog.filter((item) => item.schema_quality === "inferred").length,
    excluded_routes: routes.length - catalog.length,
    excluded,
    coverage_percent: routes.length ? Number(((catalog.length / routes.length) * 100).toFixed(2)) : 100,
    operation_ids: catalog.map((item) => item.operation_id),
  };
}

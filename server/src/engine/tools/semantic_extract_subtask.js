// 迁移自 yiw_kernel/data_analyze/planner/tools/semantic_extract_subtask.py
//
// SemanticExtractTool —— 对单张中间结果表逐行做结构化抽取（不筛行）。
// 依赖 llm.chat() 逐行调 LLM，把文本字段格式化为标准结构化字段。
//
// 说明：
// - Python 侧通过 StructuredExtract 算子 + IntermediateTableScan 算子 + load_prompt
//   分层实现。Node 桌面版尚未单独迁移这些算子，这里把必要逻辑内联，保持对外
//   接口名 SemanticExtractTool 一致，行为等价（逐行抽取、不丢行、全失败抛错）。
// - DB 访问走 IntermediateDataSource.query(sql)（注入在 context.input_data 里），不直接连库。

import { BaseTool, Result } from '../core/base_tool.js';
import { chat } from '../core/llm.js';
import { t, get_current_language } from '../utils/i18n.js';
import { ExtractSchemaField } from './expected_format.js';

const logger = {
  info: (...args) => console.info('[SemanticExtractTool]', ...args),
  warn: (...args) => console.warn('[SemanticExtractTool]', ...args),
  error: (...args) => console.error('[SemanticExtractTool]', ...args),
};

// 中低温度（审核、分析），对应 Python LLMConfig.TEMPERATURE_MEDIUM
const TEMPERATURE_MEDIUM = 0.1;

// ---- 中间表名校验（对应 intermediate_table_utils._assert_valid_table_name） ----
// LLM 工具参数会沿用该名称拼入 SQL，必须挡住注入向量（ATTACH、COPY TO、read_csv 等）。
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function assertValidTableName(tableName) {
  if (typeof tableName !== 'string' || !VALID_TABLE_NAME.test(tableName)) {
    throw new Error(
      `Invalid intermediate table name: ${JSON.stringify(tableName)} ` +
      '(must match [A-Za-z_][A-Za-z0-9_]{0,127})'
    );
  }
  return tableName;
}

function normalizeTableName(tableName) {
  const normalized = String(tableName || '').trim().split('.').pop();
  if (normalized) assertValidTableName(normalized);
  return normalized;
}

export function normalizeExtractSchemaParam(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      return [];
    }
    return [];
  }
  if (typeof value === 'object') return [value];
  return [];
}

// 解析中间表名（对应 resolve_intermediate_table_name）
function resolveIntermediateTableName({
  table_name = null,
  dependency_tables = null,
  preferred_intermediate_tables = null,
} = {}) {
  if (table_name) return normalizeTableName(table_name);

  let preferredTables = (preferred_intermediate_tables || [])
    .filter((item) => item && typeof item === 'object' && item.intermediate_table)
    .map((item) => normalizeTableName(item.intermediate_table))
    .filter(Boolean);
  // 去重保序
  const uniquePreferred = [...new Set(preferredTables)];
  if (uniquePreferred.length === 1) return uniquePreferred[0];

  const rawDeps = (dependency_tables || [])
    .filter(Boolean)
    .map((item) => normalizeTableName(item));
  const uniqueDeps = [...new Set(rawDeps)];
  if (uniqueDeps.length === 1) return uniqueDeps[0];

  return null;
}

// ---- 占位符引用列（对应 string.get_referenced_cols / get_place_holder_form_col） ----
function getReferencedCols(naturalIns) {
  const cols = new Set();
  const re = /\$\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(String(naturalIns || ''))) !== null) cols.add(m[1]);
  return cols;
}

function getPlaceholderFormCol(colName) {
  return `\${${colName}}`;
}

// 预编译占位符替换器（对应 _build_placeholder_substitutor）。
// 单次替换避免朴素 replace 顺序耦合（A 列值含 ${B} 会被下一轮再替换）。
function buildPlaceholderSubstitutor(prompt, usedCols) {
  if (!usedCols || usedCols.size === 0) return () => prompt;
  const colForPlaceholder = new Map();
  for (const col of usedCols) colForPlaceholder.set(getPlaceholderFormCol(col), col);
  // 按长度倒序，避免 ${a} 截断 ${ab}
  const sortedPlaceholders = [...colForPlaceholder.keys()].sort((a, b) => b.length - a.length);
  const escaped = sortedPlaceholders.map((ph) => ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'g');
  return (row) => prompt.replace(pattern, (matched) => String(row[colForPlaceholder.get(matched)]));
}

// ---- 行内容/字段序列化（对应 semantic_row_utils） ----
const TEXT_PRIORITY_COLUMNS = [
  'embedding_content', 'content', 'text', 'chunk_content',
  'meta_info', 'metadata', 'title', 'name', 'description',
];

function truncateSemanticValue(value, maxLen = 1500) {
  const text = String(value);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...[truncated]';
}

function extractSemanticRowContent(row) {
  const chunks = [];
  for (const key of TEXT_PRIORITY_COLUMNS) {
    const value = row[key];
    if (value === null || value === undefined || value === '') continue;
    chunks.push(`${key}: ${truncateSemanticValue(value)}`);
  }
  if (chunks.length) return chunks.join('\n');

  const fallback = [];
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    if (typeof value === 'string' && !value.trim()) continue;
    fallback.push(`${key}: ${truncateSemanticValue(value, 500)}`);
  }
  return fallback.join('\n');
}

function serializeSemanticRowFields(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object') {
      normalized[key] = truncateSemanticValue(JSON.stringify(value), 1200);
    } else {
      normalized[key] = truncateSemanticValue(value, 1200);
    }
  }
  return JSON.stringify(normalized, null, 2);
}

// Airtable-style ids in KDD sources use "rec" + 14 alphanumeric chars.
// Keep this strict so ordinary lowercase words like "reconciliation" are not
// treated as entity ids and then leaked into downstream SQL.
const RECORD_ID_RE = /\brec(?=[A-Za-z0-9]{14}\b)(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{14}\b/g;

function collectRowText(row) {
  const chunks = [];
  for (const key of TEXT_PRIORITY_COLUMNS) {
    const value = row?.[key];
    if (value === null || value === undefined || value === '') continue;
    chunks.push(String(value));
  }
  if (chunks.length) return chunks.join('\n');
  return Object.values(row || {})
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
}

function classifyIdField(field) {
  const text = `${field?.name || ''} ${field?.description || ''}`.toLowerCase();
  if (/(event|activity|meeting|活动|会议)/i.test(text)) return 'event';
  if (/(budget|fund|asset|allocation|financial|instrument|portfolio|registry|tracking|预算|资金|资产|分配)/i.test(text)) {
    return 'budget';
  }
  return 'generic';
}

function scoreRecordIdContext(context, kind) {
  const text = String(context || '').toLowerCase();
  if (kind === 'event') {
    let score = 0;
    if (/(event\s+(record|identifier|id|link|documentation)|reference\s+code|linked\s+via|活动|会议)/i.test(text)) score += 5;
    if (/(event_status|event\s+supported|associated\s+event|corresponding\s+event)/i.test(text)) score += 2;
    if (/(budgetary\s+unit|budget\s+line|budget\s+rec|financial\s+instrument|asset\s+(tracked|identified)|fund\s+|allocation|registry\s+code|tracking\s+code)/i.test(text)) score -= 4;
    return score;
  }
  if (kind === 'budget') {
    let score = 0;
    if (/(budgetary\s+unit|budget\s+line|budget\s+rec|budget\s+item|financial\s+instrument|asset\s+(tracked|identified|is|rec)|fund\s+|allocation|portfolio\s+asset|registry\s+code|tracking\s+code|unit\s+with|campaign,\s*rec|预算|资金|资产)/i.test(text)) score += 5;
    if (/(advertisement|outsourced\s+campaign|financial\s+instrument|budget)/i.test(text)) score += 2;
    if (/(event\s+(record|identifier|id|link|documentation)|reference\s+code|linked\s+via)/i.test(text)) score -= 4;
    return score;
  }
  return 1;
}

function recordIdCandidates(text) {
  const seen = new Set();
  const out = [];
  for (const match of String(text || '').matchAll(RECORD_ID_RE)) {
    const id = match[0];
    if (seen.has(id)) continue;
    seen.add(id);
    const index = match.index ?? 0;
    out.push({
      id,
      context: String(text || '').slice(Math.max(0, index - 90), Math.min(String(text || '').length, index + id.length + 90)),
    });
  }
  return out;
}

function isAmountLikeField(field) {
  const text = `${field?.name || ''} ${field?.description || ''}`.toLowerCase();
  return /(amount|budget|cost|price|value|funding|revenue|expense|fee|金额|预算|成本|价格|费用|经费)/i.test(text);
}

function parseNumericValue(text) {
  const cleaned = String(text || '').replace(/,/g, '');
  const match = cleaned.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function inferAmountFromText(text) {
  const source = String(text || '');
  const patterns = [
    // Prefer final/revised values over provisional or historical values.
    /\b(?:final|revised|updated|current|approved)\b[^\d.]{0,80}\b(?:budget|amount|allocation)\b[^\d.]{0,40}(?:of|to|at|is|was|为)?\s*[$£€¥]?\s*([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/gi,
    /\b(?:budget|amount|allocation)\b[^\d.]{0,40}\b(?:final|revised|updated|current|approved)\b[^\d.]{0,40}(?:of|to|at|is|was)?\s*[$£€¥]?\s*([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/gi,
    /\b(?:allocated|allocation|budgeted|budget|amount|funded|fund|approved)\b[^\d.]{0,50}(?:of|to|at|is|was|for)?\s*[$£€¥]?\s*([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/gi,
    /(?:预算|金额|经费|费用)[^。；，,.]{0,20}(?:为|是|共|总计|调整为)?\s*[$£€¥]?\s*([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/g,
  ];

  for (const pattern of patterns) {
    let value = null;
    for (const match of source.matchAll(pattern)) {
      const numeric = parseNumericValue(match[1]);
      if (numeric !== null) value = numeric;
    }
    if (value !== null) return value;
  }
  return null;
}

function enrichExtractedAmountFields(result, row, extractSchema) {
  const amountFields = (extractSchema || []).filter(isAmountLikeField);
  if (!amountFields.length) return result;
  const inferred = inferAmountFromText(collectRowText(row));
  if (inferred === null) return result;

  for (const field of amountFields) {
    const fieldName = field?.name;
    if (!fieldName || hasValue(result[fieldName])) continue;
    result[fieldName] = inferred;
  }
  return result;
}

export function enrichExtractedIdFields(extracted, row, extractSchema) {
  const result = { ...(extracted || {}) };
  const idFields = (extractSchema || []).filter((field) => /(^|_)(id|code)$/i.test(String(field?.name || '')));

  const candidates = recordIdCandidates(collectRowText(row));
  if (!candidates.length) return enrichExtractedAmountFields(result, row, extractSchema);

  const recordIds = candidates.map((candidate) => candidate.id);
  const budgetCandidate = candidates
    .map((candidate) => ({ ...candidate, score: scoreRecordIdContext(candidate.context, 'budget') }))
    .sort((a, b) => b.score - a.score)[0];
  const eventCandidate = candidates
    .map((candidate) => ({ ...candidate, score: scoreRecordIdContext(candidate.context, 'event') }))
    .sort((a, b) => b.score - a.score)[0];

  if (result.record_ids === undefined) result.record_ids = recordIds.join(',');
  if (budgetCandidate && budgetCandidate.score > 0 && result.record_id === undefined) {
    result.record_id = budgetCandidate.id;
  }
  if (eventCandidate && eventCandidate.score > 0 && result.linked_event_id === undefined) {
    result.linked_event_id = eventCandidate.id;
  }

  if (!idFields.length) return enrichExtractedAmountFields(result, row, extractSchema);

  for (const field of idFields) {
    const fieldName = field?.name;
    if (!fieldName || (result[fieldName] !== null && result[fieldName] !== undefined && result[fieldName] !== '')) continue;
    const kind = classifyIdField(field);
    let best = null;
    for (const candidate of candidates) {
      const score = scoreRecordIdContext(candidate.context, kind);
      if (!best || score > best.score) best = { ...candidate, score };
    }
    if (best && best.score > 0) result[fieldName] = best.id;
  }
  return enrichExtractedAmountFields(result, row, extractSchema);
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

export function coalesceEntityFieldsByRecordId(rows, extractSchema) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const fieldNames = (extractSchema || []).map((field) => field?.name).filter(Boolean);
  if (!fieldNames.length || !sourceRows.some((row) => hasValue(row?.record_id))) return sourceRows;
  const amountLikeFieldNames = new Set(
    (extractSchema || [])
      .filter(isAmountLikeField)
      .map((field) => field?.name)
      .filter(Boolean),
  );

  const groups = new Map();
  for (let index = 0; index < sourceRows.length; index += 1) {
    const row = sourceRows[index];
    const key = row?.record_id;
    if (!hasValue(key)) continue;
    const group = groups.get(key) || { rowIndexes: [], primaryIndex: index, primaryScore: -Infinity };
    group.rowIndexes.push(index);
    if (hasValue(row.linked_event_id) && !hasValue(group.linked_event_id)) group.linked_event_id = row.linked_event_id;
    for (const fieldName of fieldNames) {
      if (!hasValue(group[fieldName]) && hasValue(row[fieldName])) group[fieldName] = row[fieldName];
    }
    const presentFieldCount = fieldNames.reduce((count, fieldName) => count + (hasValue(row[fieldName]) ? 1 : 0), 0);
    const primaryScore = (hasValue(row.linked_event_id) ? 100 : 0) + presentFieldCount;
    if (primaryScore > group.primaryScore) {
      group.primaryScore = primaryScore;
      group.primaryIndex = index;
    }
    groups.set(key, group);
  }

  if (!groups.size) return sourceRows;

  return sourceRows.map((row, index) => {
    const key = row?.record_id;
    if (!hasValue(key) || !groups.has(key)) return row;
    const group = groups.get(key);
    const merged = { ...row };
    for (const fieldName of fieldNames) {
      if (!hasValue(merged[fieldName]) && hasValue(group[fieldName])) merged[fieldName] = group[fieldName];
    }
    if (fieldNames.includes('event_id') && !hasValue(merged.event_id) && hasValue(group.linked_event_id)) {
      merged.event_id = group.linked_event_id;
    }
    merged.is_entity_primary = index === group.primaryIndex;
    if (!merged.is_entity_primary) {
      for (const fieldName of amountLikeFieldNames) {
        if (hasValue(group[fieldName])) merged[fieldName] = null;
      }
    }
    return merged;
  });
}

// ---- multi_extract prompt（内联自 prompts/{zh_cn,en_us}/semanticop.yaml） ----
function buildMultiExtractPrompt({ instruction, rowContent, rowFields, extractSchema }) {
  const isEn = get_current_language() === 'en';
  if (isEn) {
    return `You are a **Row-wise Structured Extraction Expert**.
Your task is to extract all structured fields defined in the schema from the current row in a single response.

**Extraction Task**:
${instruction}

**Current Row Main Content**:
${rowContent}

**Current Row Structured Fields**:
${rowFields}

**Structured Extraction Schema To Return**:
${extractSchema}

---
### Instructions
1. Your target is only the current row, not the whole table and not the whole knowledge base.
2. You must return all fields defined in \`extract_schema\` in one response. Do not split them across multiple answers.
3. \`data\` must follow the provided \`extract_schema\` exactly. The keys must match the schema \`name\` values exactly. Do not add, rename, or omit keys.
4. If a field cannot be determined from the current row, set that field value to \`null\`.
5. If the schema contains multiple id/code fields, assign each identifier by the surrounding noun phrase and field description. Do not put a budget/entity/asset id into \`event_id\` just because it looks like an id; use \`event_id\` only for ids explicitly described as event, event record, event identifier, reference code, or equivalent.
6. If facts for the same entity are scattered across multiple rows/chunks, extract only the stable entity key and attributes visible in this row, leave the other fields \`null\`, and let downstream SQL group/coalesce by the stable key.
7. Do not output extra fields, do not answer beyond the row, and do not turn this into a general summary.

---
### Output Format
Please output a valid JSON object in the following structure: (wrapped with \`\`\`json and \`\`\`)
\`\`\`json
{
  "data": {
    "field_name": "value or null"
  },
  "reasoning": "string"
}
\`\`\``;
  }
  return `你是一位**逐行结构化抽取专家**。
你的任务是针对"当前这一行数据"，一次性抽取给定 schema 中的所有结构化字段。

**抽取任务**：
${instruction}

**当前行的核心内容**：
${rowContent}

**当前行的结构化字段**：
${rowFields}

**需要返回的结构化抽取 Schema**：
${extractSchema}

---
### 执行要求
1. 你的处理对象只有"当前这一行"，不是整张表，也不是整个知识库。
2. 必须一次性返回 \`extract_schema\` 中定义的全部字段，禁止拆成多次回答。
3. \`data\` 必须严格按照给定的 \`extract_schema\` 返回，key 必须与 schema 中的 \`name\` 完全一致，不允许新增、改名或省略 key。
4. 如果某个字段无法从当前行确定，必须将该字段的值设为 \`null\`。
5. 如果 schema 同时包含多个 id/code 字段，必须根据 ID 周围的实体名词和字段 description 归属字段。不要因为字符串像 ID 就塞进任意 id 字段；\`event_id\` 只填明确被称为 event / event record / event identifier / reference code / 活动记录的 ID，budget/entity/asset/financial instrument/registry/tracking code 等实体 ID 应填入对应实体字段。
6. 如果同一实体的信息分散在多行/多切片，本工具只抽当前行能确定的稳定实体键和字段，其它字段填 null；后续应按稳定键在 SQL 中 group/coalesce 补齐，不要要求单行同时具备所有字段。
7. 不要输出额外字段，不要回答表外信息，不要把问题改写成总结。

---
### 输出格式
请输出以下结构的有效 JSON 对象：（用 \`\`\`json 和 \`\`\` 包裹）
\`\`\`json
{
  "data": {
    "field_name": "value or null"
  },
  "reasoning": "string"
}
\`\`\``;
}

// StructuredExtractAnswer 响应模型（对应 prompts.expected_format.StructuredExtractAnswer）
class StructuredExtractAnswer {
  constructor({ data = null, reasoning = '' } = {}) {
    this.data = data;
    this.reasoning = reasoning;
  }

  static get name() { return 'StructuredExtractAnswer'; }
  static get schema() {
    return { properties: { data: {}, reasoning: {} }, required: ['reasoning'] };
  }

  static fromJSON(parsed) {
    return new StructuredExtractAnswer(parsed || {});
  }
}

// 逐行结构化抽取一行（对应 extract_structured_fields + StructuredExtract._extract_row）
async function extractFieldsFromRow(usedPrompt, row, extractSchema, context) {
  const promptText = buildMultiExtractPrompt({
    instruction: usedPrompt,
    rowContent: extractSemanticRowContent(row),
    rowFields: serializeSemanticRowFields(row),
    extractSchema: JSON.stringify(extractSchema, null, 2),
  });
  const llmResponse = await chat(
    [{ role: 'user', content: promptText }],
    {
      response_model: StructuredExtractAnswer,
      user_id: context.user_id,
      project_id: context.project_id,
      model_role: 'secondary',
      temperature: TEMPERATURE_MEDIUM,
      call_site: 'semantic_operator_extract',
    },
  );
  // 规范化：只保留 schema 中定义的字段，缺失补 null
  const normalized = {};
  const source = (llmResponse && typeof llmResponse.data === 'object' && llmResponse.data) || {};
  for (const field of extractSchema) {
    const fieldName = field && field.name;
    if (!fieldName) continue;
    normalized[fieldName] = source[fieldName] === undefined ? null : source[fieldName];
  }
  return enrichExtractedIdFields(normalized, row, extractSchema);
}

/**
 * SemanticExtractTool —— 语义结构化抽取算子工具。
 * 对外接口名与 Python 保持一致，下游 import { SemanticExtractTool } 不变。
 */
export class SemanticExtractTool extends BaseTool {
  constructor(kwargs = {}) {
    const name = 'semantic_extract_operator';
    const description = `**semantic_extract_operator** - 对单张中间结果表逐行做结构化抽取，不筛除行，适合把文本字段格式化为标准字段供后续 SQL / 展示使用
\`\`\`json
{"tool": "semantic_extract_operator", "params": {"question": "明确说明要从每一行文本/备注/文档片段里抽取哪些结构化信息", "table_name": "中间结果表名", "extract_schema": [{"name": "结构化字段名", "type": "string|number|boolean", "description": "从每一行里抽取什么"}]}}
\`\`\`
- 适用于：已经有一张中间结果表，需要对每一行补充结构化字段，但**不需要**按条件删除行
- 典型场景：从 \`embedding_content\`、备注、说明、文档片段中抽取合同编号、日期、金额、状态、责任人等字段
- \`question\` 必须写清楚逐行抽取目标，不要写成整题总结
- \`extract_schema\` 是强约束，后续步骤依赖的字段必须一次性定义完整
- 同一实体的类别、金额、状态、关联 ID 等事实分散在多个切片时，应先全量抽取稳定实体键（如 *_id/code）和当前行可见字段，再用 \`sql_scan_operator\` 在中间表中按稳定键 group/coalesce 补齐；不要用过滤条件要求单行同时满足所有字段
- 工具会为文档行自动补充辅助列 \`record_id\`（主实体 ID）、\`linked_event_id\`（关联活动/事件 ID）、\`record_ids\`（本行所有记录 ID），跨切片合并时优先使用这些稳定键
- 如果当前子问题本质上是在**一张已存在的中间结果表上继续逐行抽取结构化字段**，就**必须优先使用 \`semantic_extract_operator\`**`;
    super(name, description, kwargs);
    this.name = name;
    this.description = description;
    this.output_type = 'string';
    this.inputs = {
      question: {
        type: 'string',
        description: 'A row-wise extraction instruction in natural language. It should clearly explain '
          + 'what structured information needs to be extracted from each row.',
      },
      table_name: {
        type: 'string',
        description: 'The intermediate table name to extract from. If omitted, it can be inferred from a single dependency table.',
      },
      extract_schema: {
        type: 'list',
        description: 'A unified schema for structured fields extracted from each row. '
          + 'Every item must include name/type, and optional description.',
      },
      depends_on: {
        type: 'list',
        description: 'Dependency task ids for the current subtask.',
      },
    };
  }

  async execute(context, kwargs = {}) {
    const question = kwargs.question;
    const tableName = kwargs.table_name;
    const extractSchema = normalizeExtractSchemaParam(kwargs.extract_schema);
    const dependencyTables = kwargs.dependency_tables || [];
    const preferredIntermediateTables = kwargs.preferred_intermediate_tables || [];

    if (!question) return Result.createError(t('缺少必要参数: question'));
    if (!extractSchema.length) {
      return Result.createError(t('缺少必要参数: extract_schema。请明确要抽取的字段及类型。'));
    }

    const intermediateDs = context.input_data?.data_sources_info?.intermediate_ds;
    let resolvedTableName;
    try {
      resolvedTableName = resolveIntermediateTableName({
        table_name: tableName,
        dependency_tables: dependencyTables,
        preferred_intermediate_tables: preferredIntermediateTables,
      });
    } catch (e) {
      return Result.createError(String(e?.message ?? e));
    }
    if (!resolvedTableName) {
      return Result.createError(
        t('缺少必要参数: table_name。请明确指定要抽取的中间结果表，或确保当前子任务只依赖一张中间表。'),
      );
    }

    let normalizedExtractSchema;
    try {
      normalizedExtractSchema = extractSchema.map((item) => {
        const f = ExtractSchemaField.from(item);
        return { name: f.name, type: f.type, description: f.description };
      });
    } catch (e) {
      return Result.createError(t('extract_schema 参数非法: {}', e?.message ?? e));
    }

    logger.info(
      `Execute semantic extract: table=${resolvedTableName}, question=${question}, `
      + `extract_schema=${JSON.stringify(normalizedExtractSchema)}`,
    );

    let sanitizedResult;
    try {
      // 1) 扫描中间表（对应 IntermediateTableScan.get_next）
      const scanSql = `SELECT * FROM "${assertValidTableName(resolvedTableName)}"`;
      const queryResult = await intermediateDs.query(scanSql);
      if (!queryResult.success) {
        throw new Error(t('查询失败: {}', queryResult.message));
      }
      const leftColumns = new Set(queryResult.columns || []);
      const leftRows = queryResult.data || [];

      // 2) 校验占位符引用列存在
      const usedCols = getReferencedCols(question);
      for (const col of usedCols) {
        if (!leftColumns.has(col)) {
          throw new Error(
            `Column ${col} not found in the schema of the left operator. `
            + `Left schema: ${[...leftColumns]}. Used columns: ${[...usedCols]}.`,
          );
        }
      }

      // 3) 逐行并发抽取（对应 StructuredExtract.get_next，Promise 天然并发替代 task_processor）
      const substitute = buildPlaceholderSubstitutor(question.trim(), usedCols);
      const extractFieldNames = normalizedExtractSchema
        .map((f) => f.name).filter(Boolean);

      const settled = await Promise.allSettled(leftRows.map(async (row) => {
        for (const col of usedCols) {
          if (!(col in row)) {
            throw new Error(`Column ${col} not found in the row data. Row data: ${JSON.stringify(row)}.`);
          }
        }
        const usedPrompt = substitute(row);
        const extracted = await extractFieldsFromRow(usedPrompt, row, normalizedExtractSchema, context);
        return { ...row, ...extracted };
      }));

      const resRows = [];
      let failedRowCount = 0;
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled') {
          resRows.push(s.value);
        } else {
          // 不静默丢行：保留原 row，被抽取字段填 null，避免下游行数对不上
          logger.error(`Error extracting row ${i}: ${s.reason?.message ?? s.reason}`);
          failedRowCount += 1;
          const merged = { ...leftRows[i] };
          for (const fieldName of extractFieldNames) {
            if (merged[fieldName] === undefined) merged[fieldName] = null;
          }
          resRows.push(merged);
        }
      }

      const mergedRows = coalesceEntityFieldsByRecordId(resRows, normalizedExtractSchema);

      // 全军覆没时显式抛错，避免上游拿到表面成功但全空的结果
      if (leftRows.length && failedRowCount === leftRows.length) {
        throw new Error(`StructuredExtract: all ${leftRows.length} rows failed to extract`);
      }

      logger.info(
        `Summary: prompt=${question}, input_rows=${leftRows.length}, output_rows=${resRows.length}, `
        + `failed_rows=${failedRowCount}, extracted_fields=${JSON.stringify(extractFieldNames)}`,
      );

      // 结果列 = 左表列 ∪ 抽取字段
      const resultColumns = new Set(leftColumns);
      for (const f of extractFieldNames) resultColumns.add(f);
      for (const row of mergedRows) {
        for (const key of Object.keys(row || {})) resultColumns.add(key);
      }

      // 4) 二次清洗：按 schema 类型对抽取字段做强制类型转换（对应 _sanitize_result）
      sanitizedResult = SemanticExtractTool._sanitizeResult(
        { columns: resultColumns, rows: mergedRows },
        normalizedExtractSchema,
      );
    } catch (e) {
      logger.error(`Execute failed: ${e?.message ?? e}`, e);
      return Result.createError(t('语义抽取失败: {}', e?.message ?? e));
    }

    // 构造与下游兼容的 operator 描述对象（保留 source_name/table_name/schema 字段）
    const extractOperator = {
      nodetag: 'StructuredExtract',
      prompt: question.trim(),
      extract_schema: normalizedExtractSchema,
      source_name: intermediateDs?.datasource_name,
      table_name: resolvedTableName,
      schema: sanitizedResult.columns,
    };

    return Result.create(
      {
        operator: extractOperator,
        result: sanitizedResult,
        'sub-query': question,
      },
      t('查询执行成功'),
    );
  }

  // ---- 结果清洗（对应 _sanitize_result）：按 schema 类型转换抽取字段 ----
  static _sanitizeResult(table, extractSchema) {
    const rows = [];
    const resultColumns = new Set(table.columns || []);
    for (const row of table.rows || []) {
      const cleanRow = { ...row };
      for (const field of extractSchema) {
        const fieldName = field && field.name;
        if (!fieldName) continue;
        cleanRow[fieldName] = SemanticExtractTool._coerceValue(
          cleanRow[fieldName],
          field.type || 'string',
        );
        resultColumns.add(fieldName);
      }
      rows.push(cleanRow);
    }
    return { columns: resultColumns, rows };
  }

  // ---- 值类型强制（对应 _coerce_value） ----
  static _coerceValue(value, fieldType) {
    if (value === null || value === undefined) return null;

    const normalizedType = String(fieldType || 'string').trim().toLowerCase();
    if (normalizedType === 'string') {
      return typeof value === 'string' ? value : String(value);
    }
    if (normalizedType === 'boolean') {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', '是', '有'].includes(text)) return true;
      if (['false', '0', 'no', 'n', '否', '无'].includes(text)) return false;
      return value;
    }
    if (normalizedType === 'number') {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value;
      const text = String(value).trim().replace(/,/g, '');
      if (!text) return null;
      const exactPattern = /^[-+]?\d+(?:\.\d+)?$/;
      if (exactPattern.test(text)) {
        return text.includes('.') ? parseFloat(text) : parseInt(text, 10);
      }
      const m = text.match(/[-+]?\d+(?:\.\d+)?/);
      if (m) {
        const num = m[0];
        return num.includes('.') ? parseFloat(num) : parseInt(num, 10);
      }
    }
    return value;
  }
}

export default SemanticExtractTool;

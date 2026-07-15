// 迁移自 backend/api/services/schema_enhancement_service.py(generate_table_description)
//   + column_description_service.py:_generate_table_description
//
// 综合表的列(优先有描述的列)用 LLM 生成表级业务描述,写 table_metadata.description。
// 桌面版默认中文模板(TABLE_DESCRIPTION_TEMPLATE_ZH)。依赖列描述先生成(见 enrichConnection 编排)。

import { chat, ResponseExtractor } from '../core/llm.js';
import { query, queryOne } from '../../db.js';

const TABLE_CONCURRENCY = 3;

function parseExamples(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  try { const o = JSON.parse(raw); return Array.isArray(o) ? o : []; } catch { return []; }
}

/** 构造列信息文本(给表描述用,带类型/主键/描述/示例值)。 */
function formatColumnsInfo(columns) {
  return columns.map((c) => {
    let s = `- 列名: ${c.column_name}, 类型: ${c.data_type || ''}`;
    if (c.is_primary_key) s += ', 主键';
    if (c.description) s += `, 描述: ${c.description}`;
    const ev = parseExamples(c.example_values);
    if (ev.length) s += `, 示例值: ${ev.slice(0, 2).map(String).join(', ')}`;
    return s;
  }).join('\n');
}

/** 表描述 prompt(移植 TABLE_DESCRIPTION_TEMPLATE_ZH)。 */
function buildTablePrompt(table, columnsInfoText) {
  return `你是一个数据库专家,需要根据表的列信息综合分析生成表的业务描述。

## 数据库信息

## 表结构信息
表名:${table.table_name}
表类型:${table.table_type || 'TABLE'}

## 列信息
${columnsInfoText}

## 相关表信息(如果有)
无

## 任务要求

### 核心原则
1. **综合分析**:不要简单拼接列描述,而是综合分析所有列的业务含义,理解表的整体业务用途
2. **高度概括**:提取核心关键词和业务概念,生成简洁但全面的表描述
3. **去重合并**:如果多个列描述语义接近或重复,在表描述中合并为一个概念
4. **业务视角**:从业务角度描述表的用途,而不是技术细节

### 生成规则
- **核心业务识别**:分析所有列描述,识别表的业务主题、核心功能和主要用途
- **精准概括**:生成简洁精准的表描述,控制在100-200字以内,包含表的业务主题、核心用途与主要维度
- **高效表达**:优先描述核心指标,再描述维度;避免列举所有列;语义相近的列合并为统一概念

### 输出要求
- 精准高效(100-200字,不超过300字),完整反映表的业务用途和核心价值
- 使用业务术语,避免技术细节
- 避免"该表用于记录/存储"等模板化表达,直接描述业务内容

## 输出格式
请按照以下JSON格式返回结果:
{
    "description": "表的业务描述(高度概括,突出核心关键词)..."
}

请生成表的中文描述:`;
}

async function pool(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i]); }
  });
  await Promise.all(runners);
}

/**
 * 为某连接的表生成表描述(onlyEmpty=true 只补 description 为空的表)。
 * @param {string} connectionId
 * @param {{projectId?:string, tableIds?:string[]|null, onlyEmpty?:boolean}} [opts]
 * @returns {Promise<{tables:number, skipped?:string}>}
 */
export async function generateTableDescriptions(connectionId, { projectId = null, tableIds = null, onlyEmpty = true } = {}) {
  let tables = await query(
    `SELECT id, table_name, table_type, description FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [connectionId],
  ).catch(() => []);
  if (Array.isArray(tableIds) && tableIds.length) {
    const set = new Set(tableIds.map(String));
    tables = tables.filter((t) => set.has(String(t.id)));
  }
  if (onlyEmpty) tables = tables.filter((t) => !t.description || !String(t.description).trim());
  if (!tables.length) return { tables: 0 };

  let tCount = 0;
  await pool(tables, TABLE_CONCURRENCY, async (table) => {
    const columns = await query(
      `SELECT column_name, data_type, is_primary_key, description, example_values
         FROM column_metadata WHERE table_id=$1 AND deleted_at IS NULL`,
      [table.id],
    ).catch(() => []);
    if (!columns.length) return;
    // 优先喂有描述的列(对齐 Python);若全无描述则退而用全部列(带类型/示例值)做兜底。
    const described = columns.filter((c) => c.description && String(c.description).trim());
    const colsForPrompt = described.length ? described : columns;

    const prompt = buildTablePrompt(table, formatColumnsInfo(colsForPrompt));
    try {
      const resp = await chat(prompt, {
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500,
        project_id: projectId,
        call_site: 'schema_enhance_description',
      });
      // clean_llm_json_response 返回清洗后的 JSON 字符串,需自行 parse。
      const cleaned = ResponseExtractor.clean_llm_json_response(resp);
      let obj = null;
      try { obj = typeof cleaned === 'string' ? JSON.parse(cleaned) : cleaned; } catch { obj = null; }
      const desc = obj && typeof obj === 'object' ? obj.description : null;
      if (desc && String(desc).trim()) {
        await query(
          `UPDATE table_metadata SET description=$1, updated_at=now() WHERE id=$2`,
          [String(desc).trim(), table.id],
        ).catch(() => {});
        tCount += 1;
      }
    } catch (e) {
      console.warn(`[table_description] 表 ${table.table_name} 生成失败: ${e?.message ?? e}`);
    }
  });

  return { tables: tCount };
}

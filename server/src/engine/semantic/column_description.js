// 迁移自 backend/yiw_kernel/semantic_catalogs/database/column_description_service.py
//   + backend/api/services/schema_enhancement_service.py(表描述)
//
// 用 LLM 为某连接的每表每列生成业务描述,写 column_metadata.description / table_metadata.description。
// 桌面版默认中文模板。复用 core/llm.js chat()(response_format=json_object) + ResponseExtractor。
//
// 关键:描述是向量文本的输入,必须在 embedConnectionSchema 之前跑(见 enrichConnection 编排)。

import { chat, ResponseExtractor } from '../core/llm.js';
import { query, queryOne } from '../../db.js';

const BATCH_SIZE = 80;     // 每批列数(Python 500;桌面端调小避免单次 prompt 过长)
const TABLE_CONCURRENCY = 3; // 并发表数(对齐 Python asyncio.Semaphore(5),桌面端稍保守)

/** 解析 example_values(JSON 文本数组)→ 数组;非法返回 []。 */
function parseExamples(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  try { const o = JSON.parse(raw); return Array.isArray(o) ? o : []; } catch { return []; }
}

/** 构造列描述 prompt(移植 _build_column_description_prompt 中文模板)。 */
function buildColumnPrompt(conn, table, columnsInfo, columnsToGenerate, extraNotes) {
  const colsText = columnsInfo.map((ci) => {
    let s = `- 列名: ${ci.column_name}, 类型: ${ci.data_type || ''}`;
    if (ci.is_primary_key) s += ', 主键';
    if (ci.is_nullable === false || ci.is_nullable === 0) s += ', 非空';
    if (ci.description) s += `, 现有描述: ${ci.description}`;
    const ev = parseExamples(ci.example_values);
    if (ev.length) s += `, 示例值: ${ev.slice(0, 2).map(String).join(', ')}`;
    return s;
  }).join('\n');

  const hasNotes = !!(extraNotes && String(extraNotes).trim());
  const notesSection = hasNotes
    ? `\n## 用户补充说明\n以下是用户提供的关于该表的额外业务说明,请在生成描述时参考:\n${String(extraNotes).trim()}\n`
    : '';

  return `你是一个数据库专家,需要根据表结构信息和示例值为列生成业务描述。

## 数据库信息
数据库名称:${conn.name}
数据库类型:${conn.db_type}

## 表信息
表名:${table.table_name}
表类型:${table.table_type || 'TABLE'}
现有表描述:${table.description || '暂无描述'}
${notesSection}
## 列信息(包含已有描述的列,用于上下文)
${colsText}

## 任务要求
1. **需要生成描述的列**:${columnsToGenerate.join(', ')}
2. **已有描述的列**:如果列已有描述,请参考其描述风格和业务含义,保持一致性
3. **示例值参考**:请参考示例值来理解列的业务含义
4. **描述质量**:描述应该清晰、准确,符合业务场景,使用中文表达
5. **描述长度**:每个列的描述应该在10-50字之间,简洁明了${hasNotes ? '\n6. **用户说明**:请特别参考用户提供的补充说明来理解表的业务含义' : ''}

## 输出格式
请按照以下JSON格式返回结果:
{
    "column_descriptions": {
        "列名1": "列1的详细业务描述...",
        "列名2": "列2的详细业务描述..."
    }
}

请仅为需要生成描述的列生成描述,已有描述的列不需要包含在输出中。`;
}

/** 调 LLM 拿 {column_descriptions:{列名:描述}};失败返回 {}。 */
async function callColumnDescriptions(prompt, projectId) {
  try {
    const resp = await chat(prompt, {
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 4000,
      project_id: projectId,
      call_site: 'column_description',
    });
    // clean_llm_json_response 返回的是「清洗后的 JSON 字符串」,需自行 parse。
    const cleaned = ResponseExtractor.clean_llm_json_response(resp);
    let obj = null;
    try { obj = typeof cleaned === 'string' ? JSON.parse(cleaned) : cleaned; } catch { obj = null; }
    const descs = obj && typeof obj === 'object' ? (obj.column_descriptions || obj.columns || obj) : null;
    return descs && typeof descs === 'object' ? descs : {};
  } catch (e) {
    console.warn(`[column_description] LLM 调用失败: ${e?.message ?? e}`);
    return {};
  }
}

/** 简单并发池:对 items 以 limit 并发跑 worker。 */
async function pool(items, limit, worker) {
  const ret = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return ret;
}

/**
 * 为某连接生成列描述(只补 description 为空的列,onlyEmpty=true)。
 * @param {string} connectionId
 * @param {{projectId?:string, tableIds?:string[]|null, onlyEmpty?:boolean, extraNotes?:string|null}} [opts]
 * @returns {Promise<{tables:number, columns:number, skipped?:string}>}
 */
export async function generateColumnsDescriptions(connectionId, { projectId = null, tableIds = null, onlyEmpty = true, extraNotes = null } = {}) {
  const conn = await queryOne(
    `SELECT id, name, db_type FROM database_connections WHERE id=$1 AND deleted_at IS NULL`,
    [connectionId],
  ).catch(() => null);
  if (!conn) return { tables: 0, columns: 0, skipped: '连接不存在' };

  let tables = await query(
    `SELECT id, table_name, table_type, description FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [connectionId],
  ).catch(() => []);
  if (Array.isArray(tableIds) && tableIds.length) {
    const set = new Set(tableIds.map(String));
    tables = tables.filter((t) => set.has(String(t.id)));
  }
  if (!tables.length) return { tables: 0, columns: 0 };

  let tCount = 0; let cCount = 0;
  await pool(tables, TABLE_CONCURRENCY, async (table) => {
    const columns = await query(
      `SELECT id, column_name, data_type, is_primary_key, is_nullable, description, example_values
         FROM column_metadata WHERE table_id=$1 AND deleted_at IS NULL`,
      [table.id],
    ).catch(() => []);
    if (!columns.length) return;

    const toGen = onlyEmpty
      ? columns.filter((c) => !c.description || !String(c.description).trim())
      : columns;
    if (!toGen.length) return;

    let tableTouched = false;
    for (let i = 0; i < toGen.length; i += BATCH_SIZE) {
      const batch = toGen.slice(i, i + BATCH_SIZE);
      const prompt = buildColumnPrompt(conn, table, columns, batch.map((c) => c.column_name), extraNotes);
      const descs = await callColumnDescriptions(prompt, projectId);
      for (const c of batch) {
        const d = descs[c.column_name];
        if (d && String(d).trim()) {
          await query(
            `UPDATE column_metadata SET description=$1, updated_at=now() WHERE id=$2`,
            [String(d).trim(), c.id],
          ).catch(() => {});
          cCount += 1; tableTouched = true;
        }
      }
    }
    if (tableTouched) tCount += 1;
  });

  return { tables: tCount, columns: cCount };
}

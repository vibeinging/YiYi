/**
 * 为 table_metadata / column_metadata 生成 embedding 并存进各自 embedding 列(JSON 文本),
 * 供 schema_retrieval 的 vexdb_cosine_distance 向量召回。
 *
 * 文本构成:
 *  - 表:table_name + description + keywords
 *  - 列:column_name + description + example_values
 *
 * 用法:node scripts/build_vector_index.mjs [--all]
 *   默认只补 embedding 为空的行;--all 全量重建。
 * 幂等。embedding 模型走 EMBEDDING 类(text-embedding-v3)。
 */
import { query, queryOne, sqlite } from "../src/db.js";
import { embed, ModelConfigResolver } from "../src/engine/core/llm.js";

ModelConfigResolver.setProvider(async ({ category }) => {
  const m = await queryOne(
    `SELECT model_name, api_base, api_key FROM llm_models
      WHERE category = COALESCE($1,'PRIMARY') AND api_key IS NOT NULL AND deleted_at IS NULL LIMIT 1`,
    [category],
  );
  if (!m) throw new Error(`无 ${category} 模型`);
  return { model_name: m.model_name, api_base: m.api_base, api_key: m.api_key, category, supports_streaming: true, is_enabled: true, extra_config: {} };
});

const ALL = process.argv.includes("--all");
const BATCH = 16;

function jstr(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (s && (s[0] === "[" || s[0] === "{")) { try { const o = JSON.parse(s); return Array.isArray(o) ? o.join(" ") : Object.values(o).join(" "); } catch { return s; } }
    return s;
  }
  if (Array.isArray(v)) return v.join(" ");
  return String(v);
}

async function buildFor(table, idCol, textFn) {
  const where = ALL ? "deleted_at IS NULL" : "deleted_at IS NULL AND (embedding IS NULL OR embedding = '')";
  const rows = await query(`SELECT * FROM ${table} WHERE ${where}`);
  if (!rows.length) { console.log(`  ${table}: 无待处理行`); return 0; }
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const texts = chunk.map(textFn);
    let vecs;
    try { vecs = await embed(texts); } catch (e) { console.error(`  embed 失败(${table} batch ${i}): ${e.message}`); break; }
    const upd = sqlite.prepare(`UPDATE ${table} SET embedding = ?, embedding_model = 'text-embedding-v3', updated_at = ? WHERE ${idCol} = ?`);
    const now = new Date().toISOString();
    chunk.forEach((r, j) => { if (vecs[j]) { upd.run(JSON.stringify(vecs[j]), now, r[idCol]); done += 1; } });
    console.log(`  ${table}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  return done;
}

// 实体的可读文本来自 name + meta_data(JSON)里的 description/column_name/table_name
function entityText(r) {
  let meta = {};
  try { meta = typeof r.meta_data === "string" ? JSON.parse(r.meta_data) : (r.meta_data || {}); } catch { /* ignore */ }
  return [r.name, meta.description, meta.column_name, meta.table_name].filter(Boolean).join(" ").trim();
}

console.log("== 构建向量索引 ==", ALL ? "(全量)" : "(仅空)");
const built = {};
built.table_metadata = await buildFor("table_metadata", "id", (r) => `${jstr(r.table_name)} ${jstr(r.description)} ${jstr(r.keywords)}`.trim());
built.column_metadata = await buildFor("column_metadata", "id", (r) => `${jstr(r.column_name)} ${jstr(r.description)} ${jstr(r.example_values)}`.trim());
// 指标 / 指标视图:name + aliases + description
built.metric_definitions = await buildFor("metric_definitions", "id", (r) => `${jstr(r.name)} ${jstr(r.aliases)} ${jstr(r.description)}`.trim()).catch(() => 0);
built.metric_view_definitions = await buildFor("metric_view_definitions", "id", (r) => `${jstr(r.name)} ${jstr(r.aliases)} ${jstr(r.description)}`.trim()).catch(() => 0);
// 实体:name + meta_data 字段
built.entity_mappings = await buildFor("entity_mappings", "id", entityText).catch(() => 0);
// few-shot 样例:question + description
built.examples = await buildFor("examples", "id", (r) => `${jstr(r.question)} ${jstr(r.description)}`.trim()).catch(() => 0);

console.log("✅ 完成,各表写入 embedding 行数:", JSON.stringify(built));
process.exit(0);

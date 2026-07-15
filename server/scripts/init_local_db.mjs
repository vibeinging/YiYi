/**
 * 初始化本地 SQLite 库(桌面端下载即用的内置库)。
 *
 * 做三件事:
 *  1. 从远程 Vastbase 内省全部 55 张表的结构 → 在本地 SQLite 重建(类型映射,放宽 NOT NULL)
 *  2. 灌种子数据:全局配置表全量 + demo 项目(销售数据分析)子树
 *  3. 从 live sales.duckdb 内省 schema → 补登记 table_metadata/column_metadata
 *     (demo 连接在 Vastbase 里 0 行,等于补上"导入数据源"这步,使 schema 召回可用)
 *
 * 用法:node scripts/init_local_db.mjs   (输出库到 DB_SQLITE_PATH,默认 ~/.yiw/local.db)
 * 幂等:每次重建(DROP + CREATE)。
 */
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { duckSchema } from "../src/engine/datasources/duck.js";

const DB_PATH = process.env.DB_SQLITE_PATH || join(homedir(), ".yiw", "local.db");
const DEMO_PID = "7c4ad1e4-7faa-488a-93a7-39c14eff55c5";
const DEMO_DUCKDB = "/Users/Four/.yiw/demo/sales.duckdb";
const nowISO = () => new Date().toISOString();

const pool = new pg.Pool({
  host: process.env.SRC_DB_HOST || "192.168.130.66",
  port: Number(process.env.SRC_DB_PORT || 5432),
  user: process.env.SRC_DB_USER || "agentic_wjm",
  password: process.env.SRC_DB_PASSWORD || "agentic2025_wjm",
  database: process.env.SRC_DB_NAME || "agentic_wjm",
  max: 4,
});

// 重建本地库
mkdirSync(dirname(DB_PATH), { recursive: true });
for (const suf of ["", "-wal", "-shm"]) { try { rmSync(DB_PATH + suf); } catch { /* 不存在忽略 */ } }
const sdb = new DatabaseSync(DB_PATH);
sdb.exec("PRAGMA journal_mode = WAL;");
sdb.exec("PRAGMA foreign_keys = OFF;");

// ── 类型映射 PG → SQLite ──
function sqliteType(dataType) {
  const t = String(dataType || "").toLowerCase();
  if (t === "boolean") return "INTEGER";
  if (["smallint", "integer", "bigint"].includes(t)) return "INTEGER";
  if (["numeric", "decimal", "real", "double precision"].includes(t)) return "REAL";
  if (t === "bytea") return "BLOB";
  return "TEXT"; // uuid/varchar/text/json/jsonb/timestamp/date/array/floatvector…
}
function toSqliteVal(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "boolean") return v ? 1 : 0;
  if (t === "number" || t === "bigint" || t === "string") return v;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

async function listTables() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}
async function tableColumns(table) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return rows;
}
async function primaryKey(table) {
  const { rows } = await pool.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ($1)::regclass AND i.indisprimary`,
    [`public."${table}"`],
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => r.attname);
}

// ── PART A: 建表 ──
const tables = await listTables();
const colMap = {}; // table -> [colName]
for (const t of tables) {
  const cols = await tableColumns(t);
  colMap[t] = cols.map((c) => c.column_name);
  const pk = await primaryKey(t);
  const defs = cols.map((c) => `"${c.column_name}" ${sqliteType(c.data_type)}`);
  if (pk.length) defs.push(`PRIMARY KEY (${pk.map((c) => `"${c}"`).join(", ")})`);
  sdb.exec(`CREATE TABLE "${t}" (${defs.join(", ")});`);
}
console.log(`✓ 建表 ${tables.length} 张`);

// ── PART B: 灌数据 ──
async function copyRows(table, where = "", params = []) {
  if (!colMap[table]) return 0;
  let rows;
  try { ({ rows } = await pool.query(`SELECT * FROM "${table}" ${where}`, params)); }
  catch { return 0; }
  if (!rows.length) return 0;
  const cols = colMap[table].filter((c) => c in rows[0]);
  const ins = sdb.prepare(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  );
  for (const r of rows) ins.run(...cols.map((c) => toSqliteVal(r[c])));
  return rows.length;
}
const hasCol = (t, c) => (colMap[t] || []).includes(c);

let seeded = 0;
// 全局配置表(全量)
for (const t of ["companies", "users", "roles", "llm_models", "examples", "report_templates",
  "web_search_models", "project_model_configs",
  "business_api_keys", "alembic_version", "invite_links"]) {
  const n = await copyRows(t); seeded += n; if (n) console.log(`  ${t}: ${n}`);
}
// demo 项目本体
await copyRows("projects", "WHERE id = $1", [DEMO_PID]);
// 项目维度
for (const t of tables) {
  if (t === "projects" || !hasCol(t, "project_id")) continue;
  const n = await copyRows(t, "WHERE project_id = $1", [DEMO_PID]); if (n) { seeded += n; console.log(`  ${t}(by project): ${n}`); }
}
// 收集 demo 的 业务/连接/会话 ids
const bizIds = (await pool.query(`SELECT id FROM businesses WHERE project_id=$1`, [DEMO_PID])).rows.map((r) => r.id);
const connIds = (await pool.query(`SELECT id FROM database_connections WHERE project_id=$1`, [DEMO_PID])).rows.map((r) => r.id);
const sessIds = (await pool.query(`SELECT id FROM sessions WHERE project_id=$1`, [DEMO_PID])).rows.map((r) => r.id);
// 业务维度(project_id 缺失但有 business_id 的表)
for (const t of tables) {
  if (hasCol(t, "project_id") || !hasCol(t, "business_id")) continue;
  const n = await copyRows(t, "WHERE business_id::text = ANY($1::text[])", [bizIds]); if (n) { seeded += n; console.log(`  ${t}(by business): ${n}`); }
}
// 连接维度(table_metadata / relationship_metadata)
for (const t of tables) {
  if (hasCol(t, "project_id") || hasCol(t, "business_id") || !hasCol(t, "database_connection_id")) continue;
  const n = await copyRows(t, "WHERE database_connection_id::text = ANY($1::text[])", [connIds]); if (n) { seeded += n; console.log(`  ${t}(by conn): ${n}`); }
}
// 会话消息
if (sessIds.length) {
  for (const t of ["session_messages", "session_shares", "message_feedbacks"]) {
    if (!hasCol(t, "session_id")) continue;
    const n = await copyRows(t, "WHERE session_id::text = ANY($1::text[])", [sessIds]); if (n) { seeded += n; console.log(`  ${t}: ${n}`); }
  }
}
// entity_mappings / column_metadata 经父 id
const cfgIds = (await pool.query(`SELECT id FROM entity_mapping_configs WHERE business_id::text = ANY($1::text[])`, [bizIds]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
if (cfgIds.length && hasCol("entity_mappings", "config_id")) { const n = await copyRows("entity_mappings", "WHERE config_id::text = ANY($1::text[])", [cfgIds]); if (n) console.log(`  entity_mappings: ${n}`); }
const tmIds = (await pool.query(`SELECT id FROM table_metadata WHERE database_connection_id::text = ANY($1::text[])`, [connIds]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
if (tmIds.length && hasCol("column_metadata", "table_id")) { const n = await copyRows("column_metadata", "WHERE table_id::text = ANY($1::text[])", [tmIds]); if (n) console.log(`  column_metadata: ${n}`); }
console.log(`✓ 灌种子 ~${seeded} 行`);

// ── PART C: 从 live duckdb 补登记 demo schema(table_metadata 为空时)──
for (const connId of connIds) {
  const conn = (await pool.query(`SELECT db_type, database, host FROM database_connections WHERE id=$1`, [connId])).rows[0];
  if (!conn || String(conn.db_type).toLowerCase() !== "duckdb") continue;
  const path = conn.database || conn.host || DEMO_DUCKDB;
  const already = sdb.prepare(`SELECT count(*) c FROM table_metadata WHERE database_connection_id=?`).get(connId).c;
  if (already > 0) { console.log(`  conn ${connId} 已有 ${already} 表元数据,跳过`); continue; }
  let schema;
  try { schema = duckSchema(path); } catch (e) { console.log(`  duckSchema(${path}) 失败: ${e.message}`); continue; }
  const tmIns = sdb.prepare(`INSERT INTO table_metadata (id,database_connection_id,schema_name,table_name,table_type,is_view,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const cmIns = sdb.prepare(`INSERT INTO column_metadata (id,table_id,column_name,data_type,is_nullable,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  for (const tb of schema.tables || []) {
    const tmId = randomUUID(); const ts = nowISO();
    tmIns.run(tmId, connId, "main", tb.table, "BASE TABLE", 0, ts, ts);
    for (const c of tb.columns || []) cmIns.run(randomUUID(), tmId, c.name, c.type, 1, ts, ts);
    console.log(`  ✓ 登记表 ${tb.table}(${(tb.columns || []).length} 列)`);
  }
}

sdb.close();
await pool.end();
console.log(`\n✅ 本地库就绪: ${DB_PATH}`);
process.exit(0);

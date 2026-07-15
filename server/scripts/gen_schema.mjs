import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const db = new DatabaseSync(join(homedir(), '.yiw', 'local.db'), { readOnly: true });
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const parts = [
  '-- YiW 桌面端 本地 SQLite schema(内置 DDL,开机 CREATE TABLE IF NOT EXISTS 自建)',
  '-- 自动从 local.db 导出;脱离远程 Vastbase 依赖。共 ' + tables.length + ' 张表。',
  '-- 重新生成: node scripts/gen_schema.mjs',
  '',
];
for (const t of tables) {
  // CREATE TABLE "x" → CREATE TABLE IF NOT EXISTS "x"(幂等)
  let ddl = t.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
  parts.push(ddl.trim() + ';');
}
const out = join(process.cwd(), 'db', 'schema.sql');
import('node:fs').then(fs => { fs.mkdirSync(join(process.cwd(), 'db'), { recursive: true }); });
writeFileSync(out, parts.join('\n') + '\n', 'utf8');
console.log('生成', out, '—', tables.length, '表,', parts.join('\n').length, 'chars');

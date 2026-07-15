/**
 * 桌面端「内置主体 ID 固定化」迁移(一次性)。
 *
 * 背景:
 *   桌面端单用户(company + user 各一),但历史上 ensureBuiltinUser 每次查不到 local_user
 *   就 randomUUID() 新建,导致库内出现多个随机 id 的 company / user,以及挂在旧 id 上的
 *   孤儿数据(created_by / company_id 指向已不存在的旧 id)→ 「工作区有、对话查不到」。
 *
 *   详见 docs/reports/2026-06-25_app-workspace-no-conversation-bug.md。
 *
 * 本迁移做两件事:
 *   1) 把内置 company / user 的存量随机 id 改写为固定全零 id
 *      (DESKTOP_COMPANY_ID / DESKTOP_USER_ID,见 src/app/auth/desktop_ids.js),
 *      并把所有引用这些旧 id 的外键列一并改写到新 id(按"旧 id → 固定 id"映射)。
 *   2) 把所有指向「已不存在于 users 表的孤儿 userId」的 created_by/user_id 等,归并到固定 id。
 *
 *   二者合起来:迁移后库内 company/user 只剩固定全零 id,且所有引用一致。
 *
 * 引用列(自动扫描,按表实际列名命中):
 *   - company_id  → 映射到固定 company id(匹配旧 company id 之一)
 *   - created_by / user_id / deleted_by / updated_by / owner_id
 *     → 匹配旧 user id 之一则映射;不在 users 表的孤儿值则统一归并到固定 user id
 *
 * 用法:
 *   node scripts/migrate_desktop_ids.mjs            # dry-run,只打印将改什么
 *   node scripts/migrate_desktop_ids.mjs --apply     # 实际执行(单事务,失败回滚)
 *
 * 幂等:固定 id 化后,旧随机 id 已无引用,再跑扫描结果为 0。
 */
import { sqlite } from "../src/db.js";
import { DESKTOP_COMPANY_ID, DESKTOP_USER_ID, DESKTOP_USER_USERNAME } from "../src/app/auth/desktop_ids.js";

const APPLY = process.argv.includes("--apply");
const db = sqlite;
db.pragma("foreign_keys = OFF"); // 换主键 + 跨表更新,关外键更稳

// ── 1. 收集旧随机 id(当前库内除固定 id 外的内置主体)──
const oldCompanies = db
  .prepare(`SELECT id FROM companies WHERE id IS NOT NULL AND id != ?`)
  .all(DESKTOP_COMPANY_ID)
  .map((r) => r.id);
const oldUsers = db
  .prepare(`SELECT id FROM users WHERE id IS NOT NULL AND id != ?`)
  .all(DESKTOP_USER_ID)
  .map((r) => r.id);

console.log(`[migrate] 固定目标:company=${DESKTOP_COMPANY_ID}, user=${DESKTOP_USER_ID}`);
console.log(`[migrate] 旧随机 company id:${oldCompanies.length ? oldCompanies.join(", ") : "(无)"}`);
console.log(`[migrate] 旧随机 user id:${oldUsers.length ? oldUsers.join(", ") : "(无)"}`);

// ── 2. 扫描所有表,统计待改行(按列分类)──
const tableNames = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all()
  .map((t) => t.name);

// 用户引用列:匹配旧 user id 之一 → 映射;或为孤儿(NOT IN users) → 归并
const userRefCols = ["created_by", "user_id", "deleted_by", "updated_by", "owner_id"];
// 公司引用列:匹配旧 company id 之一 → 映射;或为孤儿(NOT IN companies) → 归并
const companyRefCols = ["company_id"];

// 判定:值是旧随机主体 id 之一,或孤儿(指向不存在的主体)
const matchOldCompany = (col) => {
  const ph = oldCompanies.map(() => "?").join(",");
  // 旧 company id 之一 OR 不在 companies 表的孤儿值
  return oldCompanies.length
    ? `"${col}" IN (${ph}) OR ("${col}" IS NOT NULL AND "${col}" NOT IN (SELECT id FROM companies))`
    : `("${col}" IS NOT NULL AND "${col}" NOT IN (SELECT id FROM companies))`;
};
const matchOldUser = (col) => {
  const ph = oldUsers.map(() => "?").join(",");
  return oldUsers.length
    ? `"${col}" IN (${ph}) OR ("${col}" IS NOT NULL AND "${col}" NOT IN (SELECT id FROM users))`
    : `("${col}" IS NOT NULL AND "${col}" NOT IN (SELECT id FROM users))`;
};

const plan = [];
for (const t of tableNames) {
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
  for (const col of companyRefCols) {
    if (!cols.includes(col)) continue;
    try {
      const cond = matchOldCompany(col);
      const params = oldCompanies.length ? [...oldCompanies] : [];
      const { c } = db.prepare(`SELECT count(*) c FROM "${t}" WHERE ${cond}`).get(...params);
      if (c > 0) plan.push({ t, col, count: c, kind: "company", cond, params });
    } catch {
      /* skip */
    }
  }
  for (const col of userRefCols) {
    if (!cols.includes(col)) continue;
    try {
      const cond = matchOldUser(col);
      const params = oldUsers.length ? [...oldUsers] : [];
      const { c } = db.prepare(`SELECT count(*) c FROM "${t}" WHERE ${cond}`).get(...params);
      if (c > 0) plan.push({ t, col, count: c, kind: "user", cond, params });
    } catch {
      /* skip */
    }
  }
}

// ── companies / users 主表自身也要改 id ──
const mainChanges = [];
if (oldCompanies.length) mainChanges.push({ table: "companies", ids: oldCompanies, to: DESKTOP_COMPANY_ID });
if (oldUsers.length) mainChanges.push({ table: "users", ids: oldUsers, to: DESKTOP_USER_ID });

const totalRef = plan.reduce((s, p) => s + p.count, 0);

if (!mainChanges.length && !totalRef) {
  console.log("\n[migrate] 已是固定 id,无待迁移行。");
  process.exit(0);
}

console.log(`\n[migrate] 外键引用待改 ${plan.length} 张表共 ${totalRef} 行:`);
for (const p of plan) console.log(`  ${p.t}.${p.col.padEnd(12)} = ${p.count} 行 (${p.kind})`);
if (mainChanges.length) console.log(`\n[migrate] 主表 id 改写:`);
for (const m of mainChanges) console.log(`  ${m.table}.id: ${m.ids.length} 行 → ${m.to}`);

if (!APPLY) {
  console.log("\n[migrate] dry-run 完成。加 --apply 实际执行(单事务,失败整体回滚)。");
  console.log("[migrate] ⚠️ 执行前请先备份:cp ~/.yiw/local.db ~/.yiw/local.db.bak.<时间>");
  process.exit(0);
}

// ── 3. 执行(单事务)──
// 顺序:先改所有外键引用(此时主表旧 id 还在,引用先归并到固定 id),再改主表 id。
// 关外键约束后改主键 id 不级联,故必须先改引用、后改主表,两步都把值置成固定 id。
const tx = db.transaction(() => {
  let refDone = 0;
  for (const { t, col, count, kind, cond, params } of plan) {
    const to = kind === "company" ? DESKTOP_COMPANY_ID : DESKTOP_USER_ID;
    const info = db.prepare(`UPDATE "${t}" SET "${col}"=? WHERE ${cond}`).run(to, ...params);
    console.log(`  ✓ ${t}.${col}: 更新 ${info.changes} 行(扫描 ${count}) → ${to}`);
    refDone += info.changes;
  }

  // 主表:把旧随机 id 的行 UPDATE 成固定 id。
  // 若固定 id 行已存在(INSERT OR IGNORE 建),旧行内容作废 → 直接删旧行(引用已迁走)。
  let mainDone = 0;
  for (const { table, ids, to } of mainChanges) {
    for (const oldId of ids) {
      // 固定 id 行是否已存在
      const exists = db.prepare(`SELECT 1 FROM "${table}" WHERE id=?`).get(to);
      if (exists) {
        // 旧行多余 → 删(外键引用已在前一步全改走,不会留下悬空引用)
        const del = db.prepare(`DELETE FROM "${table}" WHERE id=?`).run(oldId);
        console.log(`  ✓ ${table}: 固定 id 行已存在,删除旧随机行 ${oldId.slice(0, 8)}… (${del.changes} 行)`);
      } else {
        const upd = db.prepare(`UPDATE "${table}" SET id=? WHERE id=?`).run(to, oldId);
        console.log(`  ✓ ${table}: id ${oldId.slice(0, 8)}… → ${to} (${upd.changes} 行)`);
      }
      mainDone += 1;
    }
  }

  // 兜底:确保固定 id 的内置 company/user 一定存在(upsert,与 ensureBuiltinUser 同源)
  db.prepare(
    `INSERT INTO companies (id,name,code,is_active,created_at,updated_at)
     VALUES (?,'本地工作区','local',1,now(),now()) ON CONFLICT(id) DO NOTHING`,
  ).run(DESKTOP_COMPANY_ID);
  db.prepare(
    `INSERT INTO users (id,company_id,username,password_hash,full_name,is_admin,can_create_project,is_active,created_at,updated_at)
     VALUES (?,?,?,?,'本地用户',1,1,1,now(),now()) ON CONFLICT(id) DO NOTHING`,
  ).run(DESKTOP_USER_ID, DESKTOP_COMPANY_ID, DESKTOP_USER_USERNAME, "builtin-no-login");
  // ON CONFLICT DO NOTHING 不改已存在行的 username → 单独把固定 id 用户的 username 校正为新值
  const renamed = db.prepare(`UPDATE users SET username=? WHERE id=? AND username!=?`).run(
    DESKTOP_USER_USERNAME,
    DESKTOP_USER_ID,
    DESKTOP_USER_USERNAME,
  );
  if (renamed.changes) console.log(`  ✓ users.username: → '${DESKTOP_USER_USERNAME}' (${renamed.changes} 行)`);

  console.log(`\n[migrate] 完成:外键引用 ${refDone} 行,主表 id ${mainDone} 个已固定。`);
});

try {
  tx();
  console.log("[migrate] 已提交。重启 app 后内置主体恒为固定 id,历史对话/工作区稳定可见。");
} catch (e) {
  console.error("[migrate] 失败,已回滚:", e?.message || e);
  process.exit(1);
}

/**
 * 桌面端固定内置主体 ID(公司 + 用户)。
 *
 * 为什么写死:
 *   桌面端是单用户应用,登录用户恒为内置 owner。早期 ensureBuiltinUser 在每次查不到
 *   该用户时就 randomUUID() 新建一个,导致库里出现多个 userId,历史数据的 created_by /
 *   company_id / user_id 引用全部指向已不存在的旧用户 → 「工作区有、对话查不到」
 *   (详见 docs/reports/2026-06-25_app-workspace-no-conversation-bug.md)。
 *
 *   写死成全零固定 UUID 后:内置记录的 id 永远不变,所有 created_by / company_id / user_id
 *   引用也永远稳定,再不会产生孤儿数据。
 *
 * 用全零 UUID(00000000-0000-0000-0000-000000000000):
 *   - 合法的 UUID 格式(各迁移/校验按 UUID 语义处理不报错)
 *   - 形如「占位/默认」,语义清晰,一眼可辨是内置固定主体
 */
export const DESKTOP_COMPANY_ID = '00000000-0000-0000-0000-000000000000';
export const DESKTOP_USER_ID = '00000000-0000-0000-0000-000000000000';
export const DESKTOP_USER_USERNAME = 'owner';

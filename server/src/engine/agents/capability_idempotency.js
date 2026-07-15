import { createHash, randomUUID } from "node:crypto";
import { sqlite } from "../../db.js";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function capabilityRequestHash(input) {
  return createHash("sha256").update(JSON.stringify(stableValue(input || {}))).digest("hex");
}

function parseResponse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function claimCapabilityInvocation({ userId, projectId, operationId, idempotencyKey, input }) {
  const scope = String(projectId || "__global__");
  const requestHash = capabilityRequestHash(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  const inserted = sqlite.prepare(
    `INSERT OR IGNORE INTO capability_idempotency
      (id,user_id,project_scope,operation_id,idempotency_key,request_hash,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'pending',?,?)`,
  ).run(id, String(userId || ""), scope, operationId, idempotencyKey, requestHash, now, now);
  if (inserted.changes === 1) return { state: "claimed", id };

  const existing = sqlite.prepare(
    `SELECT * FROM capability_idempotency
      WHERE user_id=? AND project_scope=? AND operation_id=? AND idempotency_key=?`,
  ).get(String(userId || ""), scope, operationId, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) return { state: "conflict" };
    if (existing.status === "completed") return { state: "replay", result: parseResponse(existing.response_json) };
    if (existing.status === "pending") return { state: "in_progress" };
    sqlite.prepare(
      `UPDATE capability_idempotency SET status='pending', error_message=NULL, updated_at=? WHERE id=?`,
    ).run(new Date().toISOString(), existing.id);
    return { state: "claimed", id: existing.id };
  }
  return { state: "in_progress" };
}

export function completeCapabilityInvocation(id, result) {
  const now = new Date().toISOString();
  sqlite.prepare(
    `UPDATE capability_idempotency
      SET status='completed', response_json=?, error_message=NULL, completed_at=?, updated_at=? WHERE id=?`,
  ).run(JSON.stringify(result ?? null), now, now, id);
}

export function failCapabilityInvocation(id, error) {
  sqlite.prepare(
    `UPDATE capability_idempotency SET status='failed', error_message=?, updated_at=? WHERE id=?`,
  ).run(error?.message || String(error), new Date().toISOString(), id);
}

export function deleteCapabilityInvocation(id) {
  sqlite.prepare(`DELETE FROM capability_idempotency WHERE id=?`).run(id);
}

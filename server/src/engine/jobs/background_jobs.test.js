import assert from "node:assert/strict";
import test from "node:test";

import { sqlite } from "../../db.js";
import {
  cancelBackgroundJob,
  claimSessionBackgroundJobEvents,
  completeBackgroundJobEvents,
  classifyBackgroundJobError,
  createBackgroundJob,
  getBackgroundJob,
  scheduleBackgroundJobRetry,
  updateBackgroundJob,
  publishBackgroundJobEvent,
} from "./background_jobs.js";

test("后台错误区分临时、配置和永久失败", () => {
  assert.equal(classifyBackgroundJobError(Object.assign(new Error("请求 timeout"), { code: "ETIMEDOUT" })).category, "transient");
  assert.equal(classifyBackgroundJobError(new Error("未配置嵌入模型")).category, "configuration");
  assert.equal(classifyBackgroundJobError(new Error("不支持该文件格式")).category, "permanent");
});

test("retry_wait 到期后恢复同一个任务", async () => {
  const job = createBackgroundJob({ projectId: "retry-test", kind: "test_retry", resourceType: "test", resourceId: "one" });
  try {
    updateBackgroundJob(job.id, { status: "running", incrementAttempt: true });
    scheduleBackgroundJobRetry(job.id, async () => {
      updateBackgroundJob(job.id, { status: "completed", progress: 100, finished_at: new Date().toISOString() });
    }, { delayMs: 10 });
    assert.equal(getBackgroundJob(job.id).status, "retry_wait");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(getBackgroundJob(job.id).status, "completed");
  } finally {
    sqlite.prepare("DELETE FROM background_jobs WHERE id=?").run(job.id);
  }
});

test("用户取消后不会再执行等待中的重试", async () => {
  const job = createBackgroundJob({ projectId: "cancel-test", kind: "test_retry", resourceType: "test", resourceId: "two" });
  let resumed = false;
  try {
    scheduleBackgroundJobRetry(job.id, async () => { resumed = true; }, { delayMs: 15 });
    cancelBackgroundJob(job.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(resumed, false);
    assert.equal(getBackgroundJob(job.id).status, "cancelled");
  } finally {
    sqlite.prepare("DELETE FROM background_jobs WHERE id=?").run(job.id);
  }
});

test("同一终态事件只投递并消费一次", () => {
  const sid = `event-session-${Date.now()}`;
  const job = createBackgroundJob({ projectId: "event-test", sessionId: sid, kind: "test_event", resourceType: "test", resourceId: "three" });
  try {
    const completed = updateBackgroundJob(job.id, { status: "completed", progress: 100, finished_at: new Date().toISOString() });
    assert.equal(publishBackgroundJobEvent(completed), false);
    const first = claimSessionBackgroundJobEvents(sid);
    assert.equal(first.length, 1);
    assert.equal(claimSessionBackgroundJobEvents(sid).length, 0);
    completeBackgroundJobEvents(first.map((event) => event.id));
    assert.equal(claimSessionBackgroundJobEvents(sid).length, 0);
  } finally {
    sqlite.prepare("DELETE FROM background_job_events WHERE job_id=?").run(job.id);
    sqlite.prepare("DELETE FROM session_messages WHERE session_id=?").run(sid);
    sqlite.prepare("DELETE FROM background_jobs WHERE id=?").run(job.id);
  }
});

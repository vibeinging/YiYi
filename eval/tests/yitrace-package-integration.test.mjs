import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  __resetYiTraceDbForTest,
  __setYiTraceDbForTest,
  closeYiTraceDb,
  createTraceRecorder,
} from "../../server/src/app/traces/yitrace_service.js";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));

function currentNativePackageName() {
  if (process.platform === "darwin" && process.arch === "arm64") return "@yitrace/db-darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "@yitrace/db-darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "@yitrace/db-linux-arm64-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "@yitrace/db-linux-x64-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "@yitrace/db-win32-x64-msvc";
  return "";
}

test("@yitrace/db npm package opens, writes, and reads string trace ids", async (t) => {
  const nativePackage = currentNativePackageName();
  if (!nativePackage) {
    t.skip(`yiTrace native package is not declared for ${process.platform}-${process.arch}`);
    return;
  }
  try {
    requireFromServer.resolve(nativePackage);
  } catch {
    t.skip(`${nativePackage} is not installed for this Node runtime`);
    return;
  }

  const packageMain = requireFromServer.resolve("@yitrace/db");
  const packageJson = JSON.parse(await readFile(join(dirname(packageMain), "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.1.3");

  const { YiTraceDB, createSpanEventBuilder } = requireFromServer("@yitrace/db");
  assert.equal(typeof YiTraceDB?.open, "function");
  assert.equal(typeof createSpanEventBuilder, "function");

  const dataDir = await mkdtemp(join(tmpdir(), "yiw-yitrace-"));
  const db = await YiTraceDB.open({ dataDir, tenantId: 1 });
  try {
    const builder = createSpanEventBuilder({
      traceId: "run-package-integration",
      sessionId: "session-package-integration",
      tenantId: 1,
      attrs: {
        project_id: "yiw-package-test",
        skill: "trace-adapter",
        mode: "test",
      },
    });

    builder.startSpan({ spanId: "root", name: "root", inputText: "question" });
    builder.log({ spanId: "root", message: "trace log" });
    builder.endSpan({ spanId: "root", status: 0, outputText: "answer", durationNs: 1_000_000 });

    await builder.ingest(db);
    await db.flush();

    const trace = await db.trace("run-package-integration");
    const span = await db.span("run-package-integration", "root");
    const sessionPage = await db.sessions({
      attrs: { project_id: "yiw-package-test" },
      limit: 10,
    });

    assert.ok(trace);
    assert.equal(trace.spans?.length, 1);
    assert.equal(span?.externalSpanId || span?.external_span_id, "root");
    assert.ok((span?.logEvents || []).length >= 1);
    assert.equal((sessionPage.items || sessionPage.sessions || []).length, 1);
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("YiW recorder writes agent, LLM, and tool spans to yiTrace", async (t) => {
  const nativePackage = currentNativePackageName();
  if (!nativePackage) {
    t.skip(`yiTrace native package is not declared for ${process.platform}-${process.arch}`);
    return;
  }
  try {
    requireFromServer.resolve(nativePackage);
  } catch {
    t.skip(`${nativePackage} is not installed for this Node runtime`);
    return;
  }

  const { YiTraceDB } = requireFromServer("@yitrace/db");
  const dataDir = await mkdtemp(join(tmpdir(), "yiw-yitrace-recorder-"));
  const db = await YiTraceDB.open({ dataDir, tenantId: 1 });
  __setYiTraceDbForTest(db);

  try {
    const recorder = await createTraceRecorder({
      emit: () => {},
      projectId: "project-recorder-test",
      sessionId: "session-recorder-test",
      runId: "run-recorder-test",
      userId: "user-recorder-test",
      skill: "smart_query",
      question: "统计本月销售额",
    });

    const agentSpanId = recorder.recordAgentStart({
      name: "QueryAgent",
      input: "生成查询计划",
    });
    recorder.recordToolStart({
      toolCallId: "tool-call-1",
      name: "execute_sql",
      input: { sql: "select sum(amount) from sales" },
      parentSpanId: agentSpanId,
    });
    recorder.recordToolEnd({
      toolCallId: "tool-call-1",
      name: "execute_sql",
      output: { rows: [{ sum: 42 }] },
      durationMs: 5,
    });
    recorder.recordLlmCall({
      callSite: "query_answer",
      model: "test-model",
      input: "根据查询结果回答",
      output: "本月销售额为 42。",
      durationMs: 10,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });
    recorder.recordAgentEnd({
      spanId: agentSpanId,
      name: "QueryAgent",
      output: "本月销售额为 42。",
      durationMs: 20,
    });
    await recorder.finish();

    const trace = await db.trace("run-recorder-test");
    const spans = trace?.spans || [];
    assert.ok(trace);
    assert.ok(spans.some((span) => span.kind === "agent"));
    assert.ok(spans.some((span) => span.kind === "llm"));
    assert.ok(spans.some((span) => span.kind === "tool"));
    assert.ok(spans.some((span) => (span.externalSpanId || span.external_span_id) === "tool-call-1"));
  } finally {
    __resetYiTraceDbForTest();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("YiW yiTrace worker writes a trace that survives shutdown", async (t) => {
  const nativePackage = currentNativePackageName();
  if (!nativePackage) {
    t.skip(`yiTrace native package is not declared for ${process.platform}-${process.arch}`);
    return;
  }
  try {
    requireFromServer.resolve(nativePackage);
  } catch {
    t.skip(`${nativePackage} is not installed for this Node runtime`);
    return;
  }

  const { YiTraceDB } = requireFromServer("@yitrace/db");
  const dataDir = await mkdtemp(join(tmpdir(), "yiw-yitrace-worker-"));
  const previousDataDir = process.env.YIW_YITRACE_DIR;
  process.env.YIW_YITRACE_DIR = dataDir;
  __resetYiTraceDbForTest();

  try {
    const recorder = await createTraceRecorder({
      emit: () => {},
      projectId: "project-worker-test",
      sessionId: "session-worker-test",
      runId: "run-worker-test",
      question: "验证 worker 写入",
    });
    recorder.recordToolStart({
      toolCallId: "worker-tool-call",
      name: "worker_test_tool",
      input: "ping",
    });
    recorder.recordToolEnd({
      toolCallId: "worker-tool-call",
      name: "worker_test_tool",
      output: "pong",
      durationMs: 1,
    });
    await recorder.finish();
    await closeYiTraceDb();

    const db = await YiTraceDB.open({ dataDir, tenantId: 1 });
    try {
      const trace = await db.trace("run-worker-test");
      assert.ok(trace);
      assert.ok((trace.spans || []).some(
        (span) => (span.externalSpanId || span.external_span_id) === "worker-tool-call",
      ));
    } finally {
      await db.close();
    }
  } finally {
    await closeYiTraceDb();
    __resetYiTraceDbForTest();
    if (previousDataDir === undefined) delete process.env.YIW_YITRACE_DIR;
    else process.env.YIW_YITRACE_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  useChatStreamStore,
  type RetryStatus,
  type PermissionRequestState,
} from "./chatStreamStore";
import type { CanvasEvent } from "../api/canvas";

// Preserve the fresh initial state once so every test can reset cleanly.
const PRISTINE = useChatStreamStore.getState();

function resetStore() {
  // Clone mutable collections to avoid cross-test bleed through shared references.
  useChatStreamStore.setState({
    ...PRISTINE,
    activeTools: [],
    spawnAgents: [],
    collapsedAgents: new Set(),
    canvases: [],
    taskStreams: new Map(),
    longTask: { ...PRISTINE.longTask },
  });
}

describe("chatStreamStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("starts with empty buffers and idle flags", () => {
      const s = useChatStreamStore.getState();
      expect(s.loading).toBe(false);
      expect(s.streamingContent).toBe("");
      expect(s.streamingThinking).toBe("");
      expect(s.activeTools).toEqual([]);
      expect(s.spawnAgents).toEqual([]);
      expect(s.collapsedAgents.size).toBe(0);
      expect(s.toolIdCounter).toBe(0);
      expect(s.sessionId).toBe("");
      expect(s.claudeCode).toBeNull();
      expect(s.errorMessage).toBeNull();
      expect(s.retryStatus).toBeNull();
      expect(s.focusedTask).toBeNull();
      expect(s.activePermission).toBeNull();
      expect(s.canvases).toEqual([]);
      expect(s.taskStreams.size).toBe(0);
    });

    it("starts with default long-task snapshot", () => {
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.enabled).toBe(false);
      expect(lt.status).toBe("idle");
      expect(lt.currentRound).toBe(0);
      expect(lt.maxRounds).toBe(10);
      expect(lt.tokenBudget).toBe(1_000_000);
      expect(lt.budgetCostUsd).toBe(3.0);
      expect(lt.stopReason).toBeNull();
      expect(lt.startedAt).toBeNull();
    });
  });

  describe("setSessionId", () => {
    it("updates sessionId", () => {
      useChatStreamStore.getState().setSessionId("sess-42");
      expect(useChatStreamStore.getState().sessionId).toBe("sess-42");
    });

    it("overwrites any prior value", () => {
      useChatStreamStore.getState().setSessionId("a");
      useChatStreamStore.getState().setSessionId("b");
      expect(useChatStreamStore.getState().sessionId).toBe("b");
    });
  });

  describe("startStream", () => {
    it("flips loading true and clears prior buffers", () => {
      const s = useChatStreamStore.getState();
      s.appendChunk("stale");
      s.appendThinking("old");
      s.toolStart("Read", "preview");
      s.setRetryStatus({
        attempt: 1,
        max_retries: 3,
        delay_ms: 1000,
        error_type: "transient",
        provider: "anthropic",
      });
      s.startStream();
      const next = useChatStreamStore.getState();
      expect(next.loading).toBe(true);
      expect(next.streamingContent).toBe("");
      expect(next.streamingThinking).toBe("");
      expect(next.activeTools).toEqual([]);
      expect(next.spawnAgents).toEqual([]);
      expect(next.toolIdCounter).toBe(0);
      expect(next.claudeCode).toBeNull();
      expect(next.errorMessage).toBeNull();
      expect(next.retryStatus).toBeNull();
      expect(next.activePermission).toBeNull();
    });

    it("is idempotent when called on an already-fresh store", () => {
      const s = useChatStreamStore.getState();
      s.startStream();
      s.startStream();
      expect(useChatStreamStore.getState().loading).toBe(true);
      expect(useChatStreamStore.getState().streamingContent).toBe("");
    });
  });

  describe("appendChunk", () => {
    it("concatenates tokens onto streamingContent", () => {
      const { appendChunk } = useChatStreamStore.getState();
      appendChunk("hello");
      appendChunk(" ");
      appendChunk("world");
      expect(useChatStreamStore.getState().streamingContent).toBe("hello world");
    });

    it("handles empty strings without mutation", () => {
      const { appendChunk } = useChatStreamStore.getState();
      appendChunk("x");
      appendChunk("");
      expect(useChatStreamStore.getState().streamingContent).toBe("x");
    });
  });

  describe("appendThinking", () => {
    it("concatenates tokens onto streamingThinking", () => {
      const { appendThinking } = useChatStreamStore.getState();
      appendThinking("a");
      appendThinking("b");
      expect(useChatStreamStore.getState().streamingThinking).toBe("ab");
    });

    it("is independent from streamingContent", () => {
      const { appendThinking, appendChunk } = useChatStreamStore.getState();
      appendThinking("think");
      appendChunk("say");
      const s = useChatStreamStore.getState();
      expect(s.streamingThinking).toBe("think");
      expect(s.streamingContent).toBe("say");
    });
  });

  describe("toolStart / toolEnd", () => {
    it("toolStart assigns increasing ids and 'running' status", () => {
      const { toolStart } = useChatStreamStore.getState();
      toolStart("Read", "a.txt");
      toolStart("Edit", "b.txt");
      const tools = useChatStreamStore.getState().activeTools;
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ id: 1, name: "Read", status: "running", preview: "a.txt" });
      expect(tools[1]).toMatchObject({ id: 2, name: "Edit", status: "running", preview: "b.txt" });
      expect(useChatStreamStore.getState().toolIdCounter).toBe(2);
    });

    it("toolEnd flips the last matching running tool to 'done'", () => {
      const { toolStart, toolEnd } = useChatStreamStore.getState();
      toolStart("Read", "a");
      toolStart("Read", "b");
      toolEnd("Read", "done-b");
      const tools = useChatStreamStore.getState().activeTools;
      // LIFO: second Read closes first.
      expect(tools[0].status).toBe("running");
      expect(tools[1].status).toBe("done");
      expect(tools[1].resultPreview).toBe("done-b");
    });

    it("toolEnd is a no-op when tool name is not running", () => {
      const { toolStart, toolEnd } = useChatStreamStore.getState();
      toolStart("Read", "a");
      toolEnd("Nonexistent", "whatever");
      expect(useChatStreamStore.getState().activeTools[0].status).toBe("running");
    });

    it("toolEnd with empty preview leaves resultPreview undefined", () => {
      const { toolStart, toolEnd } = useChatStreamStore.getState();
      toolStart("Read", "a");
      toolEnd("Read", "");
      const t = useChatStreamStore.getState().activeTools[0];
      expect(t.status).toBe("done");
      expect(t.resultPreview).toBeUndefined();
    });
  });

  describe("endStream / endStreamWithError / resetStream / resetStreamContent / clearStreamState", () => {
    it("endStream clears loading + claudeCode + permission", () => {
      const s = useChatStreamStore.getState();
      s.startStream();
      s.claudeCodeStart("/tmp");
      s.showPermission({
        requestId: "r1",
        permissionType: "fs",
        path: "/tmp/x",
        parentFolder: "/tmp",
        reason: "read",
        riskLevel: "low",
        status: "pending",
      });
      s.endStream();
      const next = useChatStreamStore.getState();
      expect(next.loading).toBe(false);
      expect(next.claudeCode).toBeNull();
      expect(next.activePermission).toBeNull();
    });

    it("endStreamWithError sets errorMessage + clears retry/claudeCode", () => {
      const s = useChatStreamStore.getState();
      s.startStream();
      s.setRetryStatus({
        attempt: 2,
        max_retries: 3,
        delay_ms: 500,
        error_type: "rate_limited",
        provider: "anthropic",
      });
      s.claudeCodeStart("/tmp");
      s.endStreamWithError("boom");
      const next = useChatStreamStore.getState();
      expect(next.loading).toBe(false);
      expect(next.errorMessage).toBe("boom");
      expect(next.retryStatus).toBeNull();
      expect(next.claudeCode).toBeNull();
    });

    it("resetStreamContent only blanks the two text buffers", () => {
      const s = useChatStreamStore.getState();
      s.appendChunk("a");
      s.appendThinking("b");
      s.toolStart("Read", "x");
      s.resetStreamContent();
      const next = useChatStreamStore.getState();
      expect(next.streamingContent).toBe("");
      expect(next.streamingThinking).toBe("");
      // Tools preserved.
      expect(next.activeTools).toHaveLength(1);
    });

    it("resetStream clears content + tools + spawn + claudeCode + error but keeps session", () => {
      const s = useChatStreamStore.getState();
      s.setSessionId("keep-me");
      s.appendChunk("x");
      s.toolStart("Read", "a");
      s.spawnStart([{ name: "A", task: "t" }]);
      s.endStreamWithError("err");
      s.resetStream();
      const next = useChatStreamStore.getState();
      expect(next.sessionId).toBe("keep-me");
      expect(next.loading).toBe(false);
      expect(next.streamingContent).toBe("");
      expect(next.activeTools).toEqual([]);
      expect(next.spawnAgents).toEqual([]);
      expect(next.errorMessage).toBeNull();
    });

    it("clearStreamState blanks buffers + tools + canvases + claudeCode", () => {
      const s = useChatStreamStore.getState();
      s.appendChunk("x");
      s.toolStart("Read", "a");
      s.addCanvas({
        canvas_id: "c1",
        session_id: "sess",
        components: [],
      } as CanvasEvent);
      s.claudeCodeStart("/tmp");
      s.clearStreamState();
      const next = useChatStreamStore.getState();
      expect(next.streamingContent).toBe("");
      expect(next.streamingThinking).toBe("");
      expect(next.activeTools).toEqual([]);
      expect(next.canvases).toEqual([]);
      expect(next.claudeCode).toBeNull();
    });
  });

  describe("setRetryStatus", () => {
    it("sets a RetryStatus object", () => {
      const rs: RetryStatus = {
        attempt: 1,
        max_retries: 3,
        delay_ms: 1000,
        error_type: "transient",
        provider: "anthropic",
      };
      useChatStreamStore.getState().setRetryStatus(rs);
      expect(useChatStreamStore.getState().retryStatus).toEqual(rs);
    });

    it("accepts null to clear", () => {
      const s = useChatStreamStore.getState();
      s.setRetryStatus({
        attempt: 1,
        max_retries: 3,
        delay_ms: 100,
        error_type: "transient",
        provider: "anthropic",
      });
      s.setRetryStatus(null);
      expect(useChatStreamStore.getState().retryStatus).toBeNull();
    });
  });

  describe("canvas actions", () => {
    const ev: CanvasEvent = { canvas_id: "c1", session_id: "sess", components: [] };

    it("addCanvas appends in order", () => {
      const { addCanvas } = useChatStreamStore.getState();
      addCanvas(ev);
      addCanvas({ ...ev, canvas_id: "c2" });
      const list = useChatStreamStore.getState().canvases;
      expect(list.map((c) => c.canvas_id)).toEqual(["c1", "c2"]);
    });

    it("clearCanvases empties the list", () => {
      const s = useChatStreamStore.getState();
      s.addCanvas(ev);
      s.clearCanvases();
      expect(useChatStreamStore.getState().canvases).toEqual([]);
    });
  });

  describe("claude code lifecycle", () => {
    it("claudeCodeStart initializes active state", () => {
      useChatStreamStore.getState().claudeCodeStart("/work");
      const cc = useChatStreamStore.getState().claudeCode;
      expect(cc).not.toBeNull();
      expect(cc?.active).toBe(true);
      expect(cc?.content).toBe("");
      expect(cc?.workingDir).toBe("/work");
      expect(cc?.subTools).toEqual([]);
    });

    it("claudeCodeTextDelta appends when active, no-op when null", () => {
      const s = useChatStreamStore.getState();
      s.claudeCodeTextDelta("nope"); // no active session yet
      expect(useChatStreamStore.getState().claudeCode).toBeNull();
      s.claudeCodeStart("/w");
      s.claudeCodeTextDelta("hello ");
      s.claudeCodeTextDelta("world");
      expect(useChatStreamStore.getState().claudeCode?.content).toBe("hello world");
    });

    it("claudeCodeTextDelta truncates content beyond 50_000 chars", () => {
      const s = useChatStreamStore.getState();
      s.claudeCodeStart("/w");
      s.claudeCodeTextDelta("A".repeat(40_000));
      s.claudeCodeTextDelta("B".repeat(20_000));
      const cc = useChatStreamStore.getState().claudeCode!;
      expect(cc.content.startsWith("...(earlier output truncated)")).toBe(true);
      // Kept the last 50_000 chars.
      expect(cc.content.length).toBeLessThanOrEqual(50_000 + "...(earlier output truncated)\n".length);
      expect(cc.content.endsWith("B".repeat(1000))).toBe(true);
    });

    it("claudeCodeToolStart/End tracks subtool status", () => {
      const s = useChatStreamStore.getState();
      s.claudeCodeStart("/w");
      s.claudeCodeToolStart("Bash");
      s.claudeCodeToolStart("Bash");
      s.claudeCodeToolEnd("Bash");
      const sub = useChatStreamStore.getState().claudeCode!.subTools;
      expect(sub[0].status).toBe("running");
      expect(sub[1].status).toBe("done");
    });

    it("claudeCodeToolStart is no-op when no active claudeCode", () => {
      useChatStreamStore.getState().claudeCodeToolStart("Bash");
      expect(useChatStreamStore.getState().claudeCode).toBeNull();
    });

    it("claudeCodeToolEnd is no-op when no active claudeCode", () => {
      useChatStreamStore.getState().claudeCodeToolEnd("Bash");
      expect(useChatStreamStore.getState().claudeCode).toBeNull();
    });

    it("claudeCodeDone flips active=false but preserves content", () => {
      const s = useChatStreamStore.getState();
      s.claudeCodeStart("/w");
      s.claudeCodeTextDelta("keep");
      s.claudeCodeDone();
      const cc = useChatStreamStore.getState().claudeCode!;
      expect(cc.active).toBe(false);
      expect(cc.content).toBe("keep");
    });

    it("claudeCodeDone is a no-op when null", () => {
      useChatStreamStore.getState().claudeCodeDone();
      expect(useChatStreamStore.getState().claudeCode).toBeNull();
    });
  });

  describe("spawn agents", () => {
    it("spawnStart seeds agents with running status", () => {
      useChatStreamStore.getState().spawnStart([
        { name: "A", task: "alpha" },
        { name: "B", task: "beta" },
      ]);
      const agents = useChatStreamStore.getState().spawnAgents;
      expect(agents).toHaveLength(2);
      expect(agents[0]).toMatchObject({ name: "A", task: "alpha", status: "running", content: "", tools: [] });
      expect(useChatStreamStore.getState().collapsedAgents.size).toBe(0);
    });

    it("spawnAgentChunk appends to the matching agent only", () => {
      const s = useChatStreamStore.getState();
      s.spawnStart([
        { name: "A", task: "a" },
        { name: "B", task: "b" },
      ]);
      s.spawnAgentChunk("A", "hi ");
      s.spawnAgentChunk("A", "there");
      s.spawnAgentChunk("B", "x");
      const [a, b] = useChatStreamStore.getState().spawnAgents;
      expect(a.content).toBe("hi there");
      expect(b.content).toBe("x");
    });

    it("spawnAgentChunk ignores unknown agents", () => {
      const s = useChatStreamStore.getState();
      s.spawnStart([{ name: "A", task: "a" }]);
      s.spawnAgentChunk("ghost", "blah");
      expect(useChatStreamStore.getState().spawnAgents[0].content).toBe("");
    });

    it("spawnAgentTool start then end toggles tool status", () => {
      const s = useChatStreamStore.getState();
      s.spawnStart([{ name: "A", task: "a" }]);
      s.spawnAgentTool("A", "start", "Read", "prev");
      s.spawnAgentTool("A", "end", "Read", "final");
      const tool = useChatStreamStore.getState().spawnAgents[0].tools[0];
      expect(tool.status).toBe("done");
      expect(tool.preview).toBe("final");
    });

    it("spawnAgentTool end keeps the original preview when new is empty", () => {
      const s = useChatStreamStore.getState();
      s.spawnStart([{ name: "A", task: "a" }]);
      s.spawnAgentTool("A", "start", "Read", "orig");
      s.spawnAgentTool("A", "end", "Read", "");
      expect(useChatStreamStore.getState().spawnAgents[0].tools[0].preview).toBe("orig");
    });

    it("spawnAgentComplete marks one agent complete and collapses it", () => {
      const s = useChatStreamStore.getState();
      s.spawnStart([
        { name: "A", task: "a" },
        { name: "B", task: "b" },
      ]);
      s.spawnAgentComplete("A");
      const state = useChatStreamStore.getState();
      expect(state.spawnAgents[0].status).toBe("complete");
      expect(state.spawnAgents[1].status).toBe("running");
      expect(state.collapsedAgents.has("A")).toBe(true);
    });

    it("spawnComplete completes all remaining running agents", () => {
      const s = useChatStreamStore.getState();
      s.spawnStart([
        { name: "A", task: "a" },
        { name: "B", task: "b" },
      ]);
      s.spawnAgentComplete("A");
      s.spawnComplete();
      const agents = useChatStreamStore.getState().spawnAgents;
      expect(agents.every((a) => a.status === "complete")).toBe(true);
    });

    it("toggleCollapseAgent flips membership", () => {
      const s = useChatStreamStore.getState();
      s.toggleCollapseAgent("A");
      expect(useChatStreamStore.getState().collapsedAgents.has("A")).toBe(true);
      s.toggleCollapseAgent("A");
      expect(useChatStreamStore.getState().collapsedAgents.has("A")).toBe(false);
    });
  });

  describe("long task", () => {
    it("setLongTaskEnabled=true flips flag without wiping config", () => {
      const s = useChatStreamStore.getState();
      s.setLongTaskConfig({ maxRounds: 20, tokenBudget: 660_000 });
      s.setLongTaskEnabled(true);
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.enabled).toBe(true);
      expect(lt.maxRounds).toBe(20);
      expect(lt.tokenBudget).toBe(660_000);
    });

    it("setLongTaskEnabled=false resets runtime fields but preserves config", () => {
      const s = useChatStreamStore.getState();
      s.setLongTaskEnabled(true);
      s.longTaskRoundStart(2, 10);
      s.longTaskRoundComplete(2, 500);
      s.setLongTaskEnabled(false);
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.enabled).toBe(false);
      expect(lt.status).toBe("idle");
      expect(lt.currentRound).toBe(0);
      expect(lt.tokensUsed).toBe(0);
      expect(lt.estimatedCostUsd).toBe(0);
      expect(lt.startedAt).toBeNull();
    });

    it("setLongTaskConfig computes budgetCostUsd from tokenBudget", () => {
      useChatStreamStore.getState().setLongTaskConfig({ tokenBudget: 660_000 });
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.tokenBudget).toBe(660_000);
      expect(lt.budgetCostUsd).toBeCloseTo(2, 5);
    });

    it("setLongTaskConfig only updating maxRounds leaves budget untouched", () => {
      const before = useChatStreamStore.getState().longTask.tokenBudget;
      useChatStreamStore.getState().setLongTaskConfig({ maxRounds: 25 });
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.maxRounds).toBe(25);
      expect(lt.tokenBudget).toBe(before);
    });

    it("longTaskRoundStart sets status=running and stamps startedAt once", () => {
      const s = useChatStreamStore.getState();
      s.longTaskRoundStart(1, 5);
      const first = useChatStreamStore.getState().longTask.startedAt;
      expect(first).not.toBeNull();
      s.longTaskRoundStart(2, 5);
      const second = useChatStreamStore.getState().longTask.startedAt;
      expect(second).toBe(first); // preserved
      expect(useChatStreamStore.getState().longTask.currentRound).toBe(2);
    });

    it("longTaskRoundComplete updates tokens + cost", () => {
      const s = useChatStreamStore.getState();
      s.longTaskRoundStart(1, 5);
      s.longTaskRoundComplete(1, 330_000);
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.tokensUsed).toBe(330_000);
      expect(lt.estimatedCostUsd).toBeCloseTo(1, 5);
    });

    it("longTaskFinished maps reason to status", () => {
      const s = useChatStreamStore.getState();
      s.longTaskFinished("task_complete");
      expect(useChatStreamStore.getState().longTask.status).toBe("completed");
      s.longTaskFinished("user_cancelled");
      expect(useChatStreamStore.getState().longTask.status).toBe("stopped");
      expect(useChatStreamStore.getState().longTask.stopReason).toBe("user_cancelled");
    });

    it("longTaskReset restores runtime but keeps enabled + config", () => {
      const s = useChatStreamStore.getState();
      s.setLongTaskEnabled(true);
      s.setLongTaskConfig({ maxRounds: 12, tokenBudget: 660_000 });
      s.longTaskRoundStart(3, 12);
      s.longTaskRoundComplete(3, 500);
      s.longTaskFinished("budget_exhausted");
      s.longTaskReset();
      const lt = useChatStreamStore.getState().longTask;
      expect(lt.enabled).toBe(true);
      expect(lt.maxRounds).toBe(12);
      expect(lt.tokenBudget).toBe(660_000);
      expect(lt.status).toBe("idle");
      expect(lt.currentRound).toBe(0);
      expect(lt.tokensUsed).toBe(0);
      expect(lt.stopReason).toBeNull();
      expect(lt.startedAt).toBeNull();
    });
  });

  describe("taskStream map actions", () => {
    it("taskStreamStart seeds an entry", () => {
      useChatStreamStore.getState().taskStreamStart("t1");
      const ts = useChatStreamStore.getState().taskStreams.get("t1")!;
      expect(ts.loading).toBe(true);
      expect(ts.streamingContent).toBe("");
      expect(ts.activeTools).toEqual([]);
      expect(ts.toolIdCounter).toBe(0);
    });

    it("taskStreamAppendChunk appends when taskId exists, no-op otherwise", () => {
      const s = useChatStreamStore.getState();
      s.taskStreamStart("t1");
      s.taskStreamAppendChunk("t1", "hello ");
      s.taskStreamAppendChunk("t1", "world");
      s.taskStreamAppendChunk("missing", "x"); // no-op
      expect(useChatStreamStore.getState().taskStreams.get("t1")!.streamingContent).toBe("hello world");
      expect(useChatStreamStore.getState().taskStreams.has("missing")).toBe(false);
    });

    it("taskStreamToolStart / taskStreamToolEnd track per-task tools", () => {
      const s = useChatStreamStore.getState();
      s.taskStreamStart("t1");
      s.taskStreamToolStart("t1", "Read", "p");
      s.taskStreamToolEnd("t1", "Read", "res");
      const tool = useChatStreamStore.getState().taskStreams.get("t1")!.activeTools[0];
      expect(tool.status).toBe("done");
      expect(tool.resultPreview).toBe("res");
    });

    it("taskStreamToolStart on unknown task is a no-op", () => {
      useChatStreamStore.getState().taskStreamToolStart("ghost", "Read", "x");
      expect(useChatStreamStore.getState().taskStreams.size).toBe(0);
    });

    it("taskStreamEnd flips loading=false", () => {
      const s = useChatStreamStore.getState();
      s.taskStreamStart("t1");
      s.taskStreamEnd("t1");
      expect(useChatStreamStore.getState().taskStreams.get("t1")!.loading).toBe(false);
    });

    it("taskStreamEnd on unknown task is a no-op", () => {
      useChatStreamStore.getState().taskStreamEnd("ghost");
      expect(useChatStreamStore.getState().taskStreams.size).toBe(0);
    });

    it("taskStreamRemove deletes the entry", () => {
      const s = useChatStreamStore.getState();
      s.taskStreamStart("t1");
      s.taskStreamRemove("t1");
      expect(useChatStreamStore.getState().taskStreams.has("t1")).toBe(false);
    });
  });

  describe("permission gate", () => {
    const req: PermissionRequestState = {
      requestId: "r1",
      permissionType: "fs_read",
      path: "/tmp/file",
      parentFolder: "/tmp",
      reason: "read file",
      riskLevel: "low",
      status: "pending",
    };

    it("showPermission stores the request", () => {
      useChatStreamStore.getState().showPermission(req);
      expect(useChatStreamStore.getState().activePermission).toEqual(req);
    });

    it("resolvePermission updates status when a request exists", () => {
      const s = useChatStreamStore.getState();
      s.showPermission(req);
      s.resolvePermission("approved");
      expect(useChatStreamStore.getState().activePermission?.status).toBe("approved");
    });

    it("resolvePermission is a no-op when there is no active request", () => {
      useChatStreamStore.getState().resolvePermission("denied");
      expect(useChatStreamStore.getState().activePermission).toBeNull();
    });
  });

  describe("focus task", () => {
    it("focusTask stores the focus tuple, unfocusTask clears it", () => {
      const s = useChatStreamStore.getState();
      s.focusTask("t1", "Build rocket", "sess-1");
      expect(useChatStreamStore.getState().focusedTask).toEqual({
        taskId: "t1",
        taskName: "Build rocket",
        sessionId: "sess-1",
      });
      s.unfocusTask();
      expect(useChatStreamStore.getState().focusedTask).toBeNull();
    });

    it("focusTask overwrites any prior focus", () => {
      const s = useChatStreamStore.getState();
      s.focusTask("a", "A", "s1");
      s.focusTask("b", "B", "s2");
      expect(useChatStreamStore.getState().focusedTask?.taskId).toBe("b");
    });
  });

  describe("recoverFromSnapshot", () => {
    it("rehydrates streaming text, tools, and spawn agents from a snapshot", () => {
      useChatStreamStore.getState().recoverFromSnapshot({
        accumulated_text: "recovered",
        tools: [
          { name: "Read", status: "running", preview: "a.txt" },
          { name: "Bash", status: "done" },
        ],
        spawn_agents: [
          {
            name: "worker",
            task: "do it",
            status: "running",
            content: "partial",
            tools: [{ name: "Read", status: "done", preview: "log" }],
          },
        ],
      });
      const s = useChatStreamStore.getState();
      expect(s.loading).toBe(true);
      expect(s.streamingContent).toBe("recovered");
      expect(s.activeTools).toHaveLength(2);
      expect(s.activeTools[0]).toMatchObject({ id: 1, name: "Read", status: "running", preview: "a.txt" });
      expect(s.toolIdCounter).toBe(2);
      expect(s.spawnAgents).toHaveLength(1);
      expect(s.spawnAgents[0]).toMatchObject({
        name: "worker",
        task: "do it",
        status: "running",
        content: "partial",
      });
      expect(s.spawnAgents[0].tools[0]).toMatchObject({
        name: "Read",
        status: "done",
        preview: "log",
      });
    });

    it("handles an empty snapshot", () => {
      useChatStreamStore.getState().recoverFromSnapshot({
        accumulated_text: "",
        tools: [],
        spawn_agents: [],
      });
      const s = useChatStreamStore.getState();
      expect(s.loading).toBe(true);
      expect(s.streamingContent).toBe("");
      expect(s.activeTools).toEqual([]);
      expect(s.spawnAgents).toEqual([]);
      expect(s.toolIdCounter).toBe(0);
    });
  });
});

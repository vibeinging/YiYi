import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke, expectInvokedWith } from "../test-utils/mockTauri";
import { useTaskSidebarStore } from "./taskSidebarStore";
import type { TaskInfo } from "../api/tasks";

// Snapshot the pristine initial state once.
const PRISTINE = useTaskSidebarStore.getState();

function resetStore() {
  useTaskSidebarStore.setState({
    ...PRISTINE,
    tasks: [],
    cronJobs: [],
    newlyCreatedTaskIds: new Set(),
    selectedTaskId: null,
    pendingSessionId: null,
    pendingNewTab: null,
    pendingTabNotify: null,
    sidebarCollapsed: false,
  });
}

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: "t-1",
    title: "Build",
    description: null,
    status: "pending",
    sessionId: "s-1",
    parentSessionId: null,
    plan: null,
    currentStage: 0,
    totalStages: 3,
    progress: 0,
    errorMessage: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    completedAt: null,
    taskType: "long",
    pinned: false,
    lastActivityAt: 2_000,
    workspacePath: "/tmp/ws",
    ...overrides,
  };
}

describe("taskSidebarStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("starts with empty collections and default UI flags", () => {
      const s = useTaskSidebarStore.getState();
      expect(s.tasks).toEqual([]);
      expect(s.cronJobs).toEqual([]);
      expect(s.selectedTaskId).toBeNull();
      expect(s.sidebarCollapsed).toBe(false);
      expect(s.pendingSessionId).toBeNull();
      expect(s.pendingNewTab).toBeNull();
      expect(s.pendingTabNotify).toBeNull();
      expect(s.newlyCreatedTaskIds).toBeInstanceOf(Set);
      expect(s.newlyCreatedTaskIds.size).toBe(0);
    });

    it("exposes every documented action", () => {
      const s = useTaskSidebarStore.getState();
      for (const k of [
        "loadTasks",
        "loadCronJobs",
        "navigateToSession",
        "consumePendingSession",
        "addPendingNewTab",
        "consumePendingNewTab",
        "notifyTab",
        "consumeTabNotify",
        "addOrRefreshTask",
        "updateTaskProgress",
        "updateTaskStatus",
        "removeTask",
        "selectTask",
        "toggleSidebar",
        "pinTask",
        "unpinTask",
        "deleteTask",
        "markNewTask",
        "clearNewTask",
      ] as const) {
        expect(typeof s[k]).toBe("function");
      }
    });
  });

  describe("loadTasks", () => {
    it("invokes list_tasks and stores a descending lastActivityAt-sorted list", async () => {
      const older = makeTask({ id: "older", lastActivityAt: 1_000 });
      const newer = makeTask({ id: "newer", lastActivityAt: 5_000 });
      mockInvoke({ list_tasks: () => [older, newer] });

      await useTaskSidebarStore.getState().loadTasks();
      const s = useTaskSidebarStore.getState();
      expect(s.tasks.map((t) => t.id)).toEqual(["newer", "older"]);
      expectInvokedWith("list_tasks", {
        parentSessionId: undefined,
        status: undefined,
      });
    });

    it("swallows backend errors and preserves existing tasks", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useTaskSidebarStore.setState({ tasks: [makeTask()] });
      mockInvoke({
        list_tasks: () => {
          throw new Error("boom");
        },
      });
      await useTaskSidebarStore.getState().loadTasks();
      expect(useTaskSidebarStore.getState().tasks).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("loadCronJobs", () => {
    it("invokes list_cronjobs, maps to briefs, filters disabled jobs", async () => {
      mockInvoke({
        list_cronjobs: () => [
          {
            id: "c1",
            name: "daily",
            schedule: { cron: "0 9 * * *" },
            enabled: true,
            last_run_at: 1000,
            last_run_status: "success",
            next_run_at: 2000,
          },
          {
            id: "c2",
            name: "hourly",
            schedule: { delay_minutes: 60 },
            enabled: false,
            last_run_at: null,
            last_run_status: null,
            next_run_at: null,
          },
          {
            id: "c3",
            name: "once",
            schedule: { once: "2030-01-01T00:00:00Z" },
            enabled: true,
            last_run_at: null,
            last_run_status: null,
            next_run_at: null,
          },
        ],
      });
      await useTaskSidebarStore.getState().loadCronJobs();
      const jobs = useTaskSidebarStore.getState().cronJobs;
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
        id: "c1",
        name: "daily",
        schedule_display: "0 9 * * *",
        enabled: true,
      });
      expect(jobs[1]).toMatchObject({
        id: "c3",
        schedule_display: "2030-01-01T00:00:00Z",
      });
    });

    it("renders delay_minutes as '<n>min' when cron/once are absent", async () => {
      mockInvoke({
        list_cronjobs: () => [
          {
            id: "c",
            name: "ping",
            schedule: { delay_minutes: 15 },
            enabled: true,
          },
        ],
      });
      await useTaskSidebarStore.getState().loadCronJobs();
      expect(
        useTaskSidebarStore.getState().cronJobs[0].schedule_display,
      ).toBe("15min");
    });

    it("handles null/undefined jobs list (backend returning null)", async () => {
      mockInvoke({ list_cronjobs: () => null });
      await useTaskSidebarStore.getState().loadCronJobs();
      expect(useTaskSidebarStore.getState().cronJobs).toEqual([]);
    });

    it("swallows errors and logs", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockInvoke({
        list_cronjobs: () => {
          throw new Error("no db");
        },
      });
      await useTaskSidebarStore.getState().loadCronJobs();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("addOrRefreshTask", () => {
    it("prepends a newly-fetched task and re-sorts", async () => {
      const existing = makeTask({ id: "e", lastActivityAt: 1_000 });
      useTaskSidebarStore.setState({ tasks: [existing] });
      const fetched = makeTask({ id: "new", lastActivityAt: 9_000 });
      mockInvoke({ get_task_status: () => fetched });

      await useTaskSidebarStore.getState().addOrRefreshTask("new");
      const s = useTaskSidebarStore.getState();
      expect(s.tasks.map((t) => t.id)).toEqual(["new", "e"]);
      expectInvokedWith("get_task_status", { taskId: "new" });
    });

    it("replaces an existing task with refreshed data (no duplicates)", async () => {
      const stale = makeTask({ id: "x", title: "old title", lastActivityAt: 1 });
      useTaskSidebarStore.setState({ tasks: [stale] });
      const refreshed = makeTask({
        id: "x",
        title: "new title",
        lastActivityAt: 2,
      });
      mockInvoke({ get_task_status: () => refreshed });

      await useTaskSidebarStore.getState().addOrRefreshTask("x");
      const s = useTaskSidebarStore.getState();
      expect(s.tasks).toHaveLength(1);
      expect(s.tasks[0].title).toBe("new title");
    });

    it("swallows errors", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockInvoke({
        get_task_status: () => {
          throw new Error("not found");
        },
      });
      await useTaskSidebarStore.getState().addOrRefreshTask("missing");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("updateTaskProgress", () => {
    it("updates matching task + flips status to 'running' + refreshes updatedAt", () => {
      const t = makeTask({
        id: "p1",
        status: "pending",
        currentStage: 0,
        totalStages: 3,
        progress: 0,
        updatedAt: 10,
      });
      useTaskSidebarStore.setState({ tasks: [t] });

      useTaskSidebarStore.getState().updateTaskProgress("p1", 1, 5, 20);
      const updated = useTaskSidebarStore
        .getState()
        .tasks.find((x) => x.id === "p1");
      expect(updated?.currentStage).toBe(1);
      expect(updated?.totalStages).toBe(5);
      expect(updated?.progress).toBe(20);
      expect(updated?.status).toBe("running");
      expect(updated!.updatedAt).toBeGreaterThan(10);
    });

    it("is a no-op for unknown ids (but still re-sorts)", () => {
      const t = makeTask({ id: "keep" });
      useTaskSidebarStore.setState({ tasks: [t] });
      useTaskSidebarStore.getState().updateTaskProgress("ghost", 1, 2, 50);
      expect(useTaskSidebarStore.getState().tasks).toEqual([t]);
    });
  });

  describe("updateTaskStatus", () => {
    it("writes status + errorMessage and sets completedAt when terminal", () => {
      const t = makeTask({ id: "x", completedAt: null });
      useTaskSidebarStore.setState({ tasks: [t] });
      useTaskSidebarStore.getState().updateTaskStatus("x", "failed", "stack");
      const got = useTaskSidebarStore
        .getState()
        .tasks.find((x) => x.id === "x");
      expect(got?.status).toBe("failed");
      expect(got?.errorMessage).toBe("stack");
      expect(got?.completedAt).toBeGreaterThan(0);
    });

    it("preserves existing errorMessage when none is provided", () => {
      const t = makeTask({ id: "y", errorMessage: "previous error" });
      useTaskSidebarStore.setState({ tasks: [t] });
      useTaskSidebarStore.getState().updateTaskStatus("y", "cancelled");
      const got = useTaskSidebarStore
        .getState()
        .tasks.find((x) => x.id === "y");
      expect(got?.errorMessage).toBe("previous error");
      expect(got?.status).toBe("cancelled");
    });

    it("does NOT set completedAt for non-terminal status changes", () => {
      const t = makeTask({ id: "r", completedAt: null });
      useTaskSidebarStore.setState({ tasks: [t] });
      useTaskSidebarStore.getState().updateTaskStatus("r", "running");
      const got = useTaskSidebarStore
        .getState()
        .tasks.find((x) => x.id === "r");
      expect(got?.status).toBe("running");
      expect(got?.completedAt).toBeNull();
    });

    it("sets completedAt for 'completed' status", () => {
      const t = makeTask({ id: "c", completedAt: null });
      useTaskSidebarStore.setState({ tasks: [t] });
      useTaskSidebarStore.getState().updateTaskStatus("c", "completed");
      expect(
        useTaskSidebarStore.getState().tasks[0].completedAt,
      ).not.toBeNull();
    });
  });

  describe("removeTask", () => {
    it("filters out the task and clears selectedTaskId if it was selected", () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b" });
      useTaskSidebarStore.setState({
        tasks: [a, b],
        selectedTaskId: "a",
      });
      useTaskSidebarStore.getState().removeTask("a");
      const s = useTaskSidebarStore.getState();
      expect(s.tasks.map((t) => t.id)).toEqual(["b"]);
      expect(s.selectedTaskId).toBeNull();
    });

    it("preserves selectedTaskId when a different task is removed", () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b" });
      useTaskSidebarStore.setState({
        tasks: [a, b],
        selectedTaskId: "b",
      });
      useTaskSidebarStore.getState().removeTask("a");
      expect(useTaskSidebarStore.getState().selectedTaskId).toBe("b");
    });
  });

  describe("selectTask", () => {
    it("sets and clears selectedTaskId", () => {
      useTaskSidebarStore.getState().selectTask("abc");
      expect(useTaskSidebarStore.getState().selectedTaskId).toBe("abc");
      useTaskSidebarStore.getState().selectTask(null);
      expect(useTaskSidebarStore.getState().selectedTaskId).toBeNull();
    });
  });

  describe("navigateToSession / consumePendingSession", () => {
    it("set + consume returns the pending id exactly once", () => {
      useTaskSidebarStore.getState().navigateToSession("sess-42");
      expect(useTaskSidebarStore.getState().pendingSessionId).toBe("sess-42");
      const first = useTaskSidebarStore.getState().consumePendingSession();
      expect(first).toBe("sess-42");
      expect(useTaskSidebarStore.getState().pendingSessionId).toBeNull();
      const second = useTaskSidebarStore.getState().consumePendingSession();
      expect(second).toBeNull();
    });
  });

  describe("addPendingNewTab / consumePendingNewTab", () => {
    it("stores, then consume returns + clears the pending tab once", () => {
      useTaskSidebarStore.getState().addPendingNewTab("t1", "New Task");
      expect(useTaskSidebarStore.getState().pendingNewTab).toEqual({
        id: "t1",
        name: "New Task",
      });
      const got = useTaskSidebarStore.getState().consumePendingNewTab();
      expect(got).toEqual({ id: "t1", name: "New Task" });
      expect(useTaskSidebarStore.getState().pendingNewTab).toBeNull();
      expect(useTaskSidebarStore.getState().consumePendingNewTab()).toBeNull();
    });
  });

  describe("notifyTab / consumeTabNotify", () => {
    it("notify then consume returns the type and clears state", () => {
      useTaskSidebarStore.getState().notifyTab("x", "complete");
      expect(useTaskSidebarStore.getState().pendingTabNotify).toEqual({
        id: "x",
        type: "complete",
      });
      expect(useTaskSidebarStore.getState().consumeTabNotify()).toEqual({
        id: "x",
        type: "complete",
      });
      expect(useTaskSidebarStore.getState().pendingTabNotify).toBeNull();
      expect(useTaskSidebarStore.getState().consumeTabNotify()).toBeNull();
    });

    it("supports both 'complete' and 'fail' variants", () => {
      useTaskSidebarStore.getState().notifyTab("y", "fail");
      expect(useTaskSidebarStore.getState().pendingTabNotify?.type).toBe(
        "fail",
      );
    });
  });

  describe("toggleSidebar", () => {
    it("flips sidebarCollapsed when called with no arg", () => {
      expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(false);
      useTaskSidebarStore.getState().toggleSidebar();
      expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(true);
      useTaskSidebarStore.getState().toggleSidebar();
      expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(false);
    });

    it("accepts an explicit boolean override", () => {
      useTaskSidebarStore.getState().toggleSidebar(true);
      expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(true);
      useTaskSidebarStore.getState().toggleSidebar(true);
      expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(true);
      useTaskSidebarStore.getState().toggleSidebar(false);
      expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe("pinTask / unpinTask", () => {
    it("pinTask invokes pin_task with pinned=true and updates state", async () => {
      const t = makeTask({ id: "t", pinned: false });
      useTaskSidebarStore.setState({ tasks: [t] });
      mockInvoke({ pin_task: () => undefined });
      await useTaskSidebarStore.getState().pinTask("t");
      expect(useTaskSidebarStore.getState().tasks[0].pinned).toBe(true);
      expectInvokedWith("pin_task", { taskId: "t", pinned: true });
    });

    it("unpinTask invokes pin_task with pinned=false", async () => {
      const t = makeTask({ id: "t", pinned: true });
      useTaskSidebarStore.setState({ tasks: [t] });
      mockInvoke({ pin_task: () => undefined });
      await useTaskSidebarStore.getState().unpinTask("t");
      expect(useTaskSidebarStore.getState().tasks[0].pinned).toBe(false);
      expectInvokedWith("pin_task", { taskId: "t", pinned: false });
    });

    it("pinTask swallows errors and does not mutate", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeTask({ id: "t", pinned: false });
      useTaskSidebarStore.setState({ tasks: [t] });
      mockInvoke({
        pin_task: () => {
          throw new Error("denied");
        },
      });
      await useTaskSidebarStore.getState().pinTask("t");
      expect(useTaskSidebarStore.getState().tasks[0].pinned).toBe(false);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it("unpinTask swallows errors", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeTask({ id: "t", pinned: true });
      useTaskSidebarStore.setState({ tasks: [t] });
      mockInvoke({
        unpin_task: () => undefined,
        pin_task: () => {
          throw new Error("network");
        },
      });
      await useTaskSidebarStore.getState().unpinTask("t");
      expect(useTaskSidebarStore.getState().tasks[0].pinned).toBe(true);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("deleteTask", () => {
    it("invokes delete_task, removes the task, and clears selectedTaskId on match", async () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b" });
      useTaskSidebarStore.setState({
        tasks: [a, b],
        selectedTaskId: "a",
      });
      mockInvoke({ delete_task: () => undefined });
      await useTaskSidebarStore.getState().deleteTask("a");
      const s = useTaskSidebarStore.getState();
      expect(s.tasks.map((t) => t.id)).toEqual(["b"]);
      expect(s.selectedTaskId).toBeNull();
      expectInvokedWith("delete_task", { taskId: "a" });
    });

    it("preserves selectedTaskId when deleting a different task", async () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b" });
      useTaskSidebarStore.setState({
        tasks: [a, b],
        selectedTaskId: "b",
      });
      mockInvoke({ delete_task: () => undefined });
      await useTaskSidebarStore.getState().deleteTask("a");
      expect(useTaskSidebarStore.getState().selectedTaskId).toBe("b");
    });

    it("swallows errors", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useTaskSidebarStore.setState({ tasks: [makeTask({ id: "a" })] });
      mockInvoke({
        delete_task: () => {
          throw new Error("locked");
        },
      });
      await useTaskSidebarStore.getState().deleteTask("a");
      expect(useTaskSidebarStore.getState().tasks).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("markNewTask / clearNewTask", () => {
    it("marks and clears entries in the newlyCreatedTaskIds set", () => {
      useTaskSidebarStore.getState().markNewTask("a");
      useTaskSidebarStore.getState().markNewTask("b");
      const s1 = useTaskSidebarStore.getState();
      expect(s1.newlyCreatedTaskIds.has("a")).toBe(true);
      expect(s1.newlyCreatedTaskIds.has("b")).toBe(true);

      useTaskSidebarStore.getState().clearNewTask("a");
      const s2 = useTaskSidebarStore.getState();
      expect(s2.newlyCreatedTaskIds.has("a")).toBe(false);
      expect(s2.newlyCreatedTaskIds.has("b")).toBe(true);
    });

    it("uses a fresh Set reference on each mutation (shallow-equality-safe)", () => {
      const before = useTaskSidebarStore.getState().newlyCreatedTaskIds;
      useTaskSidebarStore.getState().markNewTask("a");
      const after = useTaskSidebarStore.getState().newlyCreatedTaskIds;
      expect(after).not.toBe(before);
    });

    it("clearNewTask on an unknown id is a no-op", () => {
      useTaskSidebarStore.getState().markNewTask("exists");
      useTaskSidebarStore.getState().clearNewTask("missing");
      expect(
        useTaskSidebarStore.getState().newlyCreatedTaskIds.has("exists"),
      ).toBe(true);
    });
  });

  describe("task list sorting (integration)", () => {
    it("sorts by lastActivityAt desc when multiple tasks are loaded", async () => {
      const a = makeTask({ id: "a", lastActivityAt: 100 });
      const b = makeTask({ id: "b", lastActivityAt: 300 });
      const c = makeTask({ id: "c", lastActivityAt: 200 });
      mockInvoke({ list_tasks: () => [a, b, c] });
      await useTaskSidebarStore.getState().loadTasks();
      expect(
        useTaskSidebarStore.getState().tasks.map((t) => t.id),
      ).toEqual(["b", "c", "a"]);
    });

    it("falls back to updatedAt when lastActivityAt is 0/missing", async () => {
      const a = makeTask({
        id: "a",
        lastActivityAt: 0,
        updatedAt: 500,
        createdAt: 100,
      });
      const b = makeTask({
        id: "b",
        lastActivityAt: 0,
        updatedAt: 0,
        createdAt: 800,
      });
      mockInvoke({ list_tasks: () => [a, b] });
      await useTaskSidebarStore.getState().loadTasks();
      expect(
        useTaskSidebarStore.getState().tasks.map((t) => t.id),
      ).toEqual(["b", "a"]);
    });
  });
});

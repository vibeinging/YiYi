import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { useTaskStore } from "./taskStore";
import type { TaskInfo } from "../api/tasks";

// Snapshot the pristine state before any test mutates the store.
const PRISTINE = useTaskStore.getState();

function resetStore() {
  useTaskStore.setState({
    ...PRISTINE,
    tasks: [],
  });
}

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: "task-1",
    title: "Build the rocket",
    description: "ship it by friday",
    status: "pending",
    sessionId: "sess-1",
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

describe("taskStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("starts with empty tasks and closed UI flags", () => {
      const s = useTaskStore.getState();
      expect(s.tasks).toEqual([]);
      expect(s.selectedTaskId).toBeNull();
      expect(s.drawerOpen).toBe(false);
      expect(s.panelCollapsed).toBe(false);
      expect(s.sidebarCollapsed).toBe(false);
    });
  });

  describe("loadTasks", () => {
    it("invokes list_tasks and stores the result", async () => {
      const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
      mockInvoke({ list_tasks: () => tasks });
      await useTaskStore.getState().loadTasks();
      expect(useTaskStore.getState().tasks).toEqual(tasks);
    });

    it("swallows backend errors and logs to console.error (tasks unchanged)", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useTaskStore.setState({ tasks: [makeTask()] });
      mockInvoke({
        list_tasks: () => {
          throw new Error("db locked");
        },
      });
      await useTaskStore.getState().loadTasks();
      // Pre-existing tasks are preserved because the catch branch skips setState.
      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("addTask", () => {
    it("prepends the task to the list", () => {
      const t1 = makeTask({ id: "a" });
      const t2 = makeTask({ id: "b" });
      useTaskStore.getState().addTask(t1);
      useTaskStore.getState().addTask(t2);
      const ids = useTaskStore.getState().tasks.map((t) => t.id);
      expect(ids).toEqual(["b", "a"]);
    });

    it("replaces any existing task with the same id (dedup)", () => {
      const v1 = makeTask({ id: "a", title: "v1" });
      const v2 = makeTask({ id: "a", title: "v2" });
      useTaskStore.getState().addTask(v1);
      useTaskStore.getState().addTask(v2);
      const tasks = useTaskStore.getState().tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("v2");
    });
  });

  describe("addOrRefreshTask", () => {
    it("fetches the task via get_task_status and upserts it", async () => {
      const existing = makeTask({ id: "a", title: "stale" });
      useTaskStore.setState({ tasks: [existing] });
      const refreshed = makeTask({ id: "a", title: "fresh" });
      mockInvoke({
        get_task_status: (args) => {
          expect(args).toEqual({ taskId: "a" });
          return refreshed;
        },
      });
      await useTaskStore.getState().addOrRefreshTask("a");
      const tasks = useTaskStore.getState().tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("fresh");
    });

    it("prepends a brand-new task when id is not yet in the list", async () => {
      const existing = makeTask({ id: "a" });
      useTaskStore.setState({ tasks: [existing] });
      const newTask = makeTask({ id: "b" });
      mockInvoke({ get_task_status: () => newTask });
      await useTaskStore.getState().addOrRefreshTask("b");
      const ids = useTaskStore.getState().tasks.map((t) => t.id);
      expect(ids).toEqual(["b", "a"]);
    });

    it("swallows errors and leaves state untouched", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const existing = makeTask({ id: "a" });
      useTaskStore.setState({ tasks: [existing] });
      mockInvoke({
        get_task_status: () => {
          throw new Error("not found");
        },
      });
      await useTaskStore.getState().addOrRefreshTask("a");
      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("updateTaskProgress", () => {
    it("updates stage/progress and forces status='running' + updatedAt", () => {
      const t = makeTask({ id: "a", updatedAt: 0, status: "pending" });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskProgress("a", 2, 5, 40);
      const tasks = useTaskStore.getState().tasks;
      expect(tasks[0].currentStage).toBe(2);
      expect(tasks[0].totalStages).toBe(5);
      expect(tasks[0].progress).toBe(40);
      expect(tasks[0].status).toBe("running");
      expect(tasks[0].updatedAt).toBeGreaterThan(0);
    });

    it("is a no-op when the task id does not exist", () => {
      const t = makeTask({ id: "a" });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskProgress("ghost", 1, 2, 50);
      expect(useTaskStore.getState().tasks).toEqual([t]);
    });

    it("leaves other tasks in the list untouched", () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b", progress: 0 });
      useTaskStore.setState({ tasks: [a, b] });
      useTaskStore.getState().updateTaskProgress("a", 1, 2, 50);
      const tasks = useTaskStore.getState().tasks;
      expect(tasks.find((t) => t.id === "b")?.progress).toBe(0);
    });
  });

  describe("updateTaskStatus", () => {
    it("updates status + updatedAt and stamps completedAt for terminal states", () => {
      const t = makeTask({ id: "a", completedAt: null });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskStatus("a", "completed");
      const tasks = useTaskStore.getState().tasks;
      expect(tasks[0].status).toBe("completed");
      expect(tasks[0].completedAt).toBeGreaterThan(0);
    });

    it("stamps completedAt for 'failed' and 'cancelled' states too", () => {
      const t = makeTask({ id: "a", completedAt: null });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskStatus("a", "failed", "boom");
      expect(useTaskStore.getState().tasks[0].status).toBe("failed");
      expect(useTaskStore.getState().tasks[0].errorMessage).toBe("boom");
      expect(useTaskStore.getState().tasks[0].completedAt).toBeGreaterThan(0);

      useTaskStore.setState({ tasks: [makeTask({ id: "b", completedAt: null })] });
      useTaskStore.getState().updateTaskStatus("b", "cancelled");
      expect(useTaskStore.getState().tasks[0].completedAt).toBeGreaterThan(0);
    });

    it("preserves completedAt for non-terminal statuses", () => {
      const t = makeTask({ id: "a", completedAt: null });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskStatus("a", "running");
      expect(useTaskStore.getState().tasks[0].status).toBe("running");
      expect(useTaskStore.getState().tasks[0].completedAt).toBeNull();
    });

    it("preserves prior errorMessage when new errorMessage is undefined", () => {
      const t = makeTask({ id: "a", errorMessage: "prior" });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskStatus("a", "running");
      expect(useTaskStore.getState().tasks[0].errorMessage).toBe("prior");
    });

    it("is a no-op when the task id does not exist", () => {
      const t = makeTask({ id: "a" });
      useTaskStore.setState({ tasks: [t] });
      useTaskStore.getState().updateTaskStatus("ghost", "completed");
      expect(useTaskStore.getState().tasks).toEqual([t]);
    });
  });

  describe("removeTask", () => {
    it("removes the task from the list", () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b" });
      useTaskStore.setState({ tasks: [a, b] });
      useTaskStore.getState().removeTask("a");
      const tasks = useTaskStore.getState().tasks;
      expect(tasks.map((t) => t.id)).toEqual(["b"]);
    });

    it("clears selectedTaskId and drawerOpen when removing the currently selected task", () => {
      const a = makeTask({ id: "a" });
      useTaskStore.setState({ tasks: [a], selectedTaskId: "a", drawerOpen: true });
      useTaskStore.getState().removeTask("a");
      const s = useTaskStore.getState();
      expect(s.selectedTaskId).toBeNull();
      expect(s.drawerOpen).toBe(false);
    });

    it("preserves selectedTaskId and drawerOpen when removing a different task", () => {
      const a = makeTask({ id: "a" });
      const b = makeTask({ id: "b" });
      useTaskStore.setState({ tasks: [a, b], selectedTaskId: "a", drawerOpen: true });
      useTaskStore.getState().removeTask("b");
      const s = useTaskStore.getState();
      expect(s.selectedTaskId).toBe("a");
      expect(s.drawerOpen).toBe(true);
    });

    it("is a no-op when the task id does not exist", () => {
      const a = makeTask({ id: "a" });
      useTaskStore.setState({ tasks: [a] });
      useTaskStore.getState().removeTask("ghost");
      expect(useTaskStore.getState().tasks).toEqual([a]);
    });
  });

  describe("selectTask", () => {
    it("sets selectedTaskId and opens drawer when given an id", () => {
      useTaskStore.getState().selectTask("a");
      const s = useTaskStore.getState();
      expect(s.selectedTaskId).toBe("a");
      expect(s.drawerOpen).toBe(true);
    });

    it("null clears selection and closes the drawer", () => {
      useTaskStore.setState({ selectedTaskId: "a", drawerOpen: true });
      useTaskStore.getState().selectTask(null);
      const s = useTaskStore.getState();
      expect(s.selectedTaskId).toBeNull();
      expect(s.drawerOpen).toBe(false);
    });

    it("switches selection between tasks", () => {
      useTaskStore.getState().selectTask("a");
      useTaskStore.getState().selectTask("b");
      expect(useTaskStore.getState().selectedTaskId).toBe("b");
      expect(useTaskStore.getState().drawerOpen).toBe(true);
    });
  });

  describe("toggleDrawer", () => {
    it("with no argument, flips drawerOpen", () => {
      useTaskStore.getState().toggleDrawer();
      expect(useTaskStore.getState().drawerOpen).toBe(true);
      useTaskStore.getState().toggleDrawer();
      expect(useTaskStore.getState().drawerOpen).toBe(false);
    });

    it("with explicit true, opens the drawer", () => {
      useTaskStore.getState().toggleDrawer(true);
      expect(useTaskStore.getState().drawerOpen).toBe(true);
    });

    it("with explicit false, closes the drawer and clears selectedTaskId", () => {
      useTaskStore.setState({ selectedTaskId: "a", drawerOpen: true });
      useTaskStore.getState().toggleDrawer(false);
      const s = useTaskStore.getState();
      expect(s.drawerOpen).toBe(false);
      expect(s.selectedTaskId).toBeNull();
    });
  });

  describe("togglePanel", () => {
    it("with no argument, flips panelCollapsed", () => {
      useTaskStore.getState().togglePanel();
      expect(useTaskStore.getState().panelCollapsed).toBe(true);
      useTaskStore.getState().togglePanel();
      expect(useTaskStore.getState().panelCollapsed).toBe(false);
    });

    it("with explicit value, forces that value", () => {
      useTaskStore.getState().togglePanel(true);
      expect(useTaskStore.getState().panelCollapsed).toBe(true);
      useTaskStore.getState().togglePanel(true);
      expect(useTaskStore.getState().panelCollapsed).toBe(true);
      useTaskStore.getState().togglePanel(false);
      expect(useTaskStore.getState().panelCollapsed).toBe(false);
    });
  });

  describe("toggleSidebar", () => {
    it("with no argument, flips sidebarCollapsed", () => {
      useTaskStore.getState().toggleSidebar();
      expect(useTaskStore.getState().sidebarCollapsed).toBe(true);
      useTaskStore.getState().toggleSidebar();
      expect(useTaskStore.getState().sidebarCollapsed).toBe(false);
    });

    it("with explicit value, forces that value", () => {
      useTaskStore.getState().toggleSidebar(true);
      expect(useTaskStore.getState().sidebarCollapsed).toBe(true);
      useTaskStore.getState().toggleSidebar(false);
      expect(useTaskStore.getState().sidebarCollapsed).toBe(false);
    });
  });
});

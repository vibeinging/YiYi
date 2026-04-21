import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  createTask,
  listTasks,
  getTaskStatus,
  cancelTask,
  pauseTask,
  sendTaskMessage,
  deleteTask,
  pinTask,
  confirmBackgroundTask,
  convertToLongTask,
  getTaskByName,
  listAllTasksBrief,
  openTaskFolder,
  type TaskInfo,
} from "./tasks";

const invokeMock = invoke as unknown as Mock;

describe("tasks api", () => {
  const sampleTask: TaskInfo = {
    id: "task-1",
    title: "build rocket",
    description: "ship it",
    status: "pending",
    sessionId: "sess-1",
    parentSessionId: null,
    plan: null,
    currentStage: 0,
    totalStages: 3,
    progress: 0,
    errorMessage: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    completedAt: null,
    taskType: "long",
    pinned: false,
    lastActivityAt: 1_700_000_000,
  };

  describe("createTask", () => {
    it("invokes create_task with { title, description, parentSessionId, plan }", async () => {
      mockInvoke({ create_task: () => sampleTask });
      const result = await createTask(
        "build rocket",
        "ship it",
        "sess-0",
        ["stage a", "stage b"],
      );
      expect(result).toEqual(sampleTask);
      expect(invokeMock).toHaveBeenCalledWith("create_task", {
        title: "build rocket",
        description: "ship it",
        parentSessionId: "sess-0",
        plan: ["stage a", "stage b"],
      });
    });

    it("passes undefined for omitted optional args", async () => {
      mockInvoke({ create_task: () => sampleTask });
      await createTask("only title");
      expect(invokeMock).toHaveBeenCalledWith("create_task", {
        title: "only title",
        description: undefined,
        parentSessionId: undefined,
        plan: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_task: () => {
          throw new Error("db offline");
        },
      });
      await expect(createTask("x")).rejects.toThrow("db offline");
    });
  });

  describe("listTasks", () => {
    it("invokes list_tasks with { parentSessionId, status } and returns the list", async () => {
      mockInvoke({ list_tasks: () => [sampleTask] });
      const result = await listTasks("sess-0", "pending");
      expect(result).toEqual([sampleTask]);
      expect(invokeMock).toHaveBeenCalledWith("list_tasks", {
        parentSessionId: "sess-0",
        status: "pending",
      });
    });

    it("passes undefined for omitted args", async () => {
      mockInvoke({ list_tasks: () => [] });
      await listTasks();
      expect(invokeMock).toHaveBeenCalledWith("list_tasks", {
        parentSessionId: undefined,
        status: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_tasks: () => {
          throw new Error("db offline");
        },
      });
      await expect(listTasks()).rejects.toThrow("db offline");
    });
  });

  describe("getTaskStatus", () => {
    it("invokes get_task_status with { taskId } and returns the task", async () => {
      mockInvoke({ get_task_status: () => sampleTask });
      const result = await getTaskStatus("task-1");
      expect(result).toEqual(sampleTask);
      expect(invokeMock).toHaveBeenCalledWith("get_task_status", {
        taskId: "task-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_task_status: () => {
          throw new Error("not found");
        },
      });
      await expect(getTaskStatus("missing")).rejects.toThrow("not found");
    });
  });

  describe("cancelTask", () => {
    it("invokes cancel_task with { taskId }", async () => {
      mockInvoke({ cancel_task: () => undefined });
      await cancelTask("task-1");
      expect(invokeMock).toHaveBeenCalledWith("cancel_task", {
        taskId: "task-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        cancel_task: () => {
          throw new Error("already complete");
        },
      });
      await expect(cancelTask("task-1")).rejects.toThrow("already complete");
    });
  });

  describe("pauseTask", () => {
    it("invokes pause_task with { taskId }", async () => {
      mockInvoke({ pause_task: () => undefined });
      await pauseTask("task-1");
      expect(invokeMock).toHaveBeenCalledWith("pause_task", {
        taskId: "task-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pause_task: () => {
          throw new Error("cannot pause");
        },
      });
      await expect(pauseTask("task-1")).rejects.toThrow("cannot pause");
    });
  });

  describe("sendTaskMessage", () => {
    it("invokes send_task_message with { taskId, message }", async () => {
      mockInvoke({ send_task_message: () => undefined });
      await sendTaskMessage("task-1", "status?");
      expect(invokeMock).toHaveBeenCalledWith("send_task_message", {
        taskId: "task-1",
        message: "status?",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        send_task_message: () => {
          throw new Error("task not running");
        },
      });
      await expect(sendTaskMessage("task-1", "x")).rejects.toThrow(
        "task not running",
      );
    });
  });

  describe("deleteTask", () => {
    it("invokes delete_task with { taskId }", async () => {
      mockInvoke({ delete_task: () => undefined });
      await deleteTask("task-1");
      expect(invokeMock).toHaveBeenCalledWith("delete_task", {
        taskId: "task-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_task: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteTask("missing")).rejects.toThrow("not found");
    });
  });

  describe("pinTask", () => {
    it("invokes pin_task with { taskId, pinned: true }", async () => {
      mockInvoke({ pin_task: () => undefined });
      await pinTask("task-1", true);
      expect(invokeMock).toHaveBeenCalledWith("pin_task", {
        taskId: "task-1",
        pinned: true,
      });
    });

    it("invokes pin_task with { taskId, pinned: false }", async () => {
      mockInvoke({ pin_task: () => undefined });
      await pinTask("task-1", false);
      expect(invokeMock).toHaveBeenCalledWith("pin_task", {
        taskId: "task-1",
        pinned: false,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pin_task: () => {
          throw new Error("not found");
        },
      });
      await expect(pinTask("task-1", true)).rejects.toThrow("not found");
    });
  });

  describe("confirmBackgroundTask", () => {
    it("invokes confirm_background_task with the full arg shape", async () => {
      mockInvoke({ confirm_background_task: () => sampleTask });
      const result = await confirmBackgroundTask(
        "sess-0",
        "bg task",
        "original",
        "summary",
        "/tmp/ws",
      );
      expect(result).toEqual(sampleTask);
      expect(invokeMock).toHaveBeenCalledWith("confirm_background_task", {
        parentSessionId: "sess-0",
        taskName: "bg task",
        originalMessage: "original",
        contextSummary: "summary",
        workspacePath: "/tmp/ws",
      });
    });

    it("passes workspacePath undefined when omitted", async () => {
      mockInvoke({ confirm_background_task: () => sampleTask });
      await confirmBackgroundTask("sess-0", "bg task", "original", "summary");
      expect(invokeMock).toHaveBeenCalledWith("confirm_background_task", {
        parentSessionId: "sess-0",
        taskName: "bg task",
        originalMessage: "original",
        contextSummary: "summary",
        workspacePath: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        confirm_background_task: () => {
          throw new Error("spawn failed");
        },
      });
      await expect(
        confirmBackgroundTask("sess-0", "n", "m", "s"),
      ).rejects.toThrow("spawn failed");
    });
  });

  describe("convertToLongTask", () => {
    it("invokes convert_to_long_task with the full arg shape", async () => {
      mockInvoke({ convert_to_long_task: () => sampleTask });
      const result = await convertToLongTask(
        "sess-0",
        "long task",
        "summary",
        "/tmp/ws",
      );
      expect(result).toEqual(sampleTask);
      expect(invokeMock).toHaveBeenCalledWith("convert_to_long_task", {
        parentSessionId: "sess-0",
        taskName: "long task",
        contextSummary: "summary",
        workspacePath: "/tmp/ws",
      });
    });

    it("passes workspacePath undefined when omitted", async () => {
      mockInvoke({ convert_to_long_task: () => sampleTask });
      await convertToLongTask("sess-0", "long task", "summary");
      expect(invokeMock).toHaveBeenCalledWith("convert_to_long_task", {
        parentSessionId: "sess-0",
        taskName: "long task",
        contextSummary: "summary",
        workspacePath: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        convert_to_long_task: () => {
          throw new Error("cannot convert");
        },
      });
      await expect(
        convertToLongTask("sess-0", "n", "s"),
      ).rejects.toThrow("cannot convert");
    });
  });

  describe("getTaskByName", () => {
    it("invokes get_task_by_name with { name } and returns the task", async () => {
      mockInvoke({ get_task_by_name: () => sampleTask });
      const result = await getTaskByName("build rocket");
      expect(result).toEqual(sampleTask);
      expect(invokeMock).toHaveBeenCalledWith("get_task_by_name", {
        name: "build rocket",
      });
    });

    it("returns null when not found", async () => {
      mockInvoke({ get_task_by_name: () => null });
      const result = await getTaskByName("ghost");
      expect(result).toBeNull();
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_task_by_name: () => {
          throw new Error("db offline");
        },
      });
      await expect(getTaskByName("x")).rejects.toThrow("db offline");
    });
  });

  describe("listAllTasksBrief", () => {
    it("invokes list_all_tasks_brief and returns the list", async () => {
      mockInvoke({ list_all_tasks_brief: () => [sampleTask] });
      const result = await listAllTasksBrief();
      expect(result).toEqual([sampleTask]);
      expect(invokeMock).toHaveBeenCalledWith("list_all_tasks_brief");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_all_tasks_brief: () => {
          throw new Error("db offline");
        },
      });
      await expect(listAllTasksBrief()).rejects.toThrow("db offline");
    });
  });

  describe("openTaskFolder", () => {
    it("invokes open_task_folder with { taskId }", async () => {
      mockInvoke({ open_task_folder: () => undefined });
      await openTaskFolder("task-1");
      expect(invokeMock).toHaveBeenCalledWith("open_task_folder", {
        taskId: "task-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        open_task_folder: () => {
          throw new Error("no such folder");
        },
      });
      await expect(openTaskFolder("task-1")).rejects.toThrow("no such folder");
    });
  });
});

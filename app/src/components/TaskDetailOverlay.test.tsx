import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { TaskDetailOverlay } from "./TaskDetailOverlay";
import { useTaskSidebarStore } from "../stores/taskSidebarStore";
import type { TaskInfo } from "../api/tasks";

const invokeMock = invoke as unknown as Mock;

// Snapshot the sidebar-store's pristine state so we can reset between tests.
const SIDEBAR_PRISTINE = useTaskSidebarStore.getState();

function resetSidebar(partial: Partial<typeof SIDEBAR_PRISTINE> = {}) {
  useTaskSidebarStore.setState({
    ...SIDEBAR_PRISTINE,
    tasks: [],
    selectedTaskId: null,
    cronJobs: [],
    pendingNewTab: null,
    pendingSessionId: null,
    pendingTabNotify: null,
    newlyCreatedTaskIds: new Set(),
    ...partial,
  });
}

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: "task-1",
    title: "Build the rocket",
    description: "ship it by friday",
    status: "running",
    sessionId: "sess-1",
    parentSessionId: null,
    plan: null,
    currentStage: 1,
    totalStages: 3,
    progress: 33,
    errorMessage: null,
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    completedAt: null,
    taskType: "long",
    pinned: false,
    lastActivityAt: Date.now(),
    workspacePath: "/tmp/ws",
    ...overrides,
  };
}

describe("TaskDetailOverlay", () => {
  beforeEach(() => {
    resetSidebar();
  });

  it("renders nothing when no task is selected", () => {
    const { container } = render(<TaskDetailOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when selectedTaskId points to a missing task", () => {
    resetSidebar({ selectedTaskId: "ghost", tasks: [] });
    const { container } = render(<TaskDetailOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the title, description, status label, and progress % when a running task is selected", () => {
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.getByText("Build the rocket")).toBeInTheDocument();
    expect(screen.getByText("ship it by friday")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("shows pause + cancel buttons for a running task", () => {
    const task = makeTask({ status: "running" });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.getByRole("button", { name: /暂停/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
  });

  it("hides pause + cancel for a completed task", () => {
    const task = makeTask({ status: "completed", progress: 100, completedAt: Date.now() });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.queryByRole("button", { name: /暂停/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /取消/ })).not.toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("shows only cancel (no pause) for a paused task", () => {
    const task = makeTask({ status: "paused" });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.queryByRole("button", { name: /暂停/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeInTheDocument();
  });

  it("invokes cancel_task when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    mockInvoke({ cancel_task: () => undefined });
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    await user.click(screen.getByRole("button", { name: /取消/ }));
    expect(invokeMock).toHaveBeenCalledWith("cancel_task", { taskId: task.id });
  });

  it("invokes pause_task when the pause button is clicked", async () => {
    const user = userEvent.setup();
    mockInvoke({ pause_task: () => undefined });
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    await user.click(screen.getByRole("button", { name: /暂停/ }));
    expect(invokeMock).toHaveBeenCalledWith("pause_task", { taskId: task.id });
  });

  it("renders the plan section when task.plan is a JSON array", () => {
    const plan = JSON.stringify([
      { title: "Collect requirements", status: "completed" },
      { title: "Design system", status: "running" },
      { title: "Ship", status: "pending" },
    ]);
    const task = makeTask({ plan });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.getByText("执行计划")).toBeInTheDocument();
    expect(screen.getByText("Collect requirements")).toBeInTheDocument();
    expect(screen.getByText("Design system")).toBeInTheDocument();
    expect(screen.getByText("Ship")).toBeInTheDocument();
  });

  it("swallows malformed plan JSON and hides the plan section", () => {
    const task = makeTask({ plan: "not-json{" });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.queryByText("执行计划")).not.toBeInTheDocument();
  });

  it("renders the error banner when task has errorMessage", () => {
    const task = makeTask({ status: "failed", errorMessage: "boom boom boom" });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("shows the footer input for a running task", () => {
    const running = makeTask({ status: "running" });
    resetSidebar({ selectedTaskId: running.id, tasks: [running] });
    render(<TaskDetailOverlay />);
    expect(screen.getByPlaceholderText("对任务追加指令...")).toBeInTheDocument();
  });

  it("hides the footer input for a completed task", () => {
    const done = makeTask({ status: "completed" });
    resetSidebar({ selectedTaskId: done.id, tasks: [done] });
    render(<TaskDetailOverlay />);
    expect(screen.queryByPlaceholderText("对任务追加指令...")).not.toBeInTheDocument();
  });

  it("sends a message via send_task_message when Enter is pressed", async () => {
    const user = userEvent.setup();
    mockInvoke({ send_task_message: () => undefined });
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    const input = screen.getByPlaceholderText("对任务追加指令...") as HTMLInputElement;
    await user.type(input, "status?");
    await user.keyboard("{Enter}");
    expect(invokeMock).toHaveBeenCalledWith("send_task_message", {
      taskId: task.id,
      message: "status?",
    });
  });

  it("does not send when the input is empty", async () => {
    const user = userEvent.setup();
    mockInvoke({ send_task_message: () => undefined });
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    const input = screen.getByPlaceholderText("对任务追加指令...");
    await user.click(input);
    await user.keyboard("{Enter}");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("clears selection when the backdrop is clicked", () => {
    const selectSpy = vi.fn();
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task], selectTask: selectSpy });
    const { container } = render(<TaskDetailOverlay />);
    // The backdrop is the first fixed element with the onClick handler (z-40).
    const backdrop = container.querySelector(".z-40");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(selectSpy).toHaveBeenCalledWith(null);
  });

  it("clears selection when Escape is pressed", () => {
    const selectSpy = vi.fn();
    const task = makeTask();
    resetSidebar({ selectedTaskId: task.id, tasks: [task], selectTask: selectSpy });
    render(<TaskDetailOverlay />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selectSpy).toHaveBeenCalledWith(null);
  });

  // Removed: terminal panel assertion — the current TaskDetailOverlay source has no terminal UI
  // (Plan A simplified overlay with terminal never landed on main).

  it("renders an empty state when task has no plan and no error", () => {
    const task = makeTask({ plan: null, errorMessage: null });
    resetSidebar({ selectedTaskId: task.id, tasks: [task] });
    render(<TaskDetailOverlay />);
    expect(screen.getByText("暂无执行计划")).toBeInTheDocument();
  });
});

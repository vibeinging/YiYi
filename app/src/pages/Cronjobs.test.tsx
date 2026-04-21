import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { CronJobsPage } from "./CronJobs";
import type { CronJobSpec } from "../api/cronjobs";

const invokeMock = invoke as unknown as Mock;

function renderPage() {
  return render(
    <ToastProvider>
      <CronJobsPage />
    </ToastProvider>,
  );
}

function makeCronJob(overrides: Partial<CronJobSpec> = {}): CronJobSpec {
  return {
    id: "job-1",
    name: "Daily Report",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *" } as CronJobSpec["schedule"],
    task_type: "notify",
    text: "Send daily report",
    dispatch: { targets: [{ type: "system" }, { type: "app" }] },
    ...overrides,
  };
}

describe("CronJobsPage", () => {
  beforeEach(() => {
    // Satisfy mount-time commands: list_cronjobs + bots_list.
    mockInvoke({
      list_cronjobs: () => [],
      bots_list: () => [],
    });
  });

  it("renders the empty state when no jobs exist", async () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: /计划任务/ }),
    ).toBeInTheDocument();
    // Loading completes and empty-state appears.
    expect(await screen.findByText("暂无定时任务")).toBeInTheDocument();
    expect(screen.getByText("点击创建第一个任务")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_cronjobs");
    expect(invokeMock).toHaveBeenCalledWith("bots_list");
  });

  it("renders jobs returned from the backend with schedule and dispatch targets", async () => {
    const jobs = [
      makeCronJob(),
      makeCronJob({
        id: "job-2",
        name: "Hourly Ping",
        enabled: false,
        schedule: { type: "cron", cron: "0 * * * *" } as CronJobSpec["schedule"],
        text: "ping the API",
      }),
    ];
    mockInvoke({
      list_cronjobs: () => jobs,
      bots_list: () => [],
    });
    renderPage();
    expect(await screen.findByText("Daily Report")).toBeInTheDocument();
    expect(screen.getByText("Hourly Ping")).toBeInTheDocument();
    // Cron expression is rendered inside a <code>.
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument();
    expect(screen.getByText("0 * * * *")).toBeInTheDocument();
    // Running and paused status badges both appear once each.
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeInTheDocument();
  });

  it("opens the create dialog when clicking 'Create' and submits with create_cronjob", async () => {
    const user = userEvent.setup();
    let created: CronJobSpec | null = null;
    mockInvoke({
      list_cronjobs: () => (created ? [created] : []),
      bots_list: () => [],
      create_cronjob: ({ spec }: any) => {
        created = spec as CronJobSpec;
        return spec;
      },
    });
    renderPage();
    // Wait for initial load to finish.
    await screen.findByText("暂无定时任务");

    // Open create dialog via the header button (Chinese: 创建任务).
    await user.click(screen.getByRole("button", { name: /创建任务/ }));
    // Dialog heading.
    expect(
      await screen.findByRole("heading", { name: /创建定时任务/ }),
    ).toBeInTheDocument();

    // Fill in name.
    const nameInput = screen.getByPlaceholderText("我的定时任务");
    await user.type(nameInput, "My Job");

    // Submit by clicking the primary '创建' button inside the dialog footer.
    // '创建' also appears elsewhere — scope to the dialog footer via the Create
    // button with the gradient class. getAllByRole -> pick last.
    const createButtons = screen.getAllByRole("button", { name: /^创建$/ });
    await user.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "create_cronjob",
        expect.objectContaining({
          spec: expect.objectContaining({ name: "My Job" }),
        }),
      );
    });
  });

  it("calls run_cronjob when the 'run once' button is clicked", async () => {
    const user = userEvent.setup();
    const job = makeCronJob();
    mockInvoke({
      list_cronjobs: () => [job],
      bots_list: () => [],
      run_cronjob: () => null,
    });
    renderPage();
    await screen.findByText("Daily Report");

    const runBtn = screen.getByTitle("立即触发一次任务");
    await user.click(runBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("run_cronjob", { id: job.id });
    });
  });

  it("pauses an enabled cron job via pause_cronjob", async () => {
    const user = userEvent.setup();
    const job = makeCronJob({ enabled: true });
    mockInvoke({
      list_cronjobs: () => [job],
      bots_list: () => [],
      pause_cronjob: () => null,
    });
    renderPage();
    await screen.findByText("Daily Report");

    const pauseBtn = screen.getByTitle("暂停");
    await user.click(pauseBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("pause_cronjob", { id: job.id });
    });
  });

  it("deletes a cron job after confirming the dialog", async () => {
    const user = userEvent.setup();
    const job = makeCronJob();
    mockInvoke({
      list_cronjobs: () => [job],
      bots_list: () => [],
      delete_cronjob: () => null,
    });
    renderPage();
    await screen.findByText("Daily Report");

    await user.click(screen.getByTitle("删除"));
    // Confirm dialog shows the message — click the primary '确认'.
    await user.click(await screen.findByRole("button", { name: /^确认$/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("delete_cronjob", { id: job.id });
    });
  });
});

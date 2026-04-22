import "../i18n";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { TerminalPage } from "./Terminal";

const invokeMock = invoke as unknown as Mock;

// scrollIntoView isn't implemented in jsdom — TerminalPage calls it in a useEffect.
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

describe("TerminalPage", () => {
  beforeEach(() => {
    // No mount-time invokes — the page only calls invoke when the user executes a command.
    mockInvoke({
      execute_shell: () => ({ stdout: "hello world", stderr: "", code: 0 }),
    });
  });

  it("renders the terminal toolbar, empty-state prompt and input placeholder", () => {
    render(<TerminalPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "终端" }),
    ).toBeInTheDocument();
    // Empty placeholder text.
    expect(screen.getByText("输入命令开始使用终端")).toBeInTheDocument();
    // Input placeholder.
    expect(screen.getByPlaceholderText("输入命令...")).toBeInTheDocument();
    // Submit button should be disabled when command is empty.
    const submit = screen.getByTitle("执行");
    expect(submit).toBeDisabled();
  });

  it("executes a shell command and renders stdout into the session history", async () => {
    const user = userEvent.setup();
    render(<TerminalPage />);

    const input = screen.getByPlaceholderText("输入命令...") as HTMLInputElement;
    await user.type(input, "echo hi");
    await user.click(screen.getByTitle("执行"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "execute_shell",
        expect.objectContaining({ command: "echo hi" }),
      ),
    );
    // stdout rendered into history, along with the echoed command line.
    expect(await screen.findByText("hello world")).toBeInTheDocument();
    expect(screen.getByText("echo hi")).toBeInTheDocument();
  });

  it("renders stderr output when the command reports an error exit code", async () => {
    mockInvoke({
      execute_shell: () => ({ stdout: "", stderr: "permission denied", code: 1 }),
    });
    const user = userEvent.setup();
    render(<TerminalPage />);
    await user.type(screen.getByPlaceholderText("输入命令..."), "rm /");
    await user.click(screen.getByTitle("执行"));

    expect(await screen.findByText("permission denied")).toBeInTheDocument();
  });

  it("falls back to an error line in history when execute_shell throws", async () => {
    mockInvoke({
      execute_shell: () => {
        throw new Error("spawn EACCES");
      },
    });
    const user = userEvent.setup();
    render(<TerminalPage />);
    await user.type(screen.getByPlaceholderText("输入命令..."), "badcmd");
    await user.click(screen.getByTitle("执行"));

    expect(await screen.findByText(/spawn EACCES/)).toBeInTheDocument();
  });

  it("opens a new terminal tab when '新建' is clicked and shows the tab strip", async () => {
    const user = userEvent.setup();
    render(<TerminalPage />);
    // Initial: single session, tabs hidden (sessions.length === 1).
    await user.click(screen.getByRole("button", { name: /新建/ }));
    // Two tab buttons should now be visible (tab strip appears when >1).
    expect(await screen.findByText("终端 1")).toBeInTheDocument();
    expect(screen.getByText("终端 2")).toBeInTheDocument();
  });
});

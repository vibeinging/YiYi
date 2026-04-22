import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { WorkspacePage } from "./Workspace";
import type { WorkspaceFile } from "../api/workspace";

const invokeMock = invoke as unknown as Mock;

function renderPage() {
  return render(
    <ToastProvider>
      <WorkspacePage />
    </ToastProvider>,
  );
}

function makeFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    name: "README.md",
    path: "/tmp/ws/README.md",
    size: 128,
    is_dir: false,
    modified: Date.now(),
    ...overrides,
  };
}

describe("WorkspacePage", () => {
  beforeEach(() => {
    // Default mount-time mocks: empty workspace + known path.
    mockInvoke({
      list_workspace_files: () => [],
      get_workspace_path: () => "/Users/test/Documents/YiYi",
    });
  });

  it("renders the header, empty tree and workspace path on mount", async () => {
    renderPage();
    // Sidebar h2 '工作空间'.
    expect(
      screen.getByRole("heading", { name: /工作空间/ }),
    ).toBeInTheDocument();
    // Empty state text from workspace.noFiles + path footer.
    expect(await screen.findByText("暂无文件")).toBeInTheDocument();
    expect(
      screen.getByText("/Users/test/Documents/YiYi"),
    ).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_workspace_files");
    expect(invokeMock).toHaveBeenCalledWith("get_workspace_path");
  });

  it("renders a populated tree (dirs first, then files)", async () => {
    mockInvoke({
      list_workspace_files: () => [
        makeFile({ name: "src", is_dir: true, size: 0 }),
        makeFile({ name: "src/main.ts", size: 200 }),
        makeFile({ name: "README.md" }),
      ],
      get_workspace_path: () => "/ws",
    });
    renderPage();
    // Both nodes should appear; the file count badge is 2 (2 files).
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // File count badge shows only non-dir files (2).
    const countBadges = screen.getAllByText("2");
    expect(countBadges.length).toBeGreaterThan(0);
  });

  it("opens the 'new file' dialog and calls create_workspace_file", async () => {
    const user = userEvent.setup();
    let createdName = "";
    mockInvoke({
      list_workspace_files: () => [],
      get_workspace_path: () => "/ws",
      create_workspace_file: (args: any) => {
        createdName = args.filename;
        return null;
      },
      load_workspace_file: () => "",
    });
    renderPage();
    await screen.findByText("暂无文件");

    // Click '新建文件' in the sidebar toolbar.
    await user.click(screen.getByRole("button", { name: /新建文件/ }));

    // Dialog opens. Fill the filename input.
    const input = await screen.findByPlaceholderText("example.txt");
    await user.type(input, "notes.md");

    // Click '创建' to submit.
    await user.click(screen.getByRole("button", { name: /^创建$/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("create_workspace_file", {
        filename: "notes.md",
        content: "",
      });
    });
    expect(createdName).toBe("notes.md");
  });

  it("toggles to 'folder' mode in the new-item dialog and calls create_workspace_dir", async () => {
    const user = userEvent.setup();
    mockInvoke({
      list_workspace_files: () => [],
      get_workspace_path: () => "/ws",
      create_workspace_dir: () => null,
    });
    renderPage();
    await screen.findByText("暂无文件");

    // Click the folder-plus sidebar button (no label; detect via svg class).
    const folderPlusSvg = document.querySelector(".lucide-folder-plus");
    expect(folderPlusSvg).not.toBeNull();
    const folderBtn = folderPlusSvg!.closest("button")!;
    await user.click(folderBtn);

    // Dialog opens defaulted to folder mode — fill name.
    const input = await screen.findByPlaceholderText("new-folder");
    await user.type(input, "scratch");
    await user.click(screen.getByRole("button", { name: /^创建$/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("create_workspace_dir", {
        dirname: "scratch",
      });
    });
  });

  it("loads a selected text file and saves edits via save_workspace_file", async () => {
    const user = userEvent.setup();
    mockInvoke({
      list_workspace_files: () => [makeFile({ name: "README.md" })],
      get_workspace_path: () => "/ws",
      load_workspace_file: () => "# Original",
      save_workspace_file: () => null,
    });
    const { container } = renderPage();

    // Click the file row.
    await user.click(await screen.findByText("README.md"));

    // Editor textarea is rendered with the loaded content.
    const textarea = await waitFor(() => {
      const t = container.querySelector("textarea");
      if (!t) throw new Error("textarea not mounted yet");
      return t as HTMLTextAreaElement;
    });
    await waitFor(() => {
      expect(textarea.value).toBe("# Original");
    });

    // Edit content and click 保存.
    await user.clear(textarea);
    await user.type(textarea, "updated");
    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_workspace_file", {
        filename: "README.md",
        content: "updated",
      });
    });
  });

  it("deletes a file via delete_workspace_file after confirming", async () => {
    const user = userEvent.setup();
    mockInvoke({
      list_workspace_files: () => [makeFile({ name: "stale.log" })],
      get_workspace_path: () => "/ws",
      delete_workspace_file: () => null,
    });
    const { container } = renderPage();
    await screen.findByText("stale.log");

    // Hover the row to reveal the delete button (opacity toggles; in JSDOM
    // it's still a <button> in the DOM). Click via the trash2 icon selector.
    const trashSvg = container.querySelector(".lucide-trash2");
    expect(trashSvg).not.toBeNull();
    await user.click(trashSvg!.closest("button")!);

    // Confirm dialog surfaces — click '确认'.
    await user.click(await screen.findByRole("button", { name: /^确认$/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("delete_workspace_file", {
        filename: "stale.log",
      });
    });
  });
});

import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listWorkspaceFiles,
  loadWorkspaceFile,
  loadWorkspaceFileBinary,
  saveWorkspaceFile,
  deleteWorkspaceFile,
  createWorkspaceFile,
  createWorkspaceDir,
  uploadWorkspace,
  downloadWorkspace,
  getWorkspacePath,
  listAuthorizedFolders,
  addAuthorizedFolder,
  updateAuthorizedFolder,
  removeAuthorizedFolder,
  pickFolder,
  listSensitivePatterns,
  addSensitivePattern,
  toggleSensitivePattern,
  removeSensitivePattern,
  listFolderFiles,
  type WorkspaceFile,
  type AuthorizedFolder,
  type SensitivePattern,
} from "./workspace";

const invokeMock = invoke as unknown as Mock;

describe("workspace api", () => {
  const sampleFile: WorkspaceFile = {
    name: "notes.md",
    path: "/workspace/notes.md",
    size: 128,
    is_dir: false,
    modified: 1_700_000_000,
  };

  describe("listWorkspaceFiles", () => {
    it("invokes list_workspace_files and returns the files", async () => {
      mockInvoke({ list_workspace_files: () => [sampleFile] });
      const result = await listWorkspaceFiles();
      expect(result).toEqual([sampleFile]);
      expect(invokeMock).toHaveBeenCalledWith("list_workspace_files");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_workspace_files: () => {
          throw new Error("io error");
        },
      });
      await expect(listWorkspaceFiles()).rejects.toThrow("io error");
    });
  });

  describe("loadWorkspaceFile", () => {
    it("invokes load_workspace_file with { filename } and returns content", async () => {
      mockInvoke({ load_workspace_file: () => "hello" });
      const result = await loadWorkspaceFile("notes.md");
      expect(result).toBe("hello");
      expect(invokeMock).toHaveBeenCalledWith("load_workspace_file", {
        filename: "notes.md",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        load_workspace_file: () => {
          throw new Error("not found");
        },
      });
      await expect(loadWorkspaceFile("ghost.md")).rejects.toThrow("not found");
    });
  });

  describe("loadWorkspaceFileBinary", () => {
    it("invokes load_workspace_file_binary with { filename } and returns bytes", async () => {
      mockInvoke({ load_workspace_file_binary: () => [1, 2, 3] });
      const result = await loadWorkspaceFileBinary("image.png");
      expect(result).toEqual([1, 2, 3]);
      expect(invokeMock).toHaveBeenCalledWith("load_workspace_file_binary", {
        filename: "image.png",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        load_workspace_file_binary: () => {
          throw new Error("read failed");
        },
      });
      await expect(loadWorkspaceFileBinary("x")).rejects.toThrow("read failed");
    });
  });

  describe("saveWorkspaceFile", () => {
    it("invokes save_workspace_file with { filename, content }", async () => {
      mockInvoke({ save_workspace_file: () => undefined });
      await saveWorkspaceFile("notes.md", "new content");
      expect(invokeMock).toHaveBeenCalledWith("save_workspace_file", {
        filename: "notes.md",
        content: "new content",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_workspace_file: () => {
          throw new Error("disk full");
        },
      });
      await expect(saveWorkspaceFile("a", "b")).rejects.toThrow("disk full");
    });
  });

  describe("deleteWorkspaceFile", () => {
    it("invokes delete_workspace_file with { filename }", async () => {
      mockInvoke({ delete_workspace_file: () => undefined });
      await deleteWorkspaceFile("notes.md");
      expect(invokeMock).toHaveBeenCalledWith("delete_workspace_file", {
        filename: "notes.md",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_workspace_file: () => {
          throw new Error("permission denied");
        },
      });
      await expect(deleteWorkspaceFile("x")).rejects.toThrow("permission denied");
    });
  });

  describe("createWorkspaceFile", () => {
    it("invokes create_workspace_file with { filename, content }", async () => {
      mockInvoke({ create_workspace_file: () => undefined });
      await createWorkspaceFile("new.md", "initial");
      expect(invokeMock).toHaveBeenCalledWith("create_workspace_file", {
        filename: "new.md",
        content: "initial",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_workspace_file: () => {
          throw new Error("already exists");
        },
      });
      await expect(createWorkspaceFile("a", "b")).rejects.toThrow("already exists");
    });
  });

  describe("createWorkspaceDir", () => {
    it("invokes create_workspace_dir with { dirname }", async () => {
      mockInvoke({ create_workspace_dir: () => undefined });
      await createWorkspaceDir("subdir");
      expect(invokeMock).toHaveBeenCalledWith("create_workspace_dir", {
        dirname: "subdir",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_workspace_dir: () => {
          throw new Error("already exists");
        },
      });
      await expect(createWorkspaceDir("dup")).rejects.toThrow("already exists");
    });
  });

  describe("uploadWorkspace", () => {
    it("invokes upload_workspace with { data: number[], filename }", async () => {
      mockInvoke({
        upload_workspace: () => ({ success: true, message: "uploaded" }),
      });
      const bytes = new Uint8Array([9, 8, 7]);
      const result = await uploadWorkspace(bytes, "upload.zip");
      expect(result).toEqual({ success: true, message: "uploaded" });
      expect(invokeMock).toHaveBeenCalledWith("upload_workspace", {
        data: [9, 8, 7],
        filename: "upload.zip",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        upload_workspace: () => {
          throw new Error("bad zip");
        },
      });
      await expect(
        uploadWorkspace(new Uint8Array([1]), "x.zip"),
      ).rejects.toThrow("bad zip");
    });
  });

  describe("downloadWorkspace", () => {
    it("invokes download_workspace and converts to Uint8Array", async () => {
      mockInvoke({ download_workspace: () => [1, 2, 3, 4] });
      const result = await downloadWorkspace();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([1, 2, 3, 4]);
      expect(invokeMock).toHaveBeenCalledWith("download_workspace");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        download_workspace: () => {
          throw new Error("zip failed");
        },
      });
      await expect(downloadWorkspace()).rejects.toThrow("zip failed");
    });
  });

  describe("getWorkspacePath", () => {
    it("invokes get_workspace_path and returns the path", async () => {
      mockInvoke({ get_workspace_path: () => "/Users/a/Documents/YiYi" });
      const result = await getWorkspacePath();
      expect(result).toBe("/Users/a/Documents/YiYi");
      expect(invokeMock).toHaveBeenCalledWith("get_workspace_path");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_workspace_path: () => {
          throw new Error("no workspace");
        },
      });
      await expect(getWorkspacePath()).rejects.toThrow("no workspace");
    });
  });

  describe("listAuthorizedFolders", () => {
    it("invokes list_authorized_folders and returns folders", async () => {
      const folders: AuthorizedFolder[] = [
        {
          id: "f1",
          path: "/Users/a/Docs",
          label: "Docs",
          permission: "read_write",
          is_default: false,
          created_at: 1,
          updated_at: 1,
        },
      ];
      mockInvoke({ list_authorized_folders: () => folders });
      const result = await listAuthorizedFolders();
      expect(result).toEqual(folders);
      expect(invokeMock).toHaveBeenCalledWith("list_authorized_folders");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_authorized_folders: () => {
          throw new Error("db offline");
        },
      });
      await expect(listAuthorizedFolders()).rejects.toThrow("db offline");
    });
  });

  describe("addAuthorizedFolder", () => {
    const folder: AuthorizedFolder = {
      id: "f1",
      path: "/Users/a/Docs",
      label: "Docs",
      permission: "read_only",
      is_default: false,
      created_at: 1,
      updated_at: 1,
    };

    it("invokes add_authorized_folder with { path, label, permission }", async () => {
      mockInvoke({ add_authorized_folder: () => folder });
      const result = await addAuthorizedFolder(
        "/Users/a/Docs",
        "Docs",
        "read_only",
      );
      expect(result).toEqual(folder);
      expect(invokeMock).toHaveBeenCalledWith("add_authorized_folder", {
        path: "/Users/a/Docs",
        label: "Docs",
        permission: "read_only",
      });
    });

    it("passes undefined for optional label/permission when omitted", async () => {
      mockInvoke({ add_authorized_folder: () => folder });
      await addAuthorizedFolder("/Users/a/Docs");
      expect(invokeMock).toHaveBeenCalledWith("add_authorized_folder", {
        path: "/Users/a/Docs",
        label: undefined,
        permission: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        add_authorized_folder: () => {
          throw new Error("duplicate");
        },
      });
      await expect(addAuthorizedFolder("/x")).rejects.toThrow("duplicate");
    });
  });

  describe("updateAuthorizedFolder", () => {
    it("invokes update_authorized_folder with { id, label, permission }", async () => {
      mockInvoke({ update_authorized_folder: () => undefined });
      await updateAuthorizedFolder("f1", "New Label", "read_write");
      expect(invokeMock).toHaveBeenCalledWith("update_authorized_folder", {
        id: "f1",
        label: "New Label",
        permission: "read_write",
      });
    });

    it("passes undefined for optional label/permission when omitted", async () => {
      mockInvoke({ update_authorized_folder: () => undefined });
      await updateAuthorizedFolder("f1");
      expect(invokeMock).toHaveBeenCalledWith("update_authorized_folder", {
        id: "f1",
        label: undefined,
        permission: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        update_authorized_folder: () => {
          throw new Error("not found");
        },
      });
      await expect(updateAuthorizedFolder("ghost")).rejects.toThrow("not found");
    });
  });

  describe("removeAuthorizedFolder", () => {
    it("invokes remove_authorized_folder with { id }", async () => {
      mockInvoke({ remove_authorized_folder: () => undefined });
      await removeAuthorizedFolder("f1");
      expect(invokeMock).toHaveBeenCalledWith("remove_authorized_folder", {
        id: "f1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        remove_authorized_folder: () => {
          throw new Error("not found");
        },
      });
      await expect(removeAuthorizedFolder("ghost")).rejects.toThrow("not found");
    });
  });

  describe("pickFolder", () => {
    it("invokes pick_folder and returns the picked path", async () => {
      mockInvoke({ pick_folder: () => "/Users/a/Picked" });
      const result = await pickFolder();
      expect(result).toBe("/Users/a/Picked");
      expect(invokeMock).toHaveBeenCalledWith("pick_folder");
    });

    it("returns null when user cancels", async () => {
      mockInvoke({ pick_folder: () => null });
      const result = await pickFolder();
      expect(result).toBeNull();
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pick_folder: () => {
          throw new Error("dialog failed");
        },
      });
      await expect(pickFolder()).rejects.toThrow("dialog failed");
    });
  });

  describe("listSensitivePatterns", () => {
    it("invokes list_sensitive_patterns and returns patterns", async () => {
      const patterns: SensitivePattern[] = [
        {
          id: "p1",
          pattern: ".env",
          is_builtin: true,
          enabled: true,
          created_at: 1,
        },
      ];
      mockInvoke({ list_sensitive_patterns: () => patterns });
      const result = await listSensitivePatterns();
      expect(result).toEqual(patterns);
      expect(invokeMock).toHaveBeenCalledWith("list_sensitive_patterns");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_sensitive_patterns: () => {
          throw new Error("db offline");
        },
      });
      await expect(listSensitivePatterns()).rejects.toThrow("db offline");
    });
  });

  describe("addSensitivePattern", () => {
    it("invokes add_sensitive_pattern with { pattern } and returns it", async () => {
      const pattern: SensitivePattern = {
        id: "p2",
        pattern: "*.key",
        is_builtin: false,
        enabled: true,
        created_at: 1,
      };
      mockInvoke({ add_sensitive_pattern: () => pattern });
      const result = await addSensitivePattern("*.key");
      expect(result).toEqual(pattern);
      expect(invokeMock).toHaveBeenCalledWith("add_sensitive_pattern", {
        pattern: "*.key",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        add_sensitive_pattern: () => {
          throw new Error("duplicate");
        },
      });
      await expect(addSensitivePattern("x")).rejects.toThrow("duplicate");
    });
  });

  describe("toggleSensitivePattern", () => {
    it("invokes toggle_sensitive_pattern with { id, enabled }", async () => {
      mockInvoke({ toggle_sensitive_pattern: () => undefined });
      await toggleSensitivePattern("p1", false);
      expect(invokeMock).toHaveBeenCalledWith("toggle_sensitive_pattern", {
        id: "p1",
        enabled: false,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        toggle_sensitive_pattern: () => {
          throw new Error("not found");
        },
      });
      await expect(toggleSensitivePattern("ghost", true)).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("removeSensitivePattern", () => {
    it("invokes remove_sensitive_pattern with { id }", async () => {
      mockInvoke({ remove_sensitive_pattern: () => undefined });
      await removeSensitivePattern("p1");
      expect(invokeMock).toHaveBeenCalledWith("remove_sensitive_pattern", {
        id: "p1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        remove_sensitive_pattern: () => {
          throw new Error("builtin");
        },
      });
      await expect(removeSensitivePattern("p1")).rejects.toThrow("builtin");
    });
  });

  describe("listFolderFiles", () => {
    it("invokes list_folder_files with { folderPath } and returns files", async () => {
      mockInvoke({ list_folder_files: () => [sampleFile] });
      const result = await listFolderFiles("/Users/a/Docs");
      expect(result).toEqual([sampleFile]);
      expect(invokeMock).toHaveBeenCalledWith("list_folder_files", {
        folderPath: "/Users/a/Docs",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_folder_files: () => {
          throw new Error("access denied");
        },
      });
      await expect(listFolderFiles("/x")).rejects.toThrow("access denied");
    });
  });
});

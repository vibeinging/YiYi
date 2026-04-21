import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  ptySpawn,
  ptyWrite,
  ptyResize,
  ptyClose,
  ptyList,
  type PtySessionInfo,
} from "./pty";

const invokeMock = invoke as unknown as Mock;

describe("pty api", () => {
  const sampleSession: PtySessionInfo = {
    id: "s1",
    command: "bash",
    cwd: "/tmp",
    createdAt: 1_700_000_000_000,
    isAlive: true,
  };

  describe("ptySpawn", () => {
    it("invokes pty_spawn with all args and returns the session id", async () => {
      mockInvoke({ pty_spawn: () => "s1" });
      const result = await ptySpawn("bash", ["-l"], "/tmp", 80, 24);
      expect(result).toBe("s1");
      expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {
        command: "bash",
        args: ["-l"],
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      });
    });

    it("passes undefined for omitted optional args", async () => {
      mockInvoke({ pty_spawn: () => "s2" });
      await ptySpawn("bash");
      expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {
        command: "bash",
        args: undefined,
        cwd: undefined,
        cols: undefined,
        rows: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pty_spawn: () => {
          throw new Error("spawn failed");
        },
      });
      await expect(ptySpawn("bash")).rejects.toThrow("spawn failed");
    });
  });

  describe("ptyWrite", () => {
    it("invokes pty_write with { sessionId, data }", async () => {
      mockInvoke({ pty_write: () => undefined });
      await ptyWrite("s1", "ls\n");
      expect(invokeMock).toHaveBeenCalledWith("pty_write", {
        sessionId: "s1",
        data: "ls\n",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pty_write: () => {
          throw new Error("session closed");
        },
      });
      await expect(ptyWrite("s1", "x")).rejects.toThrow("session closed");
    });
  });

  describe("ptyResize", () => {
    it("invokes pty_resize with { sessionId, cols, rows }", async () => {
      mockInvoke({ pty_resize: () => undefined });
      await ptyResize("s1", 120, 40);
      expect(invokeMock).toHaveBeenCalledWith("pty_resize", {
        sessionId: "s1",
        cols: 120,
        rows: 40,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pty_resize: () => {
          throw new Error("resize failed");
        },
      });
      await expect(ptyResize("s1", 80, 24)).rejects.toThrow("resize failed");
    });
  });

  describe("ptyClose", () => {
    it("invokes pty_close with { sessionId }", async () => {
      mockInvoke({ pty_close: () => undefined });
      await ptyClose("s1");
      expect(invokeMock).toHaveBeenCalledWith("pty_close", {
        sessionId: "s1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pty_close: () => {
          throw new Error("not found");
        },
      });
      await expect(ptyClose("missing")).rejects.toThrow("not found");
    });
  });

  describe("ptyList", () => {
    it("invokes pty_list and returns the session array", async () => {
      mockInvoke({ pty_list: () => [sampleSession] });
      const result = await ptyList();
      expect(result).toEqual([sampleSession]);
      expect(invokeMock).toHaveBeenCalledWith("pty_list");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pty_list: () => {
          throw new Error("db offline");
        },
      });
      await expect(ptyList()).rejects.toThrow("db offline");
    });
  });
});

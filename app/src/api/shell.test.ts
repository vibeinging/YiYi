import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  execute_shell,
  execute_shell_stream,
  type ShellResult,
} from "./shell";

const invokeMock = invoke as unknown as Mock;

describe("shell api", () => {
  const sampleResult: ShellResult = {
    stdout: "hello\n",
    stderr: "",
    code: 0,
  };

  describe("execute_shell", () => {
    it("invokes execute_shell with { command, args, cwd } and returns ShellResult", async () => {
      mockInvoke({ execute_shell: () => sampleResult });
      const result = await execute_shell("echo", ["hello"], "/tmp");
      expect(result).toEqual(sampleResult);
      expect(invokeMock).toHaveBeenCalledWith("execute_shell", {
        command: "echo",
        args: ["hello"],
        cwd: "/tmp",
      });
    });

    it("passes undefined for omitted optional args/cwd", async () => {
      mockInvoke({ execute_shell: () => sampleResult });
      await execute_shell("ls");
      expect(invokeMock).toHaveBeenCalledWith("execute_shell", {
        command: "ls",
        args: undefined,
        cwd: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        execute_shell: () => {
          throw new Error("permission denied");
        },
      });
      await expect(execute_shell("rm")).rejects.toThrow("permission denied");
    });
  });

  describe("execute_shell_stream", () => {
    it("invokes execute_shell_stream with { command, args, cwd } and returns the stream id", async () => {
      mockInvoke({ execute_shell_stream: () => "stream-1" });
      const result = await execute_shell_stream("tail", ["-f", "log"], "/var");
      expect(result).toBe("stream-1");
      expect(invokeMock).toHaveBeenCalledWith("execute_shell_stream", {
        command: "tail",
        args: ["-f", "log"],
        cwd: "/var",
      });
    });

    it("passes undefined for omitted optional args/cwd", async () => {
      mockInvoke({ execute_shell_stream: () => "stream-2" });
      await execute_shell_stream("ps");
      expect(invokeMock).toHaveBeenCalledWith("execute_shell_stream", {
        command: "ps",
        args: undefined,
        cwd: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        execute_shell_stream: () => {
          throw new Error("spawn failed");
        },
      });
      await expect(execute_shell_stream("nope")).rejects.toThrow(
        "spawn failed",
      );
    });
  });
});

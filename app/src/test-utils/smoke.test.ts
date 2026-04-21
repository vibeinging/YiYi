import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockInvoke } from "./mockTauri";

describe("mockTauri infrastructure", () => {
  it("unmocked invoke throws a loud error", async () => {
    await expect(invoke("some_unmocked_command")).rejects.toThrow(
      /not mocked/i,
    );
  });

  it("mockInvoke routes return the configured value", async () => {
    mockInvoke({
      echo: (args) => args?.value ?? null,
    });
    const result = await invoke<string>("echo", { value: "hello" });
    expect(result).toBe("hello");
  });

  it("mockInvoke handler can throw to simulate backend errors", async () => {
    mockInvoke({
      fail_cmd: () => {
        throw new Error("backend exploded");
      },
    });
    await expect(invoke("fail_cmd")).rejects.toThrow("backend exploded");
  });

  it("handlers that are not configured still throw", async () => {
    mockInvoke({
      known: () => "ok",
    });
    await expect(invoke("unknown")).rejects.toThrow(/not mocked/i);
  });
});

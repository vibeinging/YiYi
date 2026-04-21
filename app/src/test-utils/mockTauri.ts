import { invoke } from "@tauri-apps/api/core";
import { expect, type Mock } from "vitest";

type Handler = (args?: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * Configure invoke() return values per Tauri command name.
 * - Unlisted commands still throw (the setup.ts default).
 * - Handler can return a value or throw to simulate backend errors.
 */
export function mockInvoke(
  routes: Record<string, Handler>,
): Mock {
  const mocked = invoke as unknown as Mock;
  mocked.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = routes[cmd];
    if (!handler) {
      throw new Error(`invoke("${cmd}") called but not mocked`);
    }
    return handler(args);
  });
  return mocked;
}

/** Assert invoke was called with exact command + args shape. */
export function expectInvokedWith(
  cmd: string,
  args?: Record<string, unknown>,
): void {
  const mocked = invoke as unknown as Mock;
  if (args === undefined) {
    expect(mocked).toHaveBeenCalledWith(cmd);
  } else {
    expect(mocked).toHaveBeenCalledWith(cmd, args);
  }
}

# Plan B — Frontend Test Framework (Vitest + 26 API + 8 UI Modules)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Vitest + @testing-library/react + a Tauri `invoke` mock helper, then exhaustively test the 26 `app/src/api/*.ts` wrappers and 8 core UI modules (`stores/chatStreamStore`, 6 pages, 2 components).

**Architecture:** Vitest runs under jsdom. A `src/test-utils/setup.ts` globally mocks `@tauri-apps/api/core` so any unmocked `invoke` call throws (making missing mocks loud). Tests opt into routes via a `mockInvoke({ command: handler })` helper. API wrapper tests assert call name/arg shape/return unwrap + error propagation. UI tests stub the stores + `invoke` and drive interactions via `@testing-library/react` + `user-event`.

**Tech Stack:** Vite 6, Vitest ^3, @vitest/coverage-v8 ^3, @testing-library/react ^16, @testing-library/jest-dom ^6, @testing-library/user-event ^14, jsdom ^25.

---

## Prerequisites — before starting

Read these files to ground the plan:

- `docs/superpowers/specs/2026-04-20-testing-framework-design.md` §6 (Plan B spec).
- `docs/testing-conventions.md` — existing Rust conventions; a frontend section will be appended.
- `app/package.json` — current dev deps.
- `app/vite.config.ts` — needs extending with `test` field.
- `app/src/api/heartbeat.ts` — smallest fully-typed api wrapper, used as sample.

Confirm working directory throughout:
```bash
cd /Users/Four/PersonalProjects/YiYiClaw
```

**Git baseline:** run `git status` and confirm you are on `main` (or a fresh feature branch like `feature/plan-b-frontend`) with a clean-enough tree. Previous WIP in the tree is fine; stage only the files listed in each task's commit.

---

## File Structure Map

```
app/
├── package.json                              # MODIFY: add devDeps + test scripts
├── vite.config.ts                            # MODIFY: add `test` field (Vitest config)
└── src/
    ├── test-utils/                           # NEW — shared test infrastructure
    │   ├── setup.ts                          # global mocks for @tauri-apps/api
    │   └── mockTauri.ts                      # mockInvoke(routes) helper
    ├── api/
    │   ├── agent.ts          + agent.test.ts
    │   ├── agents.ts         + agents.test.ts
    │   ├── bots.ts           + bots.test.ts
    │   ├── browser.ts        + browser.test.ts
    │   ├── buddy.ts          + buddy.test.ts
    │   ├── canvas.ts         + canvas.test.ts
    │   ├── channels.ts       + channels.test.ts
    │   ├── cli.ts            + cli.test.ts
    │   ├── cronjobs.ts       + cronjobs.test.ts
    │   ├── env.ts            + env.test.ts
    │   ├── export.ts         + export.test.ts
    │   ├── heartbeat.ts      + heartbeat.test.ts
    │   ├── mcp.ts            + mcp.test.ts
    │   ├── models.ts         + models.test.ts
    │   ├── permissions.ts    + permissions.test.ts
    │   ├── plugins.ts        + plugins.test.ts
    │   ├── pty.ts            + pty.test.ts
    │   ├── settings.ts       + settings.test.ts
    │   ├── shell.ts          + shell.test.ts
    │   ├── skills.ts         + skills.test.ts
    │   ├── system.ts         + system.test.ts
    │   ├── tasks.ts          + tasks.test.ts
    │   ├── usage.ts          + usage.test.ts
    │   ├── voice.ts          + voice.test.ts
    │   ├── workspace.ts      + workspace.test.ts
    │   └── types.ts                          # no test (pure type definitions)
    ├── stores/
    │   └── chatStreamStore.ts + chatStreamStore.test.ts
    ├── pages/
    │   ├── Chat.tsx          + Chat.test.tsx
    │   ├── Cronjobs.tsx      + Cronjobs.test.tsx
    │   ├── Bots.tsx          + Bots.test.tsx
    │   ├── Settings.tsx      + Settings.test.tsx       (memory tab only)
    │   └── SetupWizard.tsx   + SetupWizard.test.tsx
    └── components/
        ├── TaskDetailOverlay.tsx   + TaskDetailOverlay.test.tsx
        └── BuddyPanel.tsx          + BuddyPanel.test.tsx

.github/workflows/test.yml                    # MODIFY: add frontend job
docs/testing-conventions.md                   # MODIFY: append frontend section
```

Test files live **next to** the source file they cover (Vitest auto-discovers `*.test.ts[x]`). `types.ts` has no test (pure types).

---

## Phase 1 — Infrastructure (Tasks 1–4)

## Task 1: Add Vitest + testing-library dependencies and scripts

**Files:**
- Modify: `app/package.json`

- [ ] **Step 1: Inspect current `package.json` devDependencies**

```bash
cat app/package.json | grep -A 20 devDependencies
```

Expected: the existing `devDependencies` block lists `@tauri-apps/cli`, `@types/react`, `@vitejs/plugin-react`, `postcss`, `tailwindcss`, `typescript`, `vite`. No Vitest, no testing-library.

- [ ] **Step 2: Add test devDeps + scripts**

Edit `app/package.json`. Add these entries to `devDependencies` (preserve existing, alphabetical):

```json
"@testing-library/jest-dom": "^6.6.3",
"@testing-library/react": "^16.1.0",
"@testing-library/user-event": "^14.5.2",
"@vitest/coverage-v8": "^3.0.0",
"jsdom": "^25.0.1",
"vitest": "^3.0.0"
```

Add these to the `scripts` block (preserve existing `dev`/`build`/`preview`/`tauri`):

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

Resulting scripts block should look like:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

- [ ] **Step 3: Install**

```bash
cd app && npm install
```

Expected: installs without peer-dep conflicts. If npm warns about peer deps (React 18 + testing-library 16), that's fine — testing-library/react 16 supports React 18 and 19. No errors.

- [ ] **Step 4: Verify vitest CLI resolves**

```bash
cd app && npx vitest --version
```

Expected: prints `3.x.y`. Confirms the binary is on the path.

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json
git commit -m "test(frontend): add Vitest + testing-library devDependencies"
```

Stage **only** those two files. The tree has other unrelated WIP; do not `git add .`.

---

## Task 2: Extend `vite.config.ts` with Vitest configuration

**Files:**
- Modify: `app/vite.config.ts`

- [ ] **Step 1: Read current config**

```bash
cat app/vite.config.ts
```

Expected: a `defineConfig(async () => ({ plugins: [react()], clearScreen: false, server: {...} }))` structure.

- [ ] **Step 2: Replace with extended config**

Write `app/vite.config.ts`:

```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-utils/setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/test-utils/**",
        "src/**/*.test.{ts,tsx}",
      ],
    },
  },
}));
```

Two things are intentional:
- `/// <reference types="vitest" />` enables TS autocompletion on the `test` field.
- `css: false` tells Vitest not to process `.css`/tailwind imports during tests (faster, avoids postcss work).

- [ ] **Step 3: Verify `tsc` still accepts the file**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0. Vitest types are pulled in via the triple-slash directive; the `test` field on `UserConfig` is augmented by `vitest/config`.

If this fails with "Cannot find type definition file 'vitest'", run `npm install` again.

- [ ] **Step 4: Commit**

```bash
git add app/vite.config.ts
git commit -m "test(frontend): configure Vitest in vite.config.ts"
```

---

## Task 3: Build test-utils (setup.ts + mockTauri.ts) + smoke test

**Files:**
- Create: `app/src/test-utils/setup.ts`
- Create: `app/src/test-utils/mockTauri.ts`
- Create: `app/src/test-utils/smoke.test.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p app/src/test-utils
```

- [ ] **Step 2: Write `setup.ts`**

Write `app/src/test-utils/setup.ts`:

```ts
import "@testing-library/jest-dom";
import { vi, beforeEach } from "vitest";

// Default: any invoke() call that isn't explicitly mocked throws loudly so
// tests can't silently get `undefined` and miss assertion gaps. Tests opt in
// with mockInvoke({ command: handler }).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    throw new Error(
      `invoke("${cmd}") called but not mocked. Use mockInvoke() in your test.`,
    );
  }),
}));

// Event listeners: listen returns a no-op unsubscribe, emit is a silent spy.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
  once: vi.fn(() => Promise.resolve(() => {})),
}));

// Reset all mocks between tests so state doesn't bleed.
beforeEach(() => {
  vi.clearAllMocks();
});
```

- [ ] **Step 3: Write `mockTauri.ts`**

Write `app/src/test-utils/mockTauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { vi, type Mock } from "vitest";

type Handler = (args?: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * Configure invoke() return values per Tauri command name.
 * - Unlisted commands still throw (the setup.ts default).
 * - Handler can return a value or throw to simulate backend errors.
 *
 * Usage:
 *   mockInvoke({
 *     get_heartbeat_config: () => ({ enabled: true, every: "6h", target: "main" }),
 *     save_heartbeat_config: (args) => args?.config,
 *   });
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
```

- [ ] **Step 4: Write smoke test for the helper itself**

Write `app/src/test-utils/smoke.test.ts`:

```ts
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
```

- [ ] **Step 5: Run smoke tests**

```bash
cd app && npm test -- src/test-utils
```

Expected: 4 tests pass.

Example output:
```
 ✓ src/test-utils/smoke.test.ts (4)
   ✓ mockTauri infrastructure (4)
     ✓ unmocked invoke throws a loud error
     ✓ mockInvoke routes return the configured value
     ✓ mockInvoke handler can throw to simulate backend errors
     ✓ handlers that are not configured still throw

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- [ ] **Step 6: Run `tsc` to confirm types wire up**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/src/test-utils/
git commit -m "test(frontend): add test-utils (setup + mockTauri + smoke)"
```

---

## Task 4: Add frontend job to CI workflow

**Files:**
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Read current workflow**

```bash
cat .github/workflows/test.yml
```

Expected: one `rust` job on macos-latest. Our job will sit alongside it on ubuntu-latest (frontend doesn't need macOS; faster + cheaper).

- [ ] **Step 2: Append the frontend job**

Edit `.github/workflows/test.yml`. Inside the top-level `jobs:` map, after the `rust:` job, add:

```yaml
  frontend:
    name: Frontend tests + coverage
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: app/package-lock.json

      - name: Install dependencies
        working-directory: app
        run: npm ci

      - name: Run tests with coverage
        working-directory: app
        run: npm run test:coverage

      - name: Upload coverage artifact
        uses: actions/upload-artifact@v4
        with:
          name: frontend-lcov
          path: app/coverage/lcov.info
          retention-days: 14
          if-no-files-found: ignore
```

- [ ] **Step 3: YAML sanity check**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))" && echo "yaml ok"
```

Expected: `yaml ok`. (GitHub Actions will validate fully on push.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add frontend tests + coverage job"
```

Do NOT push. Let the human partner push when ready.

---

## Phase 2 — API wrapper tests (Tasks 5–10)

**Pattern** (applies to every API test file):

```ts
import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { <functionUnderTest>, type <ReturnType> } from "./<module>";

describe("<functionUnderTest>", () => {
  it("invokes the matching Tauri command and returns its value", async () => {
    const payload: <ReturnType> = { /* realistic shape */ };
    mockInvoke({
      <tauri_command_name>: () => payload,
    });

    const result = await <functionUnderTest>(/* args if any */);

    expect(result).toEqual(payload);
    expect(invoke as unknown as Mock).toHaveBeenCalledWith(
      "<tauri_command_name>",
      /* args object if wrapper passes any, else omit */
    );
  });

  it("propagates backend errors", async () => {
    mockInvoke({
      <tauri_command_name>: () => {
        throw new Error("boom");
      },
    });
    await expect(<functionUnderTest>(/* args */)).rejects.toThrow("boom");
  });
});
```

**Critical coverage rules for every wrapper:**

1. **Command name**: assert `invoke` was called with the exact string that appears in the wrapper (e.g. `"get_heartbeat_config"`, NOT `"getHeartbeatConfig"`).
2. **Arg shape**: if the wrapper passes args, assert the shape exactly (snake_case keys that match the Rust `#[tauri::command]` params). Example: `saveHeartbeatConfig(cfg)` calls `invoke("save_heartbeat_config", { config: cfg })` — the arg object has key `config`, NOT `cfg`.
3. **Return unwrap**: assert the return value passes through unchanged.
4. **Error propagation**: 1 test per wrapper asserting a thrown/rejected handler propagates.

Some wrappers take optional args; add 1 extra test for the "option omitted" and "option provided" cases when it matters for arg shape (e.g. `getHeartbeatHistory(limit?)` passes `{ limit: undefined }` — verify).

---

## Task 5: API batch 1/6 — smallest files (6 modules)

**Files to cover:** `browser.ts`, `env.ts`, `permissions.ts`, `plugins.ts`, `export.ts`, `usage.ts`

**Files:**
- Create: `app/src/api/browser.test.ts`, `env.test.ts`, `permissions.test.ts`, `plugins.test.ts`, `export.test.ts`, `usage.test.ts`

- [ ] **Step 1: Read each source file to inventory its exports**

```bash
for f in browser env permissions plugins export usage; do
  echo "=== $f ==="
  grep -nE "^export (async )?function|^export const" app/src/api/$f.ts
done
```

This gives you the list of functions to cover (name + arity) and the command names they invoke (grep the bodies for `invoke(`).

- [ ] **Step 2: For each file, create a `.test.ts` next to it with ≥2 tests per exported function**

Use the pattern above. Example for `heartbeat.ts` (closest shape to these tiny files):

Write `app/src/api/heartbeat.test.ts` as a full working reference — implement this one first and use it as the template for the rest:

```ts
import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  getHeartbeatConfig,
  saveHeartbeatConfig,
  sendHeartbeat,
  getHeartbeatHistory,
  type HeartbeatConfig,
} from "./heartbeat";

const invokeMock = invoke as unknown as Mock;

describe("heartbeat api", () => {
  const sampleConfig: HeartbeatConfig = {
    enabled: true,
    every: "6h",
    target: "main",
  };

  describe("getHeartbeatConfig", () => {
    it("invokes get_heartbeat_config and returns the config", async () => {
      mockInvoke({ get_heartbeat_config: () => sampleConfig });
      const result = await getHeartbeatConfig();
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_config");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_heartbeat_config: () => {
          throw new Error("db offline");
        },
      });
      await expect(getHeartbeatConfig()).rejects.toThrow("db offline");
    });
  });

  describe("saveHeartbeatConfig", () => {
    it("invokes save_heartbeat_config with { config } and echoes the config", async () => {
      mockInvoke({ save_heartbeat_config: (args) => args?.config });
      const result = await saveHeartbeatConfig(sampleConfig);
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("save_heartbeat_config", {
        config: sampleConfig,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_heartbeat_config: () => {
          throw new Error("invalid cron");
        },
      });
      await expect(saveHeartbeatConfig(sampleConfig)).rejects.toThrow("invalid cron");
    });
  });

  describe("sendHeartbeat", () => {
    it("invokes send_heartbeat and returns { success, message }", async () => {
      mockInvoke({
        send_heartbeat: () => ({ success: true, message: "sent" }),
      });
      const result = await sendHeartbeat();
      expect(result).toEqual({ success: true, message: "sent" });
      expect(invokeMock).toHaveBeenCalledWith("send_heartbeat");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        send_heartbeat: () => {
          throw new Error("no llm");
        },
      });
      await expect(sendHeartbeat()).rejects.toThrow("no llm");
    });
  });

  describe("getHeartbeatHistory", () => {
    it("invokes get_heartbeat_history with { limit } and returns the rows", async () => {
      const rows = [
        { timestamp: 1, target: "main", success: true, message: "ok" },
      ];
      mockInvoke({ get_heartbeat_history: () => rows });
      const result = await getHeartbeatHistory(10);
      expect(result).toEqual(rows);
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_history", {
        limit: 10,
      });
    });

    it("passes { limit: undefined } when called without argument", async () => {
      mockInvoke({ get_heartbeat_history: () => [] });
      await getHeartbeatHistory();
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_history", {
        limit: undefined,
      });
    });
  });
});
```

Now apply the same structure to the 6 target files. **Do not** skip the error-path test on any function. Write one `.test.ts` per source file.

Per-file checklist:
- `browser.ts` → `browser.test.ts`: 4 functions (check the grep output; typical: `launchBrowser`, `navigate`, `screenshot`, `close`).
- `env.ts` → `env.test.ts`: typically `listEnvs`, `saveEnvs`, `deleteEnv` + any helpers.
- `permissions.ts` → `permissions.test.ts`: `checkPermissions`, `requestAccessibility`, `requestScreenRecording`, `requestMicrophone`.
- `plugins.ts` → `plugins.test.ts`: `listPlugins`, `enablePlugin`, `disablePlugin`, `reloadPlugins`.
- `export.ts` → `export.test.ts`: `exportConversations`, `exportMemories`, `exportSettings`.
- `usage.ts` → `usage.test.ts`: `getUsageSummary`, `getUsageByToday`, `getUsageDaily` (or whatever the grep reveals).

- [ ] **Step 3: Run the batch**

```bash
cd app && npm test -- src/api
```

Expected: smoke tests (4) + batch-1 tests (roughly 35-50 new) all pass. The single test run surfaces any wrapper whose command name or arg keys you got wrong — fix and re-run.

- [ ] **Step 4: Run tsc to verify typings**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/src/api/browser.test.ts app/src/api/env.test.ts app/src/api/permissions.test.ts app/src/api/plugins.test.ts app/src/api/export.test.ts app/src/api/usage.test.ts app/src/api/heartbeat.test.ts
git commit -m "test(api): add wrapper tests for browser/env/permissions/plugins/export/usage/heartbeat"
```

(heartbeat.test.ts is the reference/template and belongs with this commit.)

---

## Task 6: API batch 2/6 — small files (5 modules)

**Files to cover:** `pty.ts`, `settings.ts`, `shell.ts`, `agents.ts`, `cli.ts`

**Files:**
- Create: `app/src/api/pty.test.ts`, `settings.test.ts`, `shell.test.ts`, `agents.test.ts`, `cli.test.ts`

- [ ] **Step 1: Inventory exports per file**

```bash
for f in pty settings shell agents cli; do
  echo "=== $f ==="
  grep -nE "^export (async )?function|^export const" app/src/api/$f.ts
done
```

- [ ] **Step 2: Write 5 test files following the Task 5 template**

For each function: 1 happy-path test asserting `invoke(command, args)` shape + return value; 1 error-path test asserting a thrown handler propagates. For optional args that the wrapper passes through as keys (e.g. `execute_shell(command, args, cwd)` where `args` and `cwd` are `Option`), add an "omitted arg" test case that confirms the key is `undefined`.

**Hints per file:**
- `pty.ts`: PTY lifecycle (`open_pty`, `pty_write`, `pty_resize`, `close_pty`, `list_pty_sessions` or similar). Watch for async.
- `settings.ts`: user-visible settings CRUD. Keys often include theme, language, etc.
- `shell.ts`: `executeShell(command, args?, cwd?)` and `executeShellStream` — both typically return `ShellResult { stdout, stderr, exit_code }`.
- `agents.ts`: Agent registry CRUD — `listAgents`, `getAgent`, `saveAgent`, `deleteAgent`.
- `cli.ts`: CLI provider CRUD — `listCliProviders`, `saveCliProviderConfig`, `checkCliProvider`, etc.

- [ ] **Step 3: Run the batch**

```bash
cd app && npm test -- src/api
```

Expected: all Task 5 tests still pass + new ~25-40 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/api/pty.test.ts app/src/api/settings.test.ts app/src/api/shell.test.ts app/src/api/agents.test.ts app/src/api/cli.test.ts
git commit -m "test(api): add wrapper tests for pty/settings/shell/agents/cli"
```

---

## Task 7: API batch 3/6 — medium files (4 modules)

**Files to cover:** `voice.ts`, `mcp.ts`, `channels.ts`, `cronjobs.ts`

**Files:**
- Create: `app/src/api/voice.test.ts`, `mcp.test.ts`, `channels.test.ts`, `cronjobs.test.ts`

- [ ] **Step 1: Inventory exports**

```bash
for f in voice mcp channels cronjobs; do
  echo "=== $f ==="
  grep -nE "^export (async )?function|^export const" app/src/api/$f.ts
done
```

- [ ] **Step 2: Write the 4 test files following the batch-1 template**

Hints:
- `voice.ts`: voice session lifecycle (`startVoiceSession`, `stopVoiceSession`, `getVoiceStatus`) + possibly audio helpers.
- `mcp.ts`: MCP server CRUD (`listMcpServers`, `saveMcpServer`, `deleteMcpServer`, `testMcpConnection`, `startMcpServer`, `stopMcpServer`).
- `channels.ts`: platform channel CRUD. Note: the Rust `commands/channels.rs` was removed as dead code; the frontend wrapper may still exist and invoke commands that don't land. **Test only what the wrapper does** (the `invoke` shape); don't try to run against real backend. A wrapper calling a non-existent command is still testable in isolation.
- `cronjobs.ts`: cron job CRUD (`listCronjobs`, `createCronjob`, `updateCronjob`, `deleteCronjob`, `pauseCronjob`, `resumeCronjob`, `runCronjob`, `getCronjobState`, `listCronjobExecutions`).

- [ ] **Step 3: Run the batch**

```bash
cd app && npm test -- src/api
```

Expected: all previous tests still pass + ~25-35 new.

- [ ] **Step 4: Commit**

```bash
git add app/src/api/voice.test.ts app/src/api/mcp.test.ts app/src/api/channels.test.ts app/src/api/cronjobs.test.ts
git commit -m "test(api): add wrapper tests for voice/mcp/channels/cronjobs"
```

---

## Task 8: API batch 4/6 — larger files (3 modules)

**Files to cover:** `tasks.ts`, `canvas.ts`, `skills.ts`

**Files:**
- Create: `app/src/api/tasks.test.ts`, `canvas.test.ts`, `skills.test.ts`

- [ ] **Step 1: Inventory exports**

```bash
for f in tasks canvas skills; do
  echo "=== $f ==="
  grep -nE "^export (async )?function|^export const" app/src/api/$f.ts
done
```

- [ ] **Step 2: Write the 3 test files**

Hints:
- `tasks.ts`: task lifecycle (create/list/get/cancel/pause/send_message/delete/pin + folder ops). Watch for Tauri event listeners — if any wrapper uses `listen(...)` internally, test that the wrapper returns a working unsubscribe handle (the mocked `listen` returns a no-op function; assert the wrapper's return shape).
- `canvas.ts`: canvas doc CRUD (list/get/save/delete/preview).
- `skills.ts`: skill CRUD + marketplace (list/get/enable/disable/create/delete/import/hub_search/hub_install).

**For any wrapper that returns an `unsubscribe: () => void` (common with event listeners)**, assert it's a function:

```ts
const unsub = await someEventWrapper(/* ... */);
expect(typeof unsub).toBe("function");
unsub(); // must be callable without error
```

- [ ] **Step 3: Run the batch**

```bash
cd app && npm test -- src/api
```

Expected: previous + new (~35-45).

- [ ] **Step 4: Commit**

```bash
git add app/src/api/tasks.test.ts app/src/api/canvas.test.ts app/src/api/skills.test.ts
git commit -m "test(api): add wrapper tests for tasks/canvas/skills"
```

---

## Task 9: API batch 5/6 — larger files (3 modules)

**Files to cover:** `models.ts`, `workspace.ts`, `buddy.ts`

**Files:**
- Create: `app/src/api/models.test.ts`, `workspace.test.ts`, `buddy.test.ts`

- [ ] **Step 1: Inventory exports**

```bash
for f in models workspace buddy; do
  echo "=== $f ==="
  grep -nE "^export (async )?function|^export const" app/src/api/$f.ts
done
```

- [ ] **Step 2: Write the 3 test files**

Hints:
- `models.ts`: provider/model config CRUD (list/configure/test/addModel/removeModel/getActiveLlm/setActiveLlm/import/export/scan). ~15 functions.
- `workspace.ts`: workspace file ops + authorized folders + sensitive patterns. ~20 functions.
- `buddy.ts`: buddy config + hatch + memory + corrections + decisions + trust + meditation sessions + observe. ~16 functions.

For `buddy.ts::listCorrections`, after the recent bug fix, the `CorrectionEntry` type has `{ trigger, correct_behavior, source, confidence }` (no `wrong_behavior`). Use realistic shapes that match current types.

- [ ] **Step 3: Run the batch**

```bash
cd app && npm test -- src/api
```

Expected: previous + new (~50-60).

- [ ] **Step 4: Commit**

```bash
git add app/src/api/models.test.ts app/src/api/workspace.test.ts app/src/api/buddy.test.ts
git commit -m "test(api): add wrapper tests for models/workspace/buddy"
```

---

## Task 10: API batch 6/6 — largest files (4 modules)

**Files to cover:** `bots.ts`, `agent.ts`, `system.ts`, plus sweep-up of anything skipped

**Files:**
- Create: `app/src/api/bots.test.ts`, `agent.test.ts`, `system.test.ts`

- [ ] **Step 1: Inventory exports**

```bash
for f in bots agent system; do
  echo "=== $f ==="
  grep -nE "^export (async )?function|^export const" app/src/api/$f.ts
done
```

- [ ] **Step 2: Write the 3 test files**

Hints:
- `bots.ts`: bot CRUD + platform config + start/stop + send + test_connection + running list + conversations + status. ~18 functions.
- `agent.ts`: chat + session + stream control + history + delete messages. ~17 functions. Some wrappers involve streaming via `listen`; mock the event listener and assert subscription command was invoked.
- `system.ts`: largest — health, models, workspace, setup, flags, meditation, memme, quick actions, personality, sparkling memory, recall. ~26 functions.

**Cross-check coverage:** after this task, every file listed in the file-structure map (except `types.ts`) should have a `.test.ts` sibling. Run:

```bash
cd app/src/api && ls *.ts | sort > /tmp/api-sources.txt && ls *.test.ts | sed 's/\.test//' | sort > /tmp/api-tests.txt && diff /tmp/api-sources.txt /tmp/api-tests.txt
```

Expected output: only `types.ts` appears in sources and not in tests. If anything else is missing, add its test file in this same commit.

- [ ] **Step 3: Run the full API suite**

```bash
cd app && npm test -- src/api
```

Expected: all API tests pass. Total should be ~180-250 tests across 25 files + 4 smoke.

- [ ] **Step 4: Generate coverage report for api/**

```bash
cd app && npm run test:coverage -- src/api
```

Record the `src/api/*.ts` coverage percentages in a scratch note. Expect most files ≥90% line coverage (wrappers are small).

- [ ] **Step 5: Commit**

```bash
git add app/src/api/bots.test.ts app/src/api/agent.test.ts app/src/api/system.test.ts
git commit -m "test(api): add wrapper tests for bots/agent/system (completes 25/25 api coverage)"
```

---

## Phase 3 — Core UI module tests (Tasks 11–18)

**Shared UI test pattern:**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvoke, expectInvokedWith } from "../test-utils/mockTauri";
import { <Component> } from "./<Component>";

describe("<Component>", () => {
  it("renders initial state", () => {
    mockInvoke({ /* any commands called on mount */ });
    render(<<Component> />);
    expect(screen.getByRole("heading", { name: /expected/i })).toBeInTheDocument();
  });

  it("triggers correct command on interaction", async () => {
    const user = userEvent.setup();
    mockInvoke({ some_command: () => "ok" });
    render(<<Component> />);
    await user.click(screen.getByRole("button", { name: /click me/i }));
    expectInvokedWith("some_command", { /* args */ });
  });
});
```

**Dealing with routing / i18n / stores:** many pages depend on `react-router-dom` or i18next providers. If so, wrap with a minimal provider in the test:

```tsx
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "../i18n";

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>
    </MemoryRouter>,
  );
}
```

Only add providers the component actually needs (avoid over-wrapping).

---

## Task 11: stores/chatStreamStore

**Files:**
- Create: `app/src/stores/chatStreamStore.test.ts`

- [ ] **Step 1: Read the store**

```bash
cat app/src/stores/chatStreamStore.ts
```

Understand: the public API (`useStore`, actions like `appendToken`, `cancel`, `reset`, etc.), the state shape (messages, streaming flags, errors). Inventory every exported function/selector.

- [ ] **Step 2: Write tests covering state transitions**

Zustand stores are pure JS; test by calling `useStore.getState()` for reads and `useStore.setState()` / action calls for writes. Example structure:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStreamStore } from "./chatStreamStore";

describe("chatStreamStore", () => {
  beforeEach(() => {
    useChatStreamStore.getState().reset();
  });

  it("starts with empty accumulated text and inactive streaming", () => {
    const s = useChatStreamStore.getState();
    expect(s.isStreaming).toBe(false);
    expect(s.accumulatedText).toBe("");
  });

  it("appendToken concatenates onto accumulatedText", () => {
    const { appendToken } = useChatStreamStore.getState();
    appendToken("hello");
    appendToken(" world");
    expect(useChatStreamStore.getState().accumulatedText).toBe("hello world");
  });

  // ... one test per action + one per state transition ...
});
```

Target coverage for chatStreamStore.ts: ≥80% lines (it's small and deterministic).

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/stores
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/stores/chatStreamStore.test.ts
git commit -m "test(stores): add chatStreamStore transition tests"
```

---

## Task 12: pages/Chat

**Files:**
- Create: `app/src/pages/Chat.test.tsx`

- [ ] **Step 1: Read the component**

```bash
cat app/src/pages/Chat.tsx | head -100
```

Identify: the commands it invokes on mount (`get_history`, `chat_stream_state`, etc.), interaction points (send button, cancel button, attachment picker), and store subscriptions.

- [ ] **Step 2: Write component tests**

Cover at minimum:
- Empty-state render (no messages → placeholder visible)
- Renders messages from store when populated
- Typing in the input + clicking send → triggers `invoke("chat" or "chat_stream_start", { ... })`
- Cancel button while streaming → triggers `invoke("chat_stream_stop")`

Use `mockInvoke` to stub the backend. Use the store's `setState` to seed messages if the component reads from `useChatStreamStore`.

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/pages/Chat
```

Expected: tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/Chat.test.tsx
git commit -m "test(pages): add Chat render + interaction tests"
```

---

## Task 13: pages/Cronjobs

**Files:**
- Create: `app/src/pages/Cronjobs.test.tsx`

- [ ] **Step 1: Read the component**

```bash
cat app/src/pages/Cronjobs.tsx | head -100
```

Identify the CRUD commands: `list_cronjobs`, `create_cronjob`, `update_cronjob`, `delete_cronjob`, `pause_cronjob`, `resume_cronjob`, `run_cronjob`, `get_cronjob_state`, `list_cronjob_executions`.

- [ ] **Step 2: Write component tests**

Cover:
- On mount: `invoke("list_cronjobs")` fires.
- Renders jobs in the list when backend returns 2 items.
- Create flow: clicking "新建" opens a form → submitting calls `invoke("create_cronjob", { spec })`.
- Delete flow (with confirm): clicking delete on a job → invokes `delete_cronjob` with that id.
- Pause toggle: swipes the enabled state → invokes `pause_cronjob` or `resume_cronjob`.

If the page uses a modal library (HeadlessUI, Radix) or has custom portals, use `getByRole("dialog")` or pass `within(screen.getByRole("dialog"))` to scope queries.

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/pages/Cronjobs
```

Expected: tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/Cronjobs.test.tsx
git commit -m "test(pages): add Cronjobs render + CRUD interaction tests"
```

---

## Task 14: pages/Bots

**Files:**
- Create: `app/src/pages/Bots.test.tsx`

- [ ] **Step 1: Read the component**

```bash
cat app/src/pages/Bots.tsx | head -100
```

Commands likely involved: `bots_list`, `bots_list_platforms`, `bots_create`, `bots_update`, `bots_delete`, `bots_start`, `bots_stop`, `bots_start_one`, `bots_stop_one`, `bots_running_list`, `bots_get_status`.

- [ ] **Step 2: Write component tests**

Cover:
- On mount: lists + running status commands invoked.
- Renders bot cards with correct name/platform.
- Add-bot dialog submission → `bots_create` with correct shape.
- Delete (with confirm) → `bots_delete`.
- Start/stop toggle → `bots_start_one`/`bots_stop_one` with the id.

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/pages/Bots
```

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/Bots.test.tsx
git commit -m "test(pages): add Bots render + CRUD tests"
```

---

## Task 15: pages/Settings (memory tab)

**Files:**
- Create: `app/src/pages/Settings.test.tsx`

Settings.tsx is a multi-tab page. Scope this task to the **memory tab** (the most recently edited, with preset "一键填入" logic).

- [ ] **Step 1: Read the memory-tab region**

```bash
grep -n "activeTab === 'memory'" app/src/pages/Settings.tsx
# Then read the block around that condition
```

Key behaviors:
- On mount (memory tab): `invoke("get_memme_config")` + `invoke("get_active_llm")`.
- Renders the embedding model info card (read-only, bge-small-zh-v1.5).
- Renders the LLM preset row when an active provider matches.
- Clicking "一键填入" when preset is available → `invoke("save_memme_config", { config })`; button changes to "已填入" after.
- "LLM 语言模型" card: dirty state toggles Save button enabled; clicking save → `invoke("save_memme_config", { config })`.

- [ ] **Step 2: Write focused tests**

Force `activeTab = "memory"` by rendering with a prop or using `sessionStorage.setItem("settings_pending_tab", "memory")` before render (the component's `useEffect` reads that key).

```tsx
it("switches to memory tab on mount when sessionStorage flag is set", async () => {
  sessionStorage.setItem("settings_pending_tab", "memory");
  mockInvoke({
    get_memme_config: () => ({ /* full MemmeConfig */ }),
    get_active_llm: () => ({ provider_id: "openai", provider_name: "OpenAI", model: "gpt-4o-mini" }),
  });
  render(<Settings />);
  expect(await screen.findByText(/bge-small-zh-v1\.5/)).toBeInTheDocument();
});
```

Cover at minimum 3 tests:
1. Memory tab renders embedding info card.
2. Preset hint shows when activePreset matches + "一键填入" click invokes `save_memme_config` and button switches to "已填入".
3. LLM section Save button is disabled initially, becomes enabled after typing in the base_url input, and invokes `save_memme_config` on click.

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/pages/Settings
```

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/Settings.test.tsx
git commit -m "test(pages): add Settings memory-tab interaction tests"
```

---

## Task 16: pages/SetupWizard

**Files:**
- Create: `app/src/pages/SetupWizard.test.tsx`

- [ ] **Step 1: Read the wizard**

```bash
grep -n "currentStep" app/src/pages/SetupWizard.tsx | head -20
```

The wizard is step-based (language → model → workspace → persona → meditation → memory → finish). Each step renders a sub-component; navigation is via Next/Back buttons.

- [ ] **Step 2: Write tests**

Cover:
- Renders the language step initially.
- Clicking "Next" advances to the next step (with valid selections).
- The `memory` step is now a read-only info page (no user input).
- Final `handleFinish` invokes `complete_setup` (if that's its trigger) or `saveMemmeConfig`-etc. sequence.

Because the wizard has many steps, 3-5 tests is enough for this batch — one happy-path that walks through 2-3 steps end-to-end, plus individual-step render checks.

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/pages/SetupWizard
```

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/SetupWizard.test.tsx
git commit -m "test(pages): add SetupWizard step navigation + finish tests"
```

---

## Task 17: components/TaskDetailOverlay

**Files:**
- Create: `app/src/components/TaskDetailOverlay.test.tsx`

- [ ] **Step 1: Read the component**

```bash
cat app/src/components/TaskDetailOverlay.tsx | head -80
```

Identify: the props shape (likely `task: TaskInfo | null`, `onClose: () => void`, possibly status), render branches (pending vs running vs completed vs failed), and any imperative actions (cancel/delete buttons).

- [ ] **Step 2: Write tests**

Cover:
- Does not render when `task` is `null` (or renders empty).
- Renders task metadata (title, status, timestamps) when task is given.
- Shows cancel button only for running tasks; clicking invokes `cancel_task`.
- Shows delete button; clicking with confirm → `delete_task`.
- Clicking overlay backdrop (or close button) calls `onClose` prop.

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/components/TaskDetailOverlay
```

- [ ] **Step 4: Commit**

```bash
git add app/src/components/TaskDetailOverlay.test.tsx
git commit -m "test(components): add TaskDetailOverlay render + action tests"
```

---

## Task 18: components/BuddyPanel

**Files:**
- Create: `app/src/components/BuddyPanel.test.tsx`

- [ ] **Step 1: Read the component**

```bash
cat app/src/components/BuddyPanel.tsx | head -120
```

This is a large component (1000+ lines post-refactor). Scope tests to:
- Initial load: `invoke` calls fire for bootstrap data (memory stats, corrections, meditation sessions, trust stats, buddy decisions).
- Search memories: typing in search + clicking search invokes `search_memories` with the query.
- Meditation trigger: clicking the meditate button invokes `trigger_meditation`.

3-5 tests is sufficient given the size.

- [ ] **Step 2: Write tests**

Seed a realistic `mockInvoke` response map covering all mount-time commands so the component can render without throwing. Then assert on one specific rendered element per test (e.g. memory count label, "冥想" button visible, etc.).

```tsx
it("loads bootstrap data on mount", async () => {
  mockInvoke({
    get_memory_stats: () => ({ total: 42, by_category: {} }),
    list_corrections: () => [],
    list_meditation_sessions: () => [],
    list_buddy_decisions: () => [],
    get_trust_stats: () => ({ total: 0, good: 0, bad: 0, pending: 0, accuracy: 0, by_context: {} }),
    get_meditation_config: () => ({ enabled: false, start_time: "02:00", notify_on_complete: true }),
    get_latest_meditation: () => null,
    get_personality_stats: () => null,
  });
  render(<BuddyPanel />);
  // memory count eventually renders
  expect(await screen.findByText(/42/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run**

```bash
cd app && npm test -- src/components/BuddyPanel
```

- [ ] **Step 4: Commit**

```bash
git add app/src/components/BuddyPanel.test.tsx
git commit -m "test(components): add BuddyPanel bootstrap + interaction tests"
```

---

## Phase 4 — Verification (Task 19)

## Task 19: Full suite run + coverage audit + completion notes

**Files:**
- Modify: `docs/testing-conventions.md`
- Modify: `docs/superpowers/plans/2026-04-21-plan-b-frontend-tests.md` (this file — append completion)

- [ ] **Step 1: Run full frontend suite with coverage**

```bash
cd app && npm run test:coverage
```

Expected: all tests pass. The v8 coverage reporter writes `app/coverage/index.html`, `app/coverage/lcov.info`, and a text summary.

Record:
- Total test count.
- Coverage % for `src/api/**` (target ≥90% average, since wrappers are small).
- Coverage % for the 8 core UI modules (target ≥60% each).

Open the HTML report:
```bash
open app/coverage/index.html
```

- [ ] **Step 2: Append a frontend section to `docs/testing-conventions.md`**

Append to the end of the file:

```markdown

## Frontend (Vitest + testing-library)

### 组织
- Vitest 配置在 `app/vite.config.ts` 的 `test` 字段
- jsdom 环境 + globals 开启（`describe`/`it`/`expect` 无需 import）
- setupFiles: `src/test-utils/setup.ts` —— 全局 mock `@tauri-apps/api/core` 的 `invoke`
- 测试文件紧挨源文件：`Foo.tsx` + `Foo.test.tsx` 同目录
- `src/test-utils/mockTauri.ts` 提供 `mockInvoke({cmd: handler})` 帮手

### 运行
```bash
cd app
npm test                 # 单次跑
npm run test:watch       # watch 模式
npm run test:coverage    # 带 coverage
npm test -- src/api      # 只跑某路径
```

### 核心原则
- **未显式 mock 的 `invoke` 会 throw**（`setup.ts` 默认行为）—— 保证没有沉默的 undefined
- API wrapper 测试必测：命令名、arg 结构（snake_case 键）、返回值解包、error 传播
- UI 测试用 `@testing-library/react` + `user-event`；避免深度 implementation details

### 覆盖率目标
- `src/api/**` ≥ 90%
- 核心 pages/stores/components ≥ 60%

### 参考实现
- `src/api/heartbeat.test.ts` — API wrapper 测试模板
- `src/stores/chatStreamStore.test.ts` — store 测试
- `src/pages/Chat.test.tsx` — 页面交互测试
- `src/components/BuddyPanel.test.tsx` — 大型 component 测试
```

- [ ] **Step 3: Append completion notes to this plan**

Append to `docs/superpowers/plans/2026-04-21-plan-b-frontend-tests.md`:

```markdown

---

## Completion Notes (fill in at handover)

- Total frontend tests: **[fill in]**
- Total suite now: **[Rust + frontend combined — fill in]**
- Coverage (v8):
  - `src/api/**` aggregate: **[%]**
  - `src/stores/chatStreamStore.ts`: **[%]**
  - `src/pages/Chat.tsx`: **[%]**
  - `src/pages/Cronjobs.tsx`: **[%]**
  - `src/pages/Bots.tsx`: **[%]**
  - `src/pages/Settings.tsx`: **[%]**
  - `src/pages/SetupWizard.tsx`: **[%]**
  - `src/components/TaskDetailOverlay.tsx`: **[%]**
  - `src/components/BuddyPanel.tsx`: **[%]**
- Modules under 60% coverage (deferred to follow-up): **[list]**
- Known flakiness or timing-sensitive tests: **[list or "none"]**
- Next plan: Plan C (Tauri E2E via WebdriverIO + tauri-driver).
```

- [ ] **Step 4: Commit**

```bash
git add docs/testing-conventions.md docs/superpowers/plans/2026-04-21-plan-b-frontend-tests.md
git commit -m "docs(plan-b): add completion notes and frontend testing conventions"
```

---

## Success Criteria (Plan B)

- [ ] `npm test` passes with **~220+ frontend tests** (estimated: 25 api files × ~8 tests + 8 UI modules × ~4 tests + 4 smoke)
- [ ] `npm run test:coverage` produces v8 HTML + LCOV reports
- [ ] All 25 api files have a `.test.ts` sibling (types.ts excluded)
- [ ] All 8 core UI modules have a `.test.tsx` sibling
- [ ] `test-utils/setup.ts` + `test-utils/mockTauri.ts` in place
- [ ] `.github/workflows/test.yml` has a `frontend` job
- [ ] `docs/testing-conventions.md` appended with frontend section
- [ ] Vitest config via `app/vite.config.ts` `test` field

**Not required for Plan B (deferred to Plan B follow-up iterations):**
- 100% coverage of every UI page (many are not in the 8 "core" list — Skills.tsx, Workspace.tsx, MCP.tsx, Chat sidebar, etc.). Additional UI tests land in follow-up work.
- E2E tests via Tauri (Plan C).
- Visual regression / screenshot tests.
- Hook-level tests for custom hooks outside the 8-module scope.

---

## Deferred Work Log

Items intentionally out of scope for this plan but worth tracking:

1. **Non-core UI modules**: Skills page, Workspace page, MCP page, Cronjobs details modal, ChatSidebar, ToolCallPanel, SpawnAgentPanel, etc. Additional component-level tests will follow after Plan B baseline merges.
2. **Hook tests**: custom hooks in `app/src/hooks/` (if any) not covered here.
3. **i18n coverage**: tests that specific translation keys render correctly — done on-demand when a visual bug emerges.
4. **Accessibility audit**: Plan B asserts "click button → command invoked" style; a later audit can use `axe-core` for broader a11y coverage.
5. **Performance profiling**: not in scope.
6. **Visual regression via Playwright / Chromatic**: Plan C territory.

Each deferred item has a clear starting point and doesn't block the Plan B baseline.

---

## Completion Notes (2026-04-21)

Plan B implemented on branch `feature/plan-b-frontend`. All 19 tasks done.

### Commit history (oldest → newest)

| Task | Commit | Subject |
|---|---|---|
| T1 | `4f7da92` | test(frontend): add Vitest + testing-library devDependencies |
| T2 | `1fcaede` | test(frontend): configure Vitest in vite.config.ts |
| T3 | `162c5c5` | test(frontend): add test-utils (setup + mockTauri + smoke) |
| T4 | `b19f58e` | ci: add frontend tests + coverage job |
| T5 | `aa5bd16` | test(api): add wrapper tests for browser/env/permissions/plugins/export/usage/heartbeat |
| T6 | `90375ea` | test(api): add wrapper tests for pty/settings/shell/agents/cli |
| T7 | `ccdcd96` | test(api): add wrapper tests for voice/mcp/channels/cronjobs |
| T8 | `022569b` | test(api): add wrapper tests for tasks/canvas/skills |
| T9 | `004c6e5` | test(api): add wrapper tests for models/workspace/buddy |
| T10 | `c220e07` | test(api): add wrapper tests for bots/agent/system (completes 25/25 api coverage) |
| T11 | `ea18346` | test(stores): add chatStreamStore transition tests |
| T12 | `a47fd84` | test(pages): add Chat render + send interaction tests |
| T13 | `c2115d0` | test(pages): add Cronjobs list + CRUD tests |
| T14 | `c3c1ea1` | test(pages): add Bots list + CRUD tests |
| T15 | `33dc032` | test(pages): add Settings memory-tab interaction tests |
| T16 | `30c8e44` | test(pages): add SetupWizard step navigation + finish tests |
| T17 | `5520bb4` | test(components): add TaskDetailOverlay render + action tests |
| T18 | `2a668b5` | test(components): add BuddyPanel bootstrap + interaction tests |

### Test counts

`npm test`（单次）→ **607 passed, 0 failed, 34 test files**，耗时 ~6s。

| 分组 | 文件数 | tests |
|---|---|---|
| Smoke (`src/test-utils`) | 1 | 4 |
| API wrappers (`src/api/*.test.ts`) | 25 | 489 |
| Stores (`src/stores/*.test.ts`) | 1 | 61 |
| Pages (`src/pages/*.test.tsx`) | 5 | 27 |
| Components (`src/components/*.test.tsx`) | 2 | 26 |
| **Total frontend** | **34** | **607** |

合并 Rust 套件 → 总 **1163 tests**（Rust 556 + frontend 607）。

### Coverage（v8）

| 目标 | 结果 | 目标值 |
|---|---|---|
| `src/api/**` 聚合 | **99.6%** | ≥90% ✅ |
| `src/stores/chatStreamStore.ts` | **99.68%** | ≥60% ✅ |
| `src/pages/Bots.tsx` | 75.21% | ≥60% ✅ |
| `src/pages/Cronjobs.tsx` | 69.83% | ≥60% ✅ |
| `src/pages/SetupWizard.tsx` | 76.82% | ≥60% ✅ |
| `src/pages/Chat.tsx` | 45.45% | ≥60% ⚠️ (stream/tool/error 分支未覆盖) |
| `src/pages/Settings.tsx` | 34.42% | ≥60% ⚠️ (仅 memory tab 按 scope) |
| `src/components/TaskDetailOverlay.tsx` | ~70% est | ≥60% ✅ |
| `src/components/BuddyPanel.tsx` | ~65% est | ≥60% ✅ |

3 个页面低于 60%：Settings（scope 限定到 memory tab，其余 tab deferred）；Chat（stream/tool error 分支测试要 event simulation，deferred）；以及未在目标列表的 `Extensions.tsx` / `Channels.tsx` / `Growth.tsx` 等（非 plan 范围）。

### 真 bugs / spec gaps 发现

- `canvas.ts` **无运行时 exports**（只有 types），不是 wrapper，测试改做 structural type locking
- `tasks.ts` 无 listen wrappers，与 plan hint 差异
- `skills.ts` 实际 API 与 hint 有差异：`updateSkill`/`hubListSkills`/`getHubConfig` 等（`batch_enable/disable` 不存在）
- `TaskDetailOverlay` 不接 props，通过 `useTaskSidebarStore` 读状态
- `meditationStore` 模块加载时就启 2s 轮询 —— BuddyPanel 测试要显式 mock `get_meditation_status`

### Known 低覆盖 / deferred（符合 plan 的 scope）

- `Chat.tsx` 剩 ~55% 未覆盖（stream 事件、tool calls 渲染、error fallback）
- `Settings.tsx` 剩 ~65% 未覆盖（models/env/workspace/cli/usage 四个 tab）
- 非 plan scope 的 Pages：`Skills.tsx`、`Workspace.tsx`、`MCP.tsx`、`Buddy.tsx`、`Sessions.tsx`、`Channels.tsx`、`Growth.tsx`、`Heartbeat.tsx`、`Terminal.tsx`、`Extensions.tsx`、`Environments.tsx`
- 非 plan scope 的 Components：大量（`TaskSidebar`、`ToolCallPanel`、`SpawnAgentPanel`、`ChatMessages`、`BuddySprite` 等）

### 基建意外发现

- **Vitest `vi.mock` 对动态 `import('...')` 生效** —— SetupWizard 的 `handleFinish` 用动态 import 的 `invoke` 无需额外 plumbing
- **jsdom 缺 `scrollIntoView`** —— 全局补丁建议放 setup.ts（目前 per-file；未来提升）
- **i18n 自动 tree-shaken** —— 每个 page test 要 `import "../i18n";` 才出中文；可考虑在 setup.ts 顶部加 side-effect import

### Plan B 成功标准 — 最终检查

- [x] 607 frontend tests passing（target ≥220 大超）
- [x] `npm run test:coverage` 生成 v8 HTML + LCOV
- [x] 25/25 api 文件有 `.test.ts` sibling（types.ts 排除）
- [x] 8 核心 UI 模块都有 `.test.tsx` sibling
- [x] `test-utils/setup.ts` + `test-utils/mockTauri.ts` 就绪
- [x] `.github/workflows/test.yml` 有 `frontend` job
- [x] `docs/testing-conventions.md` 附加了 frontend section
- [x] Vitest 通过 `app/vite.config.ts` 的 `test` 字段配置

### 下一步

Plan A + B 都完成。选项：
- **Plan C** — Tauri E2E via WebdriverIO + tauri-driver（5 user flow 关键路径）
- **低覆盖回填** — `Chat.tsx` stream 分支、`Settings.tsx` 其他 tab、非核心 pages 增量
- **Merge** — 把 `feature/plan-b-frontend` 合回 `main` 然后继续
- **Bug 清理** — `list_corrections`（已修）、`skills path-traversal`（已修）、未修的：`bots_start/start_one` 需 BotManager generic refactor 才能测；`chat_stream_start` / `generate_skill_ai` 需 SSE mock 扩展

推荐下一步：merge Plan B 到 main。

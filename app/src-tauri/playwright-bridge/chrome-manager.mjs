/**
 * Persistent Chrome manager.
 *
 * Instead of Playwright's `chromium.launch()` — which dies when the bridge
 * dies and forgets everything between restarts — we spawn Chrome ourselves
 * with `--remote-debugging-port=0 --user-data-dir=<profile-dir>`, parse the
 * CDP endpoint from stderr, and save (pid, port, userDataDir) to a state
 * file. Subsequent bridge starts re-discover the already-running Chrome and
 * `connectOverCDP` to it.
 *
 * Pattern borrowed from openclaw's `extensions/browser/src/browser/chrome.ts`:
 *   • persistent user-data-dir per named profile (default: "default")
 *   • login state / cookies / localStorage survive bridge restarts
 *   • stop() defaults to just disconnect; killChrome() terminates the process
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const YIYI_DIR = process.env.YIYI_WORKING_DIR || path.join(os.homedir(), ".yiyi");
const PROFILES_DIR = path.join(YIYI_DIR, "browser-profiles");
const STATE_FILE = path.join(YIYI_DIR, "browser-state.json");

/** Ensure a directory exists (no-op if already present). */
async function ensureDir(dir) {
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/** Returns true if pid is alive on this host. */
function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    // Signal 0 = existence check, no actual signal delivered
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeState(state) {
  await ensureDir(YIYI_DIR);
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function clearState(profile) {
  const state = await readState();
  if (state[profile]) {
    delete state[profile];
    if (Object.keys(state).length === 0) {
      await unlink(STATE_FILE).catch(() => {});
    } else {
      await writeState(state);
    }
  }
}

/**
 * Parse `DevTools listening on ws://127.0.0.1:NNNN/devtools/browser/...` from
 * Chrome's stderr and resolve the port. Rejects on process exit or timeout.
 */
function waitForCdpPort(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Chrome CDP port (${timeoutMs}ms)`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        cleanup();
        resolve(parseInt(m[1], 10));
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Chrome exited before CDP port became available (code=${code}); stderr: ${buffer.slice(0, 400)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

/**
 * Start a new Chrome process or attach to an existing one for this profile.
 *
 * @param {{ headed?: boolean, profile?: string }} opts
 * @returns {Promise<{ cdpPort: number, wasReused: boolean, profile: string, userDataDir: string, pid: number | null }>}
 */
export async function startOrAttach(opts = {}) {
  const { headed = false, profile = "default" } = opts;
  await ensureDir(PROFILES_DIR);
  const userDataDir = path.join(PROFILES_DIR, profile);
  await ensureDir(userDataDir);

  const state = await readState();
  const prev = state[profile];

  // Re-attach if the recorded pid is still alive and the port still responds
  if (prev && pidAlive(prev.pid)) {
    const healthy = await probeCdp(prev.cdpPort).catch(() => false);
    if (healthy) {
      return {
        cdpPort: prev.cdpPort,
        wasReused: true,
        profile,
        userDataDir,
        pid: prev.pid,
      };
    }
    // Stale entry — continue to spawn a fresh process below
  }

  const chromeExe = chromium.executablePath();
  if (!chromeExe || !existsSync(chromeExe)) {
    throw new Error(
      `Playwright chromium not installed. Run: npx playwright install chromium`,
    );
  }

  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-features=Translate,BackForwardCache",
    "--window-size=1280,900",
  ];
  if (!headed) args.push("--headless=new");

  const child = spawn(chromeExe, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  child.on("error", (e) => {
    console.error(`[chrome-manager] spawn error: ${e.message}`);
  });

  let cdpPort;
  try {
    cdpPort = await waitForCdpPort(child);
  } catch (e) {
    try { child.kill("SIGKILL"); } catch {}
    throw e;
  }

  // Unref stdio streams so the bridge process isn't held open by Chrome.
  child.stdout?.unref();
  child.stderr?.unref();

  const next = {
    ...state,
    [profile]: {
      pid: child.pid,
      cdpPort,
      userDataDir,
      startedAt: Date.now(),
      headed,
    },
  };
  await writeState(next);

  return {
    cdpPort,
    wasReused: false,
    profile,
    userDataDir,
    pid: child.pid,
  };
}

/** HEAD the CDP json/version endpoint to check the browser is still answering. */
async function probeCdp(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return res.ok;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill Chrome for a given profile and clear its state.
 * Use when user explicitly wants a clean slate.
 */
export async function killChrome(profile = "default") {
  const state = await readState();
  const entry = state[profile];
  if (!entry) return { killed: false, reason: "no state" };
  try {
    if (pidAlive(entry.pid)) {
      process.kill(entry.pid, "SIGTERM");
      // Give it a moment to exit gracefully
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (!pidAlive(entry.pid)) break;
      }
      if (pidAlive(entry.pid)) {
        process.kill(entry.pid, "SIGKILL");
      }
    }
  } catch {
    /* ignore */
  }
  await clearState(profile);
  return { killed: true, pid: entry.pid };
}

/** Returns the persisted state for inspection. */
export async function getState() {
  return readState();
}

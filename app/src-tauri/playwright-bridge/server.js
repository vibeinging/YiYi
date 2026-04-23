/**
 * Playwright Bridge Server
 *
 * Lightweight HTTP server that wraps Playwright for YiYi's agent.
 *
 * Transport:
 *   POST /action  { action: string, ...args }  →  { text: string, images: string[] }
 *   GET  /health                               →  { ok: true }
 *
 * Architecture:
 *   Chrome is spawned by `chrome-manager.mjs` as a long-lived OS process with
 *   a persistent user-data-dir (pattern borrowed from openclaw). This bridge
 *   attaches to it via `chromium.connectOverCDP(...)`. When the bridge dies
 *   or YiYi restarts, the next bridge re-attaches to the same Chrome — cookies,
 *   logins, and localStorage survive restarts.
 *
 *   `stop` defaults to merely disconnecting the CDP client (Chrome keeps
 *   running); pass `{ kill: true }` to terminate the process + wipe state.
 */
import http from "node:http";
import { chromium } from "playwright";
import { startOrAttach, killChrome } from "./chrome-manager.mjs";

let browser = null;       // CDP-attached Browser handle (do NOT .close() — that kills Chrome)
let context = null;       // persistent default BrowserContext (browser.contexts()[0])
let page = null;          // currently active page
let activeProfile = null; // profile name used by startOrAttach

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s, max = 8000) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + `\n... (truncated, total ${s.length} chars)` : s;
}

function ok(text, images = []) {
  return { text, images };
}

function err(msg) {
  return { text: `Error: ${msg}`, images: [] };
}

// ── AI Snapshot JS (runs in browser page context) ────────────────────────────

const AI_SNAPSHOT_JS = `(() => {
  const INTERACTIVE = ['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY',
    'LABEL','[role="button"]','[role="link"]','[role="tab"]',
    '[role="menuitem"]','[role="checkbox"]','[role="radio"]',
    '[role="switch"]','[role="combobox"]','[role="searchbox"]',
    '[role="textbox"]','[role="option"]','[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])','[onclick]'];
  const SELECTOR = INTERACTIVE.join(',');
  const MAX_TEXT = 60;
  const MAX_ELEMENTS = 150;

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML'
        && getComputedStyle(el).position !== 'fixed'
        && getComputedStyle(el).position !== 'sticky') return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function truncText(t, max) {
    t = (t || '').replace(/\\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '...' : t;
  }

  function attrStr(el) {
    const parts = [];
    const tag = el.tagName.toLowerCase();
    if (el.type && tag === 'input') parts.push('type="' + el.type + '"');
    if (el.name) parts.push('name="' + el.name + '"');
    if (el.id) parts.push('id="' + el.id + '"');
    if (el.placeholder) parts.push('placeholder="' + truncText(el.placeholder, 30) + '"');
    if (el.href && tag === 'a') parts.push('href="' + truncText(el.href, 60) + '"');
    if (el.value && (tag === 'input' || tag === 'select' || tag === 'textarea'))
      parts.push('value="' + truncText(el.value, 30) + '"');
    if (el.getAttribute('role')) parts.push('role="' + el.getAttribute('role') + '"');
    if (el.getAttribute('aria-label'))
      parts.push('aria-label="' + truncText(el.getAttribute('aria-label'), 40) + '"');
    if (el.disabled) parts.push('disabled');
    if (el.readOnly) parts.push('readonly');
    if (el.checked) parts.push('checked');
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  let textParts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let textLen = 0;
  while (walker.nextNode() && textLen < 1500) {
    const t = walker.currentNode.textContent.trim();
    if (t.length > 2) { textParts.push(t); textLen += t.length; }
  }
  const textSummary = textParts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, 1500);

  const allElements = Array.from(document.querySelectorAll(SELECTOR));
  const results = [];
  let idx = 1;
  for (const el of allElements) {
    if (idx > MAX_ELEMENTS) break;
    const visible = isVisible(el);
    const tag = el.tagName.toLowerCase();
    const text = truncText(el.innerText || el.textContent || '', MAX_TEXT);
    const attrs = attrStr(el);
    el.setAttribute('data-ai-label', String(idx));
    const visFlag = visible ? '' : ' [hidden]';
    let line;
    if (text) {
      line = '[' + idx + '] <' + tag + attrs + '>' + text + '</' + tag + '>' + visFlag;
    } else {
      line = '[' + idx + '] <' + tag + attrs + ' />' + visFlag;
    }
    results.push(line);
    idx++;
  }
  return { elementCount: idx - 1, elements: results, textSummary };
})()`;

// ── Action Handlers ──────────────────────────────────────────────────────────

const handlers = {
  async start(args) {
    // Detach from any stale CDP connection, but leave the Chrome process alone.
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
      context = null;
      page = null;
    }
    const headed = args.headed === true;
    const profile = args.profile || "default";

    let info;
    try {
      info = await startOrAttach({ headed, profile });
    } catch (e) {
      return err(e.message);
    }

    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${info.cdpPort}`);
    } catch (e) {
      return err(`connectOverCDP failed on port ${info.cdpPort}: ${e.message}`);
    }

    // In persistent mode the browser has exactly one pre-existing default context
    const contexts = browser.contexts();
    context = contexts[0] ?? (await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
    }));

    // Reuse the first existing page if one is already there; otherwise wait
    // for the agent to call `open`.
    const existingPages = context.pages();
    page = existingPages[0] ?? null;

    activeProfile = profile;
    const reuseNote = info.wasReused ? " (attached to existing process)" : " (spawned new process)";
    const modeNote = headed ? "visible" : "headless";
    return ok(`Browser started in ${modeNote} mode${reuseNote}. profile=${profile}, cdp=${info.cdpPort}, pages=${existingPages.length}`);
  },

  async stop(args) {
    const killProcess = args?.kill === true;
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
      context = null;
      page = null;
    }
    if (killProcess) {
      const profile = args?.profile || activeProfile || "default";
      const res = await killChrome(profile);
      activeProfile = null;
      return ok(`Browser stopped and Chrome process killed (profile=${profile}, pid=${res.pid ?? "n/a"}).`);
    }
    return ok("Bridge disconnected. Chrome process kept alive for next start.");
  },

  async open(args) {
    if (!context) return err("Browser not started. Call browser_use with action='start' first.");
    const url = args.url;
    if (!url) return err("'url' is required for 'open' action");
    if (page) await page.close().catch(() => {});
    page = await context.newPage();
    try {
      await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
    } catch (e) {
      // Page created but navigation failed — keep the page so user can retry with goto
      return err(`Navigation failed (page created): ${e.message}`);
    }
    const title = await page.title().catch(() => "");
    return ok(`Opened new tab: ${url} (title: ${title})`);
  },

  async goto(args) {
    if (!page) return err("No page open. Call browser_use with action='open' first.");
    const url = args.url;
    if (!url) return err("'url' is required for 'goto' action");
    try {
      await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
    } catch (e) {
      return err(`Navigation failed: ${e.message}`);
    }
    const title = await page.title().catch(() => "");
    return ok(`Navigated to: ${url} (title: ${title})`);
  },

  async get_url() {
    if (!page) return err("No page open.");
    return ok(`Current URL: ${page.url()}`);
  },

  async snapshot() {
    if (!page) return err("No page open.");
    const title = await page.title().catch(() => "");
    const url = page.url();
    try {
      const text = await page.evaluate(() => document.body.innerText);
      return ok(`Title: ${title}\nURL: ${url}\n\nContent:\n${truncate(text, 8000)}`);
    } catch (e) {
      return err(`Failed to get page content: ${e.message}`);
    }
  },

  async ai_snapshot() {
    if (!page) return err("No page open.");
    const title = await page.title().catch(() => "");
    const url = page.url();

    // Prefer Playwright's private _snapshotForAI — produces a compact,
    // LLM-optimized DOM tree. Falls back to the hand-rolled evaluator if
    // the private API is unavailable in the installed playwright version.
    if (typeof page._snapshotForAI === "function") {
      try {
        const snap = await page._snapshotForAI();
        const body = typeof snap === "string" ? snap : JSON.stringify(snap, null, 2);
        return ok(truncate(`Title: ${title}\nURL: ${url}\n\n${body}`, 8000));
      } catch {
        // fall through to legacy evaluator
      }
    }

    try {
      const data = await page.evaluate(AI_SNAPSHOT_JS);
      const elements = data.elements.join("\n");
      const output = `Title: ${title}\nURL: ${url}\n\n--- Page Text Summary ---\n${truncate(data.textSummary, 1500)}\n\n--- Interactive Elements (${data.elementCount}) ---\n${elements}`;
      return ok(truncate(output, 8000));
    } catch (e) {
      return err(`ai_snapshot failed: ${e.message}`);
    }
  },

  async act(args) {
    if (!page) return err("No page open.");
    const num = args.element;
    const operation = args.operation || "click";
    if (!num) return err("'element' (number from ai_snapshot) is required for 'act' action");

    const selector = `[data-ai-label="${num}"]`;

    if (operation === "click") {
      try {
        const el = page.locator(selector);
        await el.scrollIntoViewIfNeeded({ timeout: 5000 });
        await el.click({ timeout: 5000 });
        return ok(`Clicked element [${num}]`);
      } catch (e) {
        if (e.message.includes("Could not find")) {
          return ok(`Element [${num}] not found. Run ai_snapshot again to refresh labels.`);
        }
        return err(`act click failed: ${e.message}`);
      }
    }

    if (operation === "type") {
      const text = args.text;
      if (!text) return err("'text' is required for act type operation");
      const clear = args.clear === true;
      try {
        const el = page.locator(selector);
        await el.scrollIntoViewIfNeeded({ timeout: 5000 });
        if (clear) await el.fill("");
        await el.fill(clear ? text : (await el.inputValue().catch(() => "")) + text);
        return ok(`Typed '${text}' into element [${num}]`);
      } catch (e) {
        // Fallback for contenteditable
        try {
          if (clear) {
            await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.textContent = ''; }, selector);
          }
          await page.evaluate(
            ([s, t]) => {
              const el = document.querySelector(s);
              if (el) {
                el.focus();
                el.textContent = (el.textContent || '') + t;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            },
            [selector, text]
          );
          return ok(`Typed '${text}' into element [${num}] (contenteditable)`);
        } catch (e2) {
          return err(`act type failed: ${e2.message}`);
        }
      }
    }

    if (operation === "select") {
      const value = args.value;
      if (!value) return err("'value' is required for act select operation");
      try {
        await page.locator(selector).selectOption(value, { timeout: 5000 });
        return ok(`Selected value '${value}' in element [${num}]`);
      } catch (e) {
        return err(`act select failed: ${e.message}`);
      }
    }

    return err(`Unknown act operation: '${operation}'. Supported: click, type, select`);
  },

  async screenshot() {
    if (!page) return err("No page open.");
    try {
      const buf = await page.screenshot({ fullPage: true, type: "png" });
      const b64 = buf.toString("base64");
      const dataUri = `data:image/png;base64,${b64}`;
      return ok(`Screenshot captured (${buf.length} bytes). Analyze the image to understand the page visually.`, [dataUri]);
    } catch (e) {
      return err(`Screenshot failed: ${e.message}`);
    }
  },

  async click(args) {
    if (!page) return err("No page open.");
    const selector = args.selector;
    if (!selector) return err("'selector' is required");
    try {
      await page.locator(selector).first().click({ timeout: 5000 });
      return ok(`Clicked: ${selector}`);
    } catch (e) {
      return err(`Click failed: ${e.message}`);
    }
  },

  async type(args) {
    if (!page) return err("No page open.");
    const selector = args.selector;
    const text = args.text;
    const clear = args.clear === true;
    if (!selector || !text) return err("'selector' and 'text' are required");
    try {
      const el = page.locator(selector).first();
      if (clear) await el.fill("");
      await el.fill(clear ? text : (await el.inputValue().catch(() => "")) + text);
      return ok(`Typed into ${selector}: '${text}'`);
    } catch (e) {
      return err(`Type failed: ${e.message}`);
    }
  },

  async press_key(args) {
    if (!page) return err("No page open.");
    const key = args.key;
    if (!key) return err("'key' is required");
    const selector = args.selector;
    try {
      if (selector) {
        await page.locator(selector).first().press(key, { timeout: 5000 });
        return ok(`Pressed key ${key} on: ${selector}`);
      } else {
        await page.keyboard.press(key);
        return ok(`Pressed key: ${key}`);
      }
    } catch (e) {
      return err(`press_key failed: ${e.message}`);
    }
  },

  async scroll(args) {
    if (!page) return err("No page open.");
    const selector = args.selector;
    const direction = args.direction || "down";
    const amount = args.amount || 500;
    try {
      if (selector) {
        await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 });
        return ok(`Scrolled element into view: ${selector}`);
      }
      const [x, y] = {
        up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0],
      }[direction] || [0, amount];
      await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);
      return ok(`Scrolled ${direction} by ${amount}px`);
    } catch (e) {
      return err(`Scroll failed: ${e.message}`);
    }
  },

  async wait(args) {
    if (!page) return err("No page open.");
    const selector = args.selector;
    const timeout = Math.min(args.timeout || 5000, 30000);
    if (!selector) {
      await new Promise((r) => setTimeout(r, timeout));
      return ok(`Waited ${timeout}ms`);
    }
    try {
      await page.waitForSelector(selector, { timeout });
      return ok(`Element found: ${selector}`);
    } catch {
      return ok(`Timeout (${timeout}ms) waiting for element: ${selector}`);
    }
  },

  async evaluate(args) {
    if (!page) return err("No page open.");
    const expression = args.expression;
    if (!expression) return err("'expression' is required");
    try {
      // Playwright evaluate with string needs expression syntax, not arrow function.
      // Wrap arrow functions/function expressions as IIFE to ensure they execute.
      let evalExpr = expression.trim();
      if (/^(\(?\s*\(.*?\)\s*=>|function\s*\()/.test(evalExpr) && !evalExpr.endsWith("()")) {
        evalExpr = `(${evalExpr})()`;
      }
      const result = await page.evaluate(evalExpr);
      const output = JSON.stringify(result, null, 2);
      return ok(`Result:\n${truncate(output, 8000)}`);
    } catch (e) {
      return err(`JS evaluation failed: ${e.message}`);
    }
  },

  async find_elements(args) {
    if (!page) return err("No page open.");
    const selector = args.selector;
    if (!selector) return err("'selector' is required");
    const limit = args.limit || 20;
    const attrs = args.attributes || [];
    try {
      const elements = await page.locator(selector).all();
      const total = elements.length;
      const lines = [`Found ${total} elements matching "${selector}" (showing first ${Math.min(limit, total)}):`];
      for (let i = 0; i < Math.min(limit, total); i++) {
        const el = elements[i];
        const text = (await el.innerText().catch(() => "")).replace(/\n/g, " ");
        const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
        let attrParts = [];
        for (const a of attrs) {
          const v = await el.getAttribute(a).catch(() => null);
          if (v) attrParts.push(`${a}="${v}"`);
        }
        const attrStr = attrParts.length ? " " + attrParts.join(" ") : "";
        lines.push(`[${i + 1}] text="${preview}"${attrStr}`);
      }
      return ok(truncate(lines.join("\n"), 8000));
    } catch (e) {
      return err(`find_elements failed: ${e.message}`);
    }
  },

  async select(args) {
    if (!page) return err("No page open.");
    const { selector, value } = args;
    if (!selector || !value) return err("'selector' and 'value' are required");
    try {
      await page.locator(selector).first().selectOption(value, { timeout: 5000 });
      return ok(`Selected value '${value}' in ${selector}`);
    } catch (e) {
      return err(`Select failed: ${e.message}`);
    }
  },

  async upload(args) {
    if (!page) return err("No page open.");
    const { selector, file_path } = args;
    if (!selector || !file_path) return err("'selector' and 'file_path' are required");
    try {
      await page.locator(selector).first().setInputFiles(file_path);
      return ok(`File uploaded: ${file_path} to ${selector}`);
    } catch (e) {
      return err(`Upload failed: ${e.message}`);
    }
  },

  async cookies(args) {
    if (!context) return err("Browser not started.");
    const operation = args.operation || "get";
    if (operation === "get") {
      const cookies = await context.cookies();
      return ok(`Cookies (${cookies.length}):\n${truncate(JSON.stringify(cookies, null, 2), 8000)}`);
    }
    if (operation === "set") {
      const { name, value, domain } = args;
      if (!name || !value) return err("'name' and 'value' are required for cookies set");
      const url = page ? page.url() : undefined;
      await context.addCookies([{ name, value, domain: domain || undefined, path: "/", url: !domain ? url : undefined }]);
      return ok(`Cookie set: ${name}=${value}`);
    }
    if (operation === "delete") {
      const { name } = args;
      if (!name) return err("'name' is required for cookies delete");
      // Playwright supports clearCookies with name filter
      await context.clearCookies({ name });
      return ok(`Cookie deleted: ${name}`);
    }
    return err(`Unknown cookie operation: '${operation}'. Supported: get, set, delete`);
  },

  async list_frames() {
    if (!page) return err("No page open.");
    const frames = page.frames();
    if (!frames.length) return ok("No frames found on this page.");
    const lines = [`Found ${frames.length} frame(s):`];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const isMain = f === page.mainFrame() ? " [main]" : "";
      const name = f.name() ? ` name="${f.name()}"` : "";
      lines.push(`[${i}]${isMain}${name} url=${f.url()}`);
    }
    return ok(lines.join("\n"));
  },

  async switch_frame() {
    return ok("Playwright manages frames automatically. Use evaluate_in_frame with frame_index or frame_url to execute JS in a specific frame.");
  },

  async evaluate_in_frame(args) {
    if (!page) return err("No page open.");
    const { expression, frame_index, frame_url } = args;
    if (!expression) return err("'expression' is required");
    if (frame_index == null && !frame_url) return err("'frame_index' or 'frame_url' is required");

    const frames = page.frames();
    let target;
    if (frame_index != null) {
      target = frames[frame_index];
    } else {
      target = frames.find((f) => f.url().includes(frame_url));
    }
    if (!target) return err("Target frame not found");
    try {
      let evalExpr = expression.trim();
      if (/^(\(?\s*\(.*?\)\s*=>|function\s*\()/.test(evalExpr) && !evalExpr.endsWith("()")) {
        evalExpr = `(${evalExpr})()`;
      }
      const result = await target.evaluate(evalExpr);
      return ok(`Frame JS result:\n${truncate(JSON.stringify(result, null, 2), 8000)}`);
    } catch (e) {
      return err(`Frame JS evaluation failed: ${e.message}`);
    }
  },
};

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/action") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let args;
    try {
      args = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(err("Invalid JSON")));
      return;
    }

    const action = args.action;
    const handler = handlers[action];
    if (!handler) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          err(
            `Unknown action: '${action}'. Supported: ${Object.keys(handlers).join(", ")}`
          )
        )
      );
      return;
    }

    try {
      const result = await handler(args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(err(`Unhandled error in '${action}': ${e.message}`)));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Listen on random port, print READY:{port} for the Rust parent to read
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(`READY:${port}\n`);
});

// Graceful shutdown — disconnect CDP but KEEP Chrome alive so the next bridge
// can re-attach. Use the `stop` action with `{ kill: true }` to fully quit.
async function gracefulShutdown() {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  server.close();
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

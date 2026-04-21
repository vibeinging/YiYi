import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  launchBrowser,
  navigate,
  screenshot,
  closeBrowser,
} from "./browser";
import type { BrowserInfo } from "./types";

const invokeMock = invoke as unknown as Mock;

describe("browser api", () => {
  const sampleInfo: BrowserInfo = {
    browser_id: "b-1",
    status: "ready",
    headless: false,
  };

  describe("launchBrowser", () => {
    it("invokes launch_browser with { headless } and returns BrowserInfo", async () => {
      mockInvoke({ launch_browser: () => sampleInfo });
      const result = await launchBrowser(true);
      expect(result).toEqual(sampleInfo);
      expect(invokeMock).toHaveBeenCalledWith("launch_browser", {
        headless: true,
      });
    });

    it("defaults headless to false when called without argument", async () => {
      mockInvoke({ launch_browser: () => sampleInfo });
      await launchBrowser();
      expect(invokeMock).toHaveBeenCalledWith("launch_browser", {
        headless: false,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        launch_browser: () => {
          throw new Error("chromium missing");
        },
      });
      await expect(launchBrowser()).rejects.toThrow("chromium missing");
    });
  });

  describe("navigate", () => {
    it("invokes browser_navigate with { browserId, url }", async () => {
      mockInvoke({ browser_navigate: () => undefined });
      await navigate("b-1", "https://example.com");
      expect(invokeMock).toHaveBeenCalledWith("browser_navigate", {
        browserId: "b-1",
        url: "https://example.com",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        browser_navigate: () => {
          throw new Error("timeout");
        },
      });
      await expect(navigate("b-1", "https://example.com")).rejects.toThrow("timeout");
    });
  });

  describe("screenshot", () => {
    it("invokes browser_screenshot with { browserId, fullPage } and returns a base64 string", async () => {
      mockInvoke({ browser_screenshot: () => "data:image/png;base64,AAA" });
      const result = await screenshot("b-1", true);
      expect(result).toBe("data:image/png;base64,AAA");
      expect(invokeMock).toHaveBeenCalledWith("browser_screenshot", {
        browserId: "b-1",
        fullPage: true,
      });
    });

    it("defaults fullPage to false when omitted", async () => {
      mockInvoke({ browser_screenshot: () => "data" });
      await screenshot("b-1");
      expect(invokeMock).toHaveBeenCalledWith("browser_screenshot", {
        browserId: "b-1",
        fullPage: false,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        browser_screenshot: () => {
          throw new Error("no browser");
        },
      });
      await expect(screenshot("b-1")).rejects.toThrow("no browser");
    });
  });

  describe("closeBrowser", () => {
    it("invokes close_browser with { browserId }", async () => {
      mockInvoke({ close_browser: () => undefined });
      await closeBrowser("b-1");
      expect(invokeMock).toHaveBeenCalledWith("close_browser", {
        browserId: "b-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        close_browser: () => {
          throw new Error("already closed");
        },
      });
      await expect(closeBrowser("b-1")).rejects.toThrow("already closed");
    });
  });
});

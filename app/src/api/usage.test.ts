import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  getUsageSummary,
  getUsageBySession,
  getUsageDaily,
  type UsageSummary,
  type SessionUsage,
  type DailyUsage,
} from "./usage";

const invokeMock = invoke as unknown as Mock;

describe("usage api", () => {
  const sampleSummary: UsageSummary = {
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cache_read_tokens: 10,
    total_cache_write_tokens: 5,
    total_cost_usd: 0.12,
    call_count: 3,
  };

  describe("getUsageSummary", () => {
    it("invokes get_usage_summary with { since, until } and returns UsageSummary", async () => {
      mockInvoke({ get_usage_summary: () => sampleSummary });
      const result = await getUsageSummary(1000, 2000);
      expect(result).toEqual(sampleSummary);
      expect(invokeMock).toHaveBeenCalledWith("get_usage_summary", {
        since: 1000,
        until: 2000,
      });
    });

    it("passes { since: undefined, until: undefined } when called without arguments", async () => {
      mockInvoke({ get_usage_summary: () => sampleSummary });
      await getUsageSummary();
      expect(invokeMock).toHaveBeenCalledWith("get_usage_summary", {
        since: undefined,
        until: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_usage_summary: () => {
          throw new Error("db locked");
        },
      });
      await expect(getUsageSummary()).rejects.toThrow("db locked");
    });
  });

  describe("getUsageBySession", () => {
    it("invokes get_usage_by_session with { limit } and returns SessionUsage rows", async () => {
      const rows: SessionUsage[] = [
        { session_id: "s1", summary: sampleSummary },
      ];
      mockInvoke({ get_usage_by_session: () => rows });
      const result = await getUsageBySession(25);
      expect(result).toEqual(rows);
      expect(invokeMock).toHaveBeenCalledWith("get_usage_by_session", {
        limit: 25,
      });
    });

    it("passes { limit: undefined } when called without argument", async () => {
      mockInvoke({ get_usage_by_session: () => [] });
      await getUsageBySession();
      expect(invokeMock).toHaveBeenCalledWith("get_usage_by_session", {
        limit: undefined,
      });
    });
  });

  describe("getUsageDaily", () => {
    it("invokes get_usage_daily with { days } and returns DailyUsage rows", async () => {
      const rows: DailyUsage[] = [
        { date: "2026-04-20", summary: sampleSummary },
      ];
      mockInvoke({ get_usage_daily: () => rows });
      const result = await getUsageDaily(7);
      expect(result).toEqual(rows);
      expect(invokeMock).toHaveBeenCalledWith("get_usage_daily", {
        days: 7,
      });
    });

    it("passes { days: undefined } when called without argument", async () => {
      mockInvoke({ get_usage_daily: () => [] });
      await getUsageDaily();
      expect(invokeMock).toHaveBeenCalledWith("get_usage_daily", {
        days: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_usage_daily: () => {
          throw new Error("range invalid");
        },
      });
      await expect(getUsageDaily(7)).rejects.toThrow("range invalid");
    });
  });
});

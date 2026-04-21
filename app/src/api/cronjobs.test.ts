import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listCronJobs,
  createCronJob,
  updateCronJob,
  deleteCronJob,
  pauseCronJob,
  resumeCronJob,
  runCronJob,
  getCronJobState,
  listCronJobExecutions,
  type CronJobSpec,
  type CronJobExecution,
} from "./cronjobs";

const invokeMock = invoke as unknown as Mock;

describe("cronjobs api", () => {
  const sampleSpec: CronJobSpec = {
    id: "job-1",
    name: "daily digest",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    task_type: "notify",
    text: "Good morning",
  };

  const sampleExecution: CronJobExecution = {
    id: 42,
    job_id: "job-1",
    started_at: 1_700_000_000,
    finished_at: 1_700_000_005,
    status: "success",
    result: "ok",
    trigger_type: "scheduled",
  };

  describe("listCronJobs", () => {
    it("invokes list_cronjobs and returns the spec list", async () => {
      mockInvoke({ list_cronjobs: () => [sampleSpec] });
      const result = await listCronJobs();
      expect(result).toEqual([sampleSpec]);
      expect(invokeMock).toHaveBeenCalledWith("list_cronjobs");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_cronjobs: () => {
          throw new Error("db offline");
        },
      });
      await expect(listCronJobs()).rejects.toThrow("db offline");
    });
  });

  describe("createCronJob", () => {
    it("invokes create_cronjob with { spec } and echoes the spec", async () => {
      mockInvoke({ create_cronjob: (args) => args?.spec });
      const result = await createCronJob(sampleSpec);
      expect(result).toEqual(sampleSpec);
      expect(invokeMock).toHaveBeenCalledWith("create_cronjob", {
        spec: sampleSpec,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_cronjob: () => {
          throw new Error("invalid cron");
        },
      });
      await expect(createCronJob(sampleSpec)).rejects.toThrow("invalid cron");
    });
  });

  describe("updateCronJob", () => {
    it("invokes update_cronjob with { id, spec }", async () => {
      mockInvoke({ update_cronjob: (args) => args?.spec });
      const result = await updateCronJob("job-1", sampleSpec);
      expect(result).toEqual(sampleSpec);
      expect(invokeMock).toHaveBeenCalledWith("update_cronjob", {
        id: "job-1",
        spec: sampleSpec,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        update_cronjob: () => {
          throw new Error("not found");
        },
      });
      await expect(updateCronJob("job-1", sampleSpec)).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("deleteCronJob", () => {
    it("invokes delete_cronjob with { id }", async () => {
      mockInvoke({ delete_cronjob: () => undefined });
      await deleteCronJob("job-1");
      expect(invokeMock).toHaveBeenCalledWith("delete_cronjob", {
        id: "job-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_cronjob: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteCronJob("missing")).rejects.toThrow("not found");
    });
  });

  describe("pauseCronJob", () => {
    it("invokes pause_cronjob with { id }", async () => {
      mockInvoke({ pause_cronjob: () => undefined });
      await pauseCronJob("job-1");
      expect(invokeMock).toHaveBeenCalledWith("pause_cronjob", {
        id: "job-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        pause_cronjob: () => {
          throw new Error("not found");
        },
      });
      await expect(pauseCronJob("missing")).rejects.toThrow("not found");
    });
  });

  describe("resumeCronJob", () => {
    it("invokes resume_cronjob with { id }", async () => {
      mockInvoke({ resume_cronjob: () => undefined });
      await resumeCronJob("job-1");
      expect(invokeMock).toHaveBeenCalledWith("resume_cronjob", {
        id: "job-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        resume_cronjob: () => {
          throw new Error("not found");
        },
      });
      await expect(resumeCronJob("missing")).rejects.toThrow("not found");
    });
  });

  describe("runCronJob", () => {
    it("invokes run_cronjob with { id }", async () => {
      mockInvoke({ run_cronjob: () => undefined });
      await runCronJob("job-1");
      expect(invokeMock).toHaveBeenCalledWith("run_cronjob", {
        id: "job-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        run_cronjob: () => {
          throw new Error("run failed");
        },
      });
      await expect(runCronJob("job-1")).rejects.toThrow("run failed");
    });
  });

  describe("getCronJobState", () => {
    it("invokes get_cronjob_state with { id } and returns the state", async () => {
      const state = { running: true, next_run: 1_700_000_100 };
      mockInvoke({ get_cronjob_state: () => state });
      const result = await getCronJobState("job-1");
      expect(result).toEqual(state);
      expect(invokeMock).toHaveBeenCalledWith("get_cronjob_state", {
        id: "job-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_cronjob_state: () => {
          throw new Error("not found");
        },
      });
      await expect(getCronJobState("missing")).rejects.toThrow("not found");
    });
  });

  describe("listCronJobExecutions", () => {
    it("invokes list_cronjob_executions with { jobId, limit } and returns rows", async () => {
      mockInvoke({ list_cronjob_executions: () => [sampleExecution] });
      const result = await listCronJobExecutions("job-1", 50);
      expect(result).toEqual([sampleExecution]);
      expect(invokeMock).toHaveBeenCalledWith("list_cronjob_executions", {
        jobId: "job-1",
        limit: 50,
      });
    });

    it("defaults limit to 20 when omitted", async () => {
      mockInvoke({ list_cronjob_executions: () => [] });
      await listCronJobExecutions("job-1");
      expect(invokeMock).toHaveBeenCalledWith("list_cronjob_executions", {
        jobId: "job-1",
        limit: 20,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_cronjob_executions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listCronJobExecutions("job-1")).rejects.toThrow(
        "db offline",
      );
    });
  });
});

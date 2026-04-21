import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  checkPermissions,
  requestAccessibility,
  requestScreenRecording,
  requestMicrophone,
  type PermissionStatus,
} from "./permissions";

const invokeMock = invoke as unknown as Mock;

describe("permissions api", () => {
  const sampleStatus: PermissionStatus = {
    accessibility: true,
    screen_recording: false,
    microphone: true,
  };

  describe("checkPermissions", () => {
    it("invokes check_permissions and returns PermissionStatus", async () => {
      mockInvoke({ check_permissions: () => sampleStatus });
      const result = await checkPermissions();
      expect(result).toEqual(sampleStatus);
      expect(invokeMock).toHaveBeenCalledWith("check_permissions");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        check_permissions: () => {
          throw new Error("unsupported platform");
        },
      });
      await expect(checkPermissions()).rejects.toThrow("unsupported platform");
    });
  });

  describe("requestAccessibility", () => {
    it("invokes request_accessibility and returns the boolean", async () => {
      mockInvoke({ request_accessibility: () => true });
      const result = await requestAccessibility();
      expect(result).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("request_accessibility");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        request_accessibility: () => {
          throw new Error("denied");
        },
      });
      await expect(requestAccessibility()).rejects.toThrow("denied");
    });
  });

  describe("requestScreenRecording", () => {
    it("invokes request_screen_recording", async () => {
      mockInvoke({ request_screen_recording: () => undefined });
      await requestScreenRecording();
      expect(invokeMock).toHaveBeenCalledWith("request_screen_recording");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        request_screen_recording: () => {
          throw new Error("denied");
        },
      });
      await expect(requestScreenRecording()).rejects.toThrow("denied");
    });
  });

  describe("requestMicrophone", () => {
    it("invokes request_microphone", async () => {
      mockInvoke({ request_microphone: () => undefined });
      await requestMicrophone();
      expect(invokeMock).toHaveBeenCalledWith("request_microphone");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        request_microphone: () => {
          throw new Error("denied");
        },
      });
      await expect(requestMicrophone()).rejects.toThrow("denied");
    });
  });
});

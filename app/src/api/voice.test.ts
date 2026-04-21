import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  startVoiceSession,
  stopVoiceSession,
  getVoiceStatus,
  onVoiceStatus,
  onVoiceTranscript,
  onVoiceToolCall,
} from "./voice";

const invokeMock = invoke as unknown as Mock;
const listenMock = listen as unknown as Mock;

describe("voice api", () => {
  describe("startVoiceSession", () => {
    it("invokes start_voice_session and returns the session id", async () => {
      mockInvoke({ start_voice_session: () => "session-abc" });
      const result = await startVoiceSession();
      expect(result).toBe("session-abc");
      expect(invokeMock).toHaveBeenCalledWith("start_voice_session");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        start_voice_session: () => {
          throw new Error("mic unavailable");
        },
      });
      await expect(startVoiceSession()).rejects.toThrow("mic unavailable");
    });
  });

  describe("stopVoiceSession", () => {
    it("invokes stop_voice_session", async () => {
      mockInvoke({ stop_voice_session: () => undefined });
      await stopVoiceSession();
      expect(invokeMock).toHaveBeenCalledWith("stop_voice_session");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        stop_voice_session: () => {
          throw new Error("no active session");
        },
      });
      await expect(stopVoiceSession()).rejects.toThrow("no active session");
    });
  });

  describe("getVoiceStatus", () => {
    it("invokes get_voice_status and returns the status string", async () => {
      mockInvoke({ get_voice_status: () => "listening" });
      const result = await getVoiceStatus();
      expect(result).toBe("listening");
      expect(invokeMock).toHaveBeenCalledWith("get_voice_status");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_voice_status: () => {
          throw new Error("status unknown");
        },
      });
      await expect(getVoiceStatus()).rejects.toThrow("status unknown");
    });
  });

  describe("onVoiceStatus", () => {
    it("subscribes to the voice://status event channel", async () => {
      const cb = () => {};
      await onVoiceStatus(cb);
      expect(listenMock).toHaveBeenCalledWith(
        "voice://status",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onVoiceStatus(() => {});
      expect(typeof unlisten).toBe("function");
    });
  });

  describe("onVoiceTranscript", () => {
    it("subscribes to the voice://transcript event channel", async () => {
      await onVoiceTranscript(() => {});
      expect(listenMock).toHaveBeenCalledWith(
        "voice://transcript",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onVoiceTranscript(() => {});
      expect(typeof unlisten).toBe("function");
    });
  });

  describe("onVoiceToolCall", () => {
    it("subscribes to the voice://tool_call event channel", async () => {
      await onVoiceToolCall(() => {});
      expect(listenMock).toHaveBeenCalledWith(
        "voice://tool_call",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onVoiceToolCall(() => {});
      expect(typeof unlisten).toBe("function");
    });
  });
});

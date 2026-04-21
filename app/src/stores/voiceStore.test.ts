import { describe, it, expect, beforeEach } from "vitest";
import { useVoiceStore } from "./voiceStore";

// Snapshot the initial state so every test starts from the same place.
const PRISTINE = useVoiceStore.getState();

function resetStore() {
  useVoiceStore.setState({
    ...PRISTINE,
    activeTools: [],
  });
}

describe("voiceStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("starts idle with empty buffers and no error", () => {
      const s = useVoiceStore.getState();
      expect(s.status).toBe("idle");
      expect(s.sessionId).toBeNull();
      expect(s.userTranscript).toBe("");
      expect(s.assistantTranscript).toBe("");
      expect(s.activeTools).toEqual([]);
      expect(s.error).toBeNull();
    });
  });

  describe("setStatus", () => {
    it("transitions through the voice state machine", () => {
      const { setStatus } = useVoiceStore.getState();
      setStatus("connecting");
      expect(useVoiceStore.getState().status).toBe("connecting");
      setStatus("listening");
      expect(useVoiceStore.getState().status).toBe("listening");
      setStatus("thinking");
      expect(useVoiceStore.getState().status).toBe("thinking");
      setStatus("speaking");
      expect(useVoiceStore.getState().status).toBe("speaking");
      setStatus("error");
      expect(useVoiceStore.getState().status).toBe("error");
      setStatus("idle");
      expect(useVoiceStore.getState().status).toBe("idle");
    });
  });

  describe("setSessionId", () => {
    it("sets and clears the session id", () => {
      const { setSessionId } = useVoiceStore.getState();
      setSessionId("sess-42");
      expect(useVoiceStore.getState().sessionId).toBe("sess-42");
      setSessionId(null);
      expect(useVoiceStore.getState().sessionId).toBeNull();
    });

    it("overwrites any prior value", () => {
      const { setSessionId } = useVoiceStore.getState();
      setSessionId("a");
      setSessionId("b");
      expect(useVoiceStore.getState().sessionId).toBe("b");
    });
  });

  describe("appendUserTranscript / setUserTranscript", () => {
    it("appendUserTranscript concatenates text", () => {
      const { appendUserTranscript } = useVoiceStore.getState();
      appendUserTranscript("hello");
      appendUserTranscript(" ");
      appendUserTranscript("world");
      expect(useVoiceStore.getState().userTranscript).toBe("hello world");
    });

    it("setUserTranscript overwrites the buffer", () => {
      const { appendUserTranscript, setUserTranscript } =
        useVoiceStore.getState();
      appendUserTranscript("initial");
      setUserTranscript("replaced");
      expect(useVoiceStore.getState().userTranscript).toBe("replaced");
    });

    it("setUserTranscript can clear to empty string", () => {
      const { appendUserTranscript, setUserTranscript } =
        useVoiceStore.getState();
      appendUserTranscript("abc");
      setUserTranscript("");
      expect(useVoiceStore.getState().userTranscript).toBe("");
    });
  });

  describe("appendAssistantTranscript / setAssistantTranscript", () => {
    it("appendAssistantTranscript concatenates text", () => {
      const { appendAssistantTranscript } = useVoiceStore.getState();
      appendAssistantTranscript("foo ");
      appendAssistantTranscript("bar");
      expect(useVoiceStore.getState().assistantTranscript).toBe("foo bar");
    });

    it("setAssistantTranscript overwrites the buffer", () => {
      const { appendAssistantTranscript, setAssistantTranscript } =
        useVoiceStore.getState();
      appendAssistantTranscript("initial");
      setAssistantTranscript("replaced");
      expect(useVoiceStore.getState().assistantTranscript).toBe("replaced");
    });

    it("does not affect userTranscript", () => {
      const { appendUserTranscript, appendAssistantTranscript } =
        useVoiceStore.getState();
      appendUserTranscript("user");
      appendAssistantTranscript("bot");
      const s = useVoiceStore.getState();
      expect(s.userTranscript).toBe("user");
      expect(s.assistantTranscript).toBe("bot");
    });
  });

  describe("addTool", () => {
    it("appends a new 'start' tool with preview", () => {
      const { addTool } = useVoiceStore.getState();
      addTool("Read", "start", "a.txt");
      const tools = useVoiceStore.getState().activeTools;
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({ name: "Read", status: "start", preview: "a.txt" });
    });

    it("appends multiple 'start' tools in order", () => {
      const { addTool } = useVoiceStore.getState();
      addTool("Read", "start", "a");
      addTool("Edit", "start", "b");
      const tools = useVoiceStore.getState().activeTools;
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["Read", "Edit"]);
    });

    it("'end' flips the matching in-progress tool to status 'end' and updates preview", () => {
      const { addTool } = useVoiceStore.getState();
      addTool("Read", "start", "orig");
      addTool("Read", "end", "final");
      const tools = useVoiceStore.getState().activeTools;
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({ name: "Read", status: "end", preview: "final" });
    });

    it("'end' on a tool that was never started is a no-op (no new entry added)", () => {
      const { addTool } = useVoiceStore.getState();
      addTool("Ghost", "end", "x");
      // Since no start was registered, the filter produces no 'end' entries
      // and no 'start' entries either — the resulting array stays empty.
      expect(useVoiceStore.getState().activeTools).toEqual([]);
    });

    it("keeps only last 10 completed tools + all in-progress", () => {
      const { addTool } = useVoiceStore.getState();
      // 12 start/end pairs to overflow the 10-cap on completed
      for (let i = 0; i < 12; i++) {
        addTool(`Tool${i}`, "start", `p${i}`);
        addTool(`Tool${i}`, "end", `r${i}`);
      }
      // Add two still-running tools
      addTool("Running1", "start", "pa");
      addTool("Running2", "start", "pb");
      const tools = useVoiceStore.getState().activeTools;
      const done = tools.filter((t) => t.status === "end");
      const inProgress = tools.filter((t) => t.status === "start");
      expect(done).toHaveLength(10);
      // Only the most recent 10 completions remain (Tool2..Tool11)
      expect(done.map((t) => t.name)).toEqual([
        "Tool2", "Tool3", "Tool4", "Tool5", "Tool6",
        "Tool7", "Tool8", "Tool9", "Tool10", "Tool11",
      ]);
      expect(inProgress.map((t) => t.name)).toEqual(["Running1", "Running2"]);
    });

    it("'end' preserves in-progress tools ordering (done first, then in-progress)", () => {
      const { addTool } = useVoiceStore.getState();
      addTool("A", "start", "a");
      addTool("B", "start", "b");
      addTool("A", "end", "a-res");
      // After end: A is done, B still running. Shape is [done..., inProgress...]
      const tools = useVoiceStore.getState().activeTools;
      expect(tools[0]).toMatchObject({ name: "A", status: "end", preview: "a-res" });
      expect(tools[1]).toMatchObject({ name: "B", status: "start" });
    });
  });

  describe("setError", () => {
    it("sets an error message", () => {
      useVoiceStore.getState().setError("microphone denied");
      expect(useVoiceStore.getState().error).toBe("microphone denied");
    });

    it("accepts null to clear", () => {
      const { setError } = useVoiceStore.getState();
      setError("boom");
      setError(null);
      expect(useVoiceStore.getState().error).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears every runtime field back to idle defaults", () => {
      const s = useVoiceStore.getState();
      s.setStatus("listening");
      s.setSessionId("sess-1");
      s.appendUserTranscript("user says");
      s.appendAssistantTranscript("bot replies");
      s.addTool("Read", "start", "x");
      s.setError("some error");
      s.reset();
      const next = useVoiceStore.getState();
      expect(next.status).toBe("idle");
      expect(next.sessionId).toBeNull();
      expect(next.userTranscript).toBe("");
      expect(next.assistantTranscript).toBe("");
      expect(next.activeTools).toEqual([]);
      expect(next.error).toBeNull();
    });

    it("is idempotent on an already-fresh store", () => {
      const { reset } = useVoiceStore.getState();
      reset();
      reset();
      const s = useVoiceStore.getState();
      expect(s.status).toBe("idle");
      expect(s.sessionId).toBeNull();
      expect(s.userTranscript).toBe("");
      expect(s.assistantTranscript).toBe("");
      expect(s.activeTools).toEqual([]);
      expect(s.error).toBeNull();
    });
  });
});

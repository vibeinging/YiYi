import { create } from 'zustand';
import type { CanvasEvent } from '../api/canvas';

export type LongTaskStatus = 'idle' | 'running' | 'paused' | 'completed' | 'stopped';

export type StopReason = 'task_complete' | 'max_rounds' | 'budget_exhausted' | 'user_cancelled' | 'error';

export interface LongTaskState {
  enabled: boolean;
  status: LongTaskStatus;
  currentRound: number;
  maxRounds: number;
  tokensUsed: number;
  tokenBudget: number;
  estimatedCostUsd: number;
  budgetCostUsd: number;
  stopReason: StopReason | null;
  startedAt: number | null;
}

export interface ToolStatus {
  id: number;
  name: string;
  status: 'running' | 'done';
  preview?: string;        // args preview (set on start)
  resultPreview?: string;  // result preview (set on end)
}

export interface ClaudeCodeState {
  active: boolean;
  content: string;          // accumulated streaming text output
  workingDir: string;
  subTools: { name: string; status: 'running' | 'done' }[];
}

export interface SpawnAgent {
  name: string;
  task: string;
  status: 'running' | 'complete';
  content: string;
  tools: { name: string; status: 'running' | 'done'; preview?: string }[];
}

export interface TaskStreamState {
  loading: boolean;
  streamingContent: string;
  activeTools: ToolStatus[];
  toolIdCounter: number;
}

export interface FocusedTask {
  taskId: string;
  taskName: string;
  sessionId: string;
}

interface ChatStreamState {
  // State
  loading: boolean;
  streamingContent: string;
  streamingThinking: string;
  activeTools: ToolStatus[];
  spawnAgents: SpawnAgent[];
  collapsedAgents: Set<string>;
  toolIdCounter: number;
  sessionId: string;
  claudeCode: ClaudeCodeState | null;
  errorMessage: string | null;
  longTask: LongTaskState;
  focusedTask: FocusedTask | null;

  // Canvas state
  canvases: CanvasEvent[];

  // Actions
  setSessionId: (id: string) => void;
  startStream: () => void;
  appendChunk: (text: string) => void;
  appendThinking: (text: string) => void;
  toolStart: (name: string, preview: string) => void;
  toolEnd: (name: string, preview: string) => void;
  endStream: () => void;
  endStreamWithError: (error: string) => void;
  resetStream: () => void;
  clearStreamState: () => void;

  // Canvas actions
  addCanvas: (event: CanvasEvent) => void;
  clearCanvases: () => void;

  // Claude Code streaming actions
  claudeCodeStart: (workingDir: string) => void;
  claudeCodeTextDelta: (text: string) => void;
  claudeCodeToolStart: (toolName: string) => void;
  claudeCodeToolEnd: (toolName: string) => void;
  claudeCodeDone: () => void;

  // Spawn agent actions
  spawnStart: (agents: { name: string; task: string }[]) => void;
  spawnAgentChunk: (agentName: string, content: string) => void;
  spawnAgentTool: (agentName: string, type: 'start' | 'end', toolName: string, preview: string) => void;
  spawnAgentComplete: (agentName: string) => void;
  spawnComplete: () => void;
  toggleCollapseAgent: (agentName: string) => void;

  // Long task actions
  setLongTaskEnabled: (enabled: boolean) => void;
  setLongTaskConfig: (config: { maxRounds?: number; tokenBudget?: number }) => void;
  longTaskRoundStart: (round: number, maxRounds: number) => void;
  longTaskRoundComplete: (round: number, totalTokens: number) => void;
  longTaskFinished: (reason: StopReason) => void;
  longTaskReset: () => void;

  // Per-task streaming state for parallel task execution
  taskStreams: Map<string, TaskStreamState>;

  // Task stream actions
  taskStreamStart: (taskId: string) => void;
  taskStreamAppendChunk: (taskId: string, text: string) => void;
  taskStreamToolStart: (taskId: string, name: string, preview: string) => void;
  taskStreamToolEnd: (taskId: string, name: string, preview: string) => void;
  taskStreamEnd: (taskId: string) => void;
  taskStreamRemove: (taskId: string) => void;

  // Focus task actions
  focusTask: (taskId: string, taskName: string, sessionId: string) => void;
  unfocusTask: () => void;

  // Recovery
  recoverFromSnapshot: (snapshot: {
    accumulated_text: string;
    tools: { name: string; status: string; preview?: string }[];
    spawn_agents: { name: string; task: string; status: string; content: string; tools: { name: string; status: string; preview?: string }[] }[];
  }) => void;
}

const INITIAL_LONG_TASK: LongTaskState = {
  enabled: false,
  status: 'idle',
  currentRound: 0,
  maxRounds: 10,
  tokensUsed: 0,
  tokenBudget: 1_000_000,
  estimatedCostUsd: 0,
  budgetCostUsd: 3.0,
  stopReason: null,
  startedAt: null,
};

export const useChatStreamStore = create<ChatStreamState>((set, _get) => ({
  loading: false,
  streamingContent: '',
  streamingThinking: '',
  activeTools: [],
  spawnAgents: [],
  collapsedAgents: new Set(),
  toolIdCounter: 0,
  sessionId: '',
  claudeCode: null,
  errorMessage: null,
  longTask: { ...INITIAL_LONG_TASK },
  focusedTask: null,
  canvases: [],
  setSessionId: (id) => set({ sessionId: id }),

  startStream: () => set({
    loading: true,
    streamingContent: '',
    streamingThinking: '',
    activeTools: [],
    spawnAgents: [],
    collapsedAgents: new Set(),
    toolIdCounter: 0,
    claudeCode: null,
    errorMessage: null,
  }),

  appendChunk: (text) => set((state) => ({
    streamingContent: state.streamingContent + text,
  })),

  appendThinking: (text) => set((state) => ({
    streamingThinking: state.streamingThinking + text,
  })),

  toolStart: (name, preview) => set((state) => {
    const id = state.toolIdCounter + 1;
    return {
      toolIdCounter: id,
      activeTools: [...state.activeTools, { id, name, status: 'running' as const, preview }],
    };
  }),

  toolEnd: (name, preview) => set((state) => {
    const tools = [...state.activeTools];
    // Find the LAST running tool with this name (LIFO)
    for (let i = tools.length - 1; i >= 0; i--) {
      if (tools[i].name === name && tools[i].status === 'running') {
        tools[i] = { ...tools[i], status: 'done', resultPreview: preview || undefined };
        break;
      }
    }
    return { activeTools: tools };
  }),

  endStream: () => set({ loading: false, claudeCode: null }),

  endStreamWithError: (error) => set({ loading: false, claudeCode: null, errorMessage: error }),

  resetStream: () => set({
    loading: false,
    streamingContent: '',
    streamingThinking: '',
    activeTools: [],
    spawnAgents: [],
    collapsedAgents: new Set(),
    claudeCode: null,
    errorMessage: null,
  }),

  clearStreamState: () => set({
    streamingContent: '',
    streamingThinking: '',
    activeTools: [],
    claudeCode: null,
    canvases: [],
  }),

  // Canvas actions
  addCanvas: (event) => set((state) => ({
    canvases: [...state.canvases, event],
  })),

  clearCanvases: () => set({ canvases: [] }),

  // Claude Code streaming actions
  claudeCodeStart: (workingDir) => set({
    claudeCode: { active: true, content: '', workingDir, subTools: [] },
  }),

  claudeCodeTextDelta: (text) => set((state) => {
    if (!state.claudeCode) return {};
    const MAX_CONTENT = 50_000; // Cap display buffer to prevent memory/render issues
    let newContent = state.claudeCode.content + text;
    if (newContent.length > MAX_CONTENT) {
      newContent = '...(earlier output truncated)\n' + newContent.slice(-MAX_CONTENT);
    }
    return { claudeCode: { ...state.claudeCode, content: newContent } };
  }),

  claudeCodeToolStart: (toolName) => set((state) => ({
    claudeCode: state.claudeCode
      ? {
          ...state.claudeCode,
          subTools: [
            ...state.claudeCode.subTools,
            { name: toolName, status: 'running' as const },
          ],
        }
      : null,
  })),

  claudeCodeToolEnd: (toolName) => set((state) => {
    if (!state.claudeCode) return {};
    const subTools = [...state.claudeCode.subTools];
    for (let i = subTools.length - 1; i >= 0; i--) {
      if (subTools[i].name === toolName && subTools[i].status === 'running') {
        subTools[i] = { ...subTools[i], status: 'done' as const };
        break;
      }
    }
    return { claudeCode: { ...state.claudeCode, subTools } };
  }),

  claudeCodeDone: () => set((state) => ({
    claudeCode: state.claudeCode ? { ...state.claudeCode, active: false } : null,
  })),

  // Spawn agent actions
  spawnStart: (agents) => set({
    spawnAgents: agents.map((a) => ({
      name: a.name,
      task: a.task,
      status: 'running' as const,
      content: '',
      tools: [],
    })),
    collapsedAgents: new Set(),
  }),

  spawnAgentChunk: (agentName, content) => set((state) => ({
    spawnAgents: state.spawnAgents.map((a) =>
      a.name === agentName ? { ...a, content: a.content + content } : a
    ),
  })),

  spawnAgentTool: (agentName, type, toolName, preview) => set((state) => ({
    spawnAgents: state.spawnAgents.map((a) => {
      if (a.name !== agentName) return a;
      if (type === 'start') {
        return { ...a, tools: [...a.tools, { name: toolName, status: 'running' as const, preview }] };
      } else {
        return {
          ...a,
          tools: a.tools.map((t) =>
            t.name === toolName && t.status === 'running'
              ? { ...t, status: 'done' as const, preview: preview || t.preview }
              : t
          ),
        };
      }
    }),
  })),

  spawnAgentComplete: (agentName) => set((state) => ({
    spawnAgents: state.spawnAgents.map((a) =>
      a.name === agentName ? { ...a, status: 'complete' as const } : a
    ),
    collapsedAgents: new Set([...state.collapsedAgents, agentName]),
  })),

  spawnComplete: () => set((state) => ({
    spawnAgents: state.spawnAgents.map((a) =>
      a.status === 'running' ? { ...a, status: 'complete' as const } : a
    ),
  })),

  toggleCollapseAgent: (agentName) => set((state) => {
    const next = new Set(state.collapsedAgents);
    if (next.has(agentName)) next.delete(agentName);
    else next.add(agentName);
    return { collapsedAgents: next };
  }),

  // Long task actions
  setLongTaskEnabled: (enabled) => set((state) => ({
    longTask: {
      ...state.longTask,
      enabled,
      ...(enabled ? {} : {
        status: 'idle' as const,
        currentRound: 0,
        tokensUsed: 0,
        estimatedCostUsd: 0,
        stopReason: null,
        startedAt: null,
      }),
    },
  })),

  setLongTaskConfig: (config) => set((state) => ({
    longTask: {
      ...state.longTask,
      ...(config.maxRounds !== undefined && { maxRounds: config.maxRounds }),
      ...(config.tokenBudget !== undefined && {
        tokenBudget: config.tokenBudget,
        budgetCostUsd: config.tokenBudget / 330_000,
      }),
    },
  })),

  longTaskRoundStart: (round, maxRounds) => set((state) => ({
    longTask: {
      ...state.longTask,
      status: 'running',
      currentRound: round,
      maxRounds,
      startedAt: state.longTask.startedAt || Date.now(),
    },
  })),

  longTaskRoundComplete: (round, totalTokens) => set((state) => ({
    longTask: {
      ...state.longTask,
      currentRound: round,
      tokensUsed: totalTokens,
      estimatedCostUsd: totalTokens / 330_000,
    },
  })),

  longTaskFinished: (reason) => set((state) => ({
    longTask: {
      ...state.longTask,
      status: reason === 'task_complete' ? 'completed' : 'stopped',
      stopReason: reason,
    },
  })),

  longTaskReset: () => set((state) => ({
    longTask: {
      ...INITIAL_LONG_TASK,
      enabled: state.longTask.enabled,
      maxRounds: state.longTask.maxRounds,
      tokenBudget: state.longTask.tokenBudget,
      budgetCostUsd: state.longTask.budgetCostUsd,
    },
  })),

  // Per-task streaming state
  taskStreams: new Map(),

  taskStreamStart: (taskId) => set((state) => {
    const next = new Map(state.taskStreams);
    next.set(taskId, { loading: true, streamingContent: '', activeTools: [], toolIdCounter: 0 });
    return { taskStreams: next };
  }),

  taskStreamAppendChunk: (taskId, text) => set((state) => {
    const next = new Map(state.taskStreams);
    const ts = next.get(taskId);
    if (ts) {
      next.set(taskId, { ...ts, streamingContent: ts.streamingContent + text });
    }
    return { taskStreams: next };
  }),

  taskStreamToolStart: (taskId, name, preview) => set((state) => {
    const next = new Map(state.taskStreams);
    const ts = next.get(taskId);
    if (ts) {
      const id = ts.toolIdCounter + 1;
      next.set(taskId, {
        ...ts,
        toolIdCounter: id,
        activeTools: [...ts.activeTools, { id, name, status: 'running' as const, preview }],
      });
    }
    return { taskStreams: next };
  }),

  taskStreamToolEnd: (taskId, name, preview) => set((state) => {
    const next = new Map(state.taskStreams);
    const ts = next.get(taskId);
    if (ts) {
      const tools = [...ts.activeTools];
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].name === name && tools[i].status === 'running') {
          tools[i] = { ...tools[i], status: 'done', resultPreview: preview || undefined };
          break;
        }
      }
      next.set(taskId, { ...ts, activeTools: tools });
    }
    return { taskStreams: next };
  }),

  taskStreamEnd: (taskId) => set((state) => {
    const next = new Map(state.taskStreams);
    const ts = next.get(taskId);
    if (ts) {
      next.set(taskId, { ...ts, loading: false });
    }
    return { taskStreams: next };
  }),

  taskStreamRemove: (taskId) => set((state) => {
    const next = new Map(state.taskStreams);
    next.delete(taskId);
    return { taskStreams: next };
  }),

  // Focus task actions
  focusTask: (taskId, taskName, sessionId) => set({
    focusedTask: { taskId, taskName, sessionId },
  }),

  unfocusTask: () => set({ focusedTask: null }),

  recoverFromSnapshot: (snapshot) => set({
    loading: true,
    streamingContent: snapshot.accumulated_text,
    activeTools: snapshot.tools.map((t, i) => ({
      id: i + 1,
      name: t.name,
      status: t.status as 'running' | 'done',
      preview: t.preview,
    })),
    spawnAgents: snapshot.spawn_agents.map((a) => ({
      name: a.name,
      task: a.task,
      status: a.status as 'running' | 'complete',
      content: a.content,
      tools: a.tools.map((t) => ({
        name: t.name,
        status: t.status as 'running' | 'done',
        preview: t.preview,
      })),
    })),
    toolIdCounter: snapshot.tools.length,
  }),
}));

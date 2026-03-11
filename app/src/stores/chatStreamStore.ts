import { create } from 'zustand';

export interface ToolStatus {
  id: number;
  name: string;
  status: 'running' | 'done';
  preview?: string;
}

export interface SpawnAgent {
  name: string;
  task: string;
  status: 'running' | 'complete';
  content: string;
  tools: { name: string; status: 'running' | 'done'; preview?: string }[];
}

interface ChatStreamState {
  // State
  loading: boolean;
  streamingContent: string;
  activeTools: ToolStatus[];
  spawnAgents: SpawnAgent[];
  collapsedAgents: Set<string>;
  toolIdCounter: number;
  sessionId: string;

  // Actions
  setSessionId: (id: string) => void;
  startStream: () => void;
  appendChunk: (text: string) => void;
  toolStart: (name: string, preview: string) => void;
  toolEnd: (name: string, preview: string) => void;
  endStream: () => void;
  resetStream: () => void;

  // Spawn agent actions
  spawnStart: (agents: { name: string; task: string }[]) => void;
  spawnAgentChunk: (agentName: string, content: string) => void;
  spawnAgentTool: (agentName: string, type: 'start' | 'end', toolName: string, preview: string) => void;
  spawnAgentComplete: (agentName: string) => void;
  spawnComplete: () => void;
  toggleCollapseAgent: (agentName: string) => void;

  // Recovery
  recoverFromSnapshot: (snapshot: {
    accumulated_text: string;
    tools: { name: string; status: string; preview?: string }[];
    spawn_agents: { name: string; task: string; status: string; content: string; tools: { name: string; status: string; preview?: string }[] }[];
  }) => void;
}

export const useChatStreamStore = create<ChatStreamState>((set, _get) => ({
  loading: false,
  streamingContent: '',
  activeTools: [],
  spawnAgents: [],
  collapsedAgents: new Set(),
  toolIdCounter: 0,
  sessionId: '',

  setSessionId: (id) => set({ sessionId: id }),

  startStream: () => set({
    loading: true,
    streamingContent: '',
    activeTools: [],
    spawnAgents: [],
    collapsedAgents: new Set(),
    toolIdCounter: 0,
  }),

  appendChunk: (text) => set((state) => ({
    streamingContent: state.streamingContent + text,
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
        tools[i] = { ...tools[i], status: 'done', preview: preview || tools[i].preview };
        break;
      }
    }
    return { activeTools: tools };
  }),

  endStream: () => set({ loading: false }),

  resetStream: () => set({
    loading: false,
    streamingContent: '',
    activeTools: [],
    spawnAgents: [],
    collapsedAgents: new Set(),
  }),

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

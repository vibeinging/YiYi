// API 类型定义

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export interface ChatResponse {
  reply: string;
  channel_id?: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BrowserInfo {
  browser_id: string;
  status: string;
  headless: boolean;
}

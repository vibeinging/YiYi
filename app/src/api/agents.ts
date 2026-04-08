/**
 * Agents API — Tauri invoke wrappers for the multi-agent system.
 */

import { invoke } from '@tauri-apps/api/core';

export interface AgentSummary {
  name: string;
  description: string;
  emoji: string;
  color: string | null;
  is_builtin: boolean;
  model: string | null;
  tool_count: number | null;
}

export interface AgentDefinition {
  name: string;
  description: string;
  model: string | null;
  max_iterations: number | null;
  tools: string[] | null;
  disallowed_tools: string[] | null;
  skills: string[];
  metadata: unknown;
  instructions: string;
}

export async function listAgents(): Promise<AgentSummary[]> {
  return await invoke<AgentSummary[]>('list_agents');
}

export async function getAgent(name: string): Promise<AgentDefinition | null> {
  return await invoke<AgentDefinition | null>('get_agent', { name });
}

export async function saveAgent(content: string): Promise<void> {
  return await invoke('save_agent', { content });
}

export async function deleteAgent(name: string): Promise<void> {
  return await invoke('delete_agent', { name });
}

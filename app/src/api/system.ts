// System API
import { invoke } from '@tauri-apps/api/core';
import type { ModelInfo, ShellResult } from './types';

export async function healthCheck(): Promise<{
  status: string;
  version: string;
  methods: string[];
}> {
  return await invoke('health_check');
}

export async function listModels(): Promise<ModelInfo[]> {
  return await invoke('list_models');
}

export async function setModel(modelName: string): Promise<void> {
  await invoke('set_model', { modelName });
}

export async function executeShell(
  command: string,
  args?: string[],
  cwd?: string,
): Promise<ShellResult> {
  return await invoke('execute_shell', { command, args, cwd });
}

export async function isSetupComplete(): Promise<boolean> {
  return await invoke<boolean>('is_setup_complete');
}

export async function completeSetup(): Promise<void> {
  await invoke('complete_setup');
}

export async function getUserWorkspace(): Promise<string> {
  return await invoke('get_user_workspace');
}

export async function setUserWorkspace(path: string): Promise<void> {
  await invoke('set_user_workspace', { path });
}

export interface ClaudeCodeStatus {
  installed: boolean;
  has_api_key: boolean;
  available_provider?: {
    id: string;
    name: string;
    base_url: string;
  } | null;
}

export async function checkClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  return await invoke<ClaudeCodeStatus>('check_claude_code_status');
}

export interface InstallClaudeCodeResult {
  success: boolean;
  message: string;
  already_installed?: boolean;
  needs_node?: boolean;
  output?: string;
}

export async function installClaudeCode(): Promise<InstallClaudeCodeResult> {
  return await invoke<InstallClaudeCodeResult>('install_claude_code');
}

export async function checkToolAvailable(tool: string): Promise<boolean> {
  return invoke<boolean>('check_tool_available', { tool });
}

export async function installTool(tool: string): Promise<string> {
  return invoke<string>('install_tool', { tool });
}

/** @deprecated Use checkToolAvailable('git') instead */
export async function checkGitAvailable(): Promise<boolean> {
  return checkToolAvailable('git');
}

/** @deprecated Use installTool('git') instead */
export async function installGit(): Promise<string> {
  return installTool('git');
}

export async function getAppFlag(key: string): Promise<string | null> {
  return await invoke<string | null>('get_app_flag', { key });
}

export async function setAppFlag(key: string, value: string): Promise<void> {
  await invoke('set_app_flag', { key, value });
}

// Growth System API

export interface GrowthReport {
  total_tasks: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  success_rate: number;
  top_lessons: string[];
}

export interface CapabilityDimension {
  name: string;
  success_rate: number;
  sample_count: number;
  confidence: string;
}

export interface GrowthMilestone {
  date: string;
  event_type: string;
  title: string;
  description: string;
}

export interface GrowthData {
  report: GrowthReport | null;
  skill_suggestion: string | null;
  capabilities: CapabilityDimension[];
  timeline: GrowthMilestone[];
}

export async function getGrowthReport(): Promise<GrowthData> {
  return await invoke<GrowthData>('get_growth_report');
}

export async function getMorningGreeting(): Promise<string | null> {
  return await invoke<string | null>('get_morning_greeting');
}

export async function saveMeditationConfig(
  enabled: boolean,
  startTime: string,
  notifyOnComplete: boolean,
): Promise<void> {
  await invoke('save_meditation_config', { enabled, startTime, notifyOnComplete });
}

// Quick Actions API

export interface CustomQuickAction {
  id: string;
  label: string;
  description: string;
  prompt: string;
  icon: string;
  color: string;
  sortOrder: number;
}

export async function listQuickActions(): Promise<CustomQuickAction[]> {
  return await invoke<CustomQuickAction[]>('list_quick_actions');
}

export async function addQuickAction(
  label: string,
  description: string,
  prompt: string,
  icon: string = 'Zap',
  color: string = '#6366F1',
): Promise<string> {
  return await invoke<string>('add_quick_action', { label, description, prompt, icon, color });
}

export async function updateQuickAction(
  id: string,
  label: string,
  description: string,
  prompt: string,
  icon: string = 'Zap',
  color: string = '#6366F1',
): Promise<void> {
  await invoke('update_quick_action', { id, label, description, prompt, icon, color });
}

export async function deleteQuickAction(id: string): Promise<void> {
  await invoke('delete_quick_action', { id });
}

// ---------------------------------------------------------------------------
// MemMe Memory Engine Configuration
// ---------------------------------------------------------------------------

export interface MemmeConfig {
  // Embedding is hard-coded to local bge-small-zh-v1.5 (512 dims) in the Rust
  // backend. These five fields are kept for config-file back-compat only —
  // the UI does not let the user edit them and the backend ignores them.
  embedding_provider: string;      // always "local-bge-zh"
  embedding_model: string;         // always "bge-small-zh-v1.5"
  embedding_api_key: string;       // unused
  embedding_base_url: string;      // unused
  embedding_dims: number;          // always 512
  enable_graph: boolean;           // knowledge graph
  enable_forgetting_curve: boolean; // Ebbinghaus forgetting curve
  extraction_depth: string;        // "standard" | "thorough"
  // Optional dedicated LLM for memory operations (meditate/extract/graph).
  // If empty, falls back to main active LLM. Use case: main model is expensive.
  memory_llm_base_url: string;
  memory_llm_api_key: string;
  memory_llm_model: string;
}

export interface IdentityTrait {
  trait_id: string;
  trait_type: string;  // "Role" | "Belief" | "Value" | "Style" | "Goal"
  content: string;
  confidence: number;
  evidence_ids: string[];
}

export async function getMemmeConfig(): Promise<MemmeConfig> {
  return await invoke<MemmeConfig>('get_memme_config');
}

export interface SaveMemmeConfigResult {
  llm_hot_swapped: boolean;
  warning: string | null;
}

export async function saveMemmeConfig(config: MemmeConfig): Promise<SaveMemmeConfigResult> {
  return await invoke<SaveMemmeConfigResult>('save_memme_config', { config });
}

export async function getIdentityTraits(): Promise<IdentityTrait[]> {
  return await invoke<IdentityTrait[]>('get_identity_traits');
}

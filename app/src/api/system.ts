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

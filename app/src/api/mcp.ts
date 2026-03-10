// MCP (Model Context Protocol) API
import { invoke } from '@tauri-apps/api/core';

export type MCPTransport = 'stdio' | 'streamable_http' | 'sse';

export interface MCPClientInfo {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: MCPTransport;
  url: string;
  headers: Record<string, string>;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface MCPClientCreateRequest {
  name: string;
  description?: string;
  enabled?: boolean;
  transport?: MCPTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export async function listMCPClients(): Promise<MCPClientInfo[]> {
  return await invoke('list_mcp_clients');
}

export async function getMCPClient(key: string): Promise<MCPClientInfo> {
  return await invoke('get_mcp_client', { key });
}

export async function createMCPClient(
  clientKey: string,
  client: MCPClientCreateRequest,
): Promise<MCPClientInfo> {
  return await invoke('create_mcp_client', { clientKey, client });
}

export async function updateMCPClient(
  key: string,
  client: MCPClientCreateRequest,
): Promise<MCPClientInfo> {
  return await invoke('update_mcp_client', { key, client });
}

export async function toggleMCPClient(key: string): Promise<MCPClientInfo> {
  return await invoke('toggle_mcp_client', { key });
}

export async function deleteMCPClient(key: string): Promise<{ message: string }> {
  return await invoke('delete_mcp_client', { key });
}

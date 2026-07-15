import type { Artifact, PlanStep, SkillTrace, ToolCall } from '@/layout/workstation/Workstation'

export interface AgentBlock {
  id: string
  type: string
  content: string
  title?: string
  display_type?: string
  metadata?: any
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  blocks: AgentBlock[]
  workstationBlocks?: AgentBlock[]
}

export interface DataWorkspaceEvent {
  type?: string
  event?: 'project_created' | 'session_moved' | 'project_data_preparing' | 'project_ready_for_query' | string
  source_tool?: string
  origin_project_id?: string | null
  session_id?: string | null
  project_id?: string
  project?: any
  connection_id?: string | null
  data_source_id?: string | null
  table_count?: number
  document_count?: number
  status?: string | null
  next_skill?: string | null
}

export interface AgentStreamEventV1 {
  v: 1
  type: string
  run_id?: string | null
  session_id?: string | null
  message_id?: string | null
  seq?: number
  ts?: string
  visibility?: 'primary' | 'secondary' | 'hidden' | 'action'
  payload?: any
}

export interface WorkstationPatch {
  plan?: PlanStep[]
  tool?: { id: string; value: ToolCall }
  toolResult?: { id: string; result: string }
  artifact?: { id: string; value: Artifact }
  skill?: { id: string; value: SkillTrace }
}

export interface AgentStreamPatch {
  block?: AgentBlock
  workstation?: WorkstationPatch
  workspaceEvent?: DataWorkspaceEvent
  scrollDelayMs?: number
  ignored?: boolean
}

export interface WorkstationDraft {
  tools: Map<string, ToolCall>
  artifacts: Map<string, Artifact>
  skills: Map<string, SkillTrace>
  plan: PlanStep[]
}

export type { Artifact, PlanStep, SkillTrace, ToolCall }

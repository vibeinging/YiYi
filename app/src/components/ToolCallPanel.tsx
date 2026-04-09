/**
 * ToolCallPanel — Clean, minimal tool activity display.
 *
 * Design principles:
 * - Inline, unobtrusive — tools are secondary to the conversation
 * - Progressive disclosure — collapsed summary by default, expand for details
 * - Consistent status indicators — dot + verb pattern
 */

import { useState, useEffect, useRef, memo } from 'react';
import { Loader2, CheckCircle2, ChevronRight, AlertCircle, Terminal, ExternalLink } from 'lucide-react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

import { useChatStreamStore } from '../stores/chatStreamStore';
import type { ToolStatus, ClaudeCodeState } from '../stores/chatStreamStore';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export const TOOL_VERBS: Record<string, [string, string]> = {
  read_file: ['Reading', 'Read'],
  write_file: ['Writing', 'Wrote'],
  edit_file: ['Editing', 'Edited'],
  list_directory: ['Listing', 'Listed'],
  glob_search: ['Searching', 'Searched'],
  grep_search: ['Searching', 'Searched'],
  execute_shell: ['Running', 'Ran'],
  browser_use: ['Browsing', 'Browsed'],
  web_search: ['Searching', 'Searched'],
  memory_add: ['Remembering', 'Remembered'],
  memory_search: ['Recalling', 'Recalled'],
  memory_read: ['Reading memory', 'Read memory'],
  memory_write: ['Writing memory', 'Wrote memory'],
  diary_write: ['Writing diary', 'Wrote diary'],
  diary_read: ['Reading diary', 'Read diary'],
  run_python: ['Executing Python', 'Executed Python'],
  run_python_script: ['Running script', 'Ran script'],
  pip_install: ['Installing', 'Installed'],
  desktop_screenshot: ['Capturing screen', 'Captured screen'],
  send_notification: ['Notifying', 'Notified'],
  manage_cronjob: ['Managing cron', 'Managed cron'],
  manage_skill: ['Managing skill', 'Managed skill'],
  send_bot_message: ['Sending message', 'Sent message'],
  spawn_agents: ['Dispatching team', 'Team completed'],
  read_pdf: ['Reading PDF', 'Read PDF'],
  create_docx: ['Creating document', 'Created document'],
  create_spreadsheet: ['Creating spreadsheet', 'Created spreadsheet'],
  claude_code: ['Claude Code working', 'Claude Code completed'],
  create_task: ['Creating task', 'Task created'],
};

export function getToolLabel(name: string, status: 'running' | 'done'): string {
  const verbs = TOOL_VERBS[name];
  if (verbs) return status === 'running' ? verbs[0] : verbs[1];
  const base = name.replace(/_/g, ' ');
  return status === 'running' ? `Running ${base}` : `Ran ${base}`;
}

function truncate(s: string | undefined, max = 80): string {
  if (!s) return '';
  const line = s.replace(/\n/g, ' ').trim();
  return line.length > max ? line.slice(0, max) + '...' : line;
}

/* ------------------------------------------------------------------ */
/*  Claude Code Live Panel                                             */
/* ------------------------------------------------------------------ */

async function openClaudeCodeWindow(sessionId: string) {
  const label = `claude-code-${Date.now()}`;
  const url = sessionId
    ? `index.html?view=claude-code-terminal&session=${encodeURIComponent(sessionId)}`
    : 'index.html?view=claude-code-terminal';
  try {
    const win = new WebviewWindow(label, {
      url,
      title: 'Claude Code Terminal',
      width: 800,
      height: 600,
      minWidth: 500,
      minHeight: 400,
      resizable: true,
      decorations: true,
    });
    win.once('tauri://error', (e) => {
      console.error('Failed to create Claude Code window:', e);
    });
  } catch (e) {
    console.error('Failed to create Claude Code window:', e);
  }
}

const ClaudeCodePanel = memo(function ClaudeCodePanel({ state }: { state: ClaudeCodeState }) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionId = useChatStreamStore((s) => s.sessionId);

  useEffect(() => {
    if (scrollRef.current && state.active) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.content, state.active]);

  useEffect(() => {
    if (!state.active && state.content) {
      const timer = setTimeout(() => setCollapsed(true), 800);
      return () => clearTimeout(timer);
    }
  }, [state.active, state.content]);

  const activeSubTools = state.subTools.filter((t) => t.status === 'running');

  return (
    <div
      style={{
        borderRadius: '12px',
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${state.active ? 'color-mix(in srgb, var(--color-primary) 30%, var(--color-border))' : 'var(--color-border)'}`,
        overflow: 'hidden',
        transition: 'border-color 0.3s ease',
      }}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
        onClick={() => setCollapsed((p) => !p)}
        style={{ background: 'transparent', transition: 'background 0.15s' }}
      >
        <ChevronRight
          size={11}
          style={{
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.2s',
            color: 'var(--color-text-muted)',
          }}
        />
        <Terminal size={12} style={{ color: state.active ? 'var(--color-primary)' : 'var(--color-success)' }} />
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text)', fontFamily: 'var(--font-text)' }}>
          Claude Code
        </span>
        {activeSubTools.length > 0 && (
          <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
            {activeSubTools.map((t) => t.name).join(', ')}
          </span>
        )}
        <div className="flex-1" />
        {state.active ? (
          <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
        ) : (
          <CheckCircle2 size={12} style={{ color: 'var(--color-success)' }} />
        )}
      </button>

      {!collapsed && (
        <div
          ref={scrollRef}
          style={{
            maxHeight: '280px',
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            padding: '6px 12px 8px',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          {state.subTools.length > 0 && (
            <div style={{ marginBottom: '6px' }}>
              {state.subTools.map((tool, i) => (
                <div key={`${tool.name}-${i}`} className="flex items-center gap-1.5 py-[2px]"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', lineHeight: '16px' }}>
                  {tool.status === 'running' ? (
                    <Loader2 size={9} className="animate-spin shrink-0" style={{ color: 'var(--color-primary)' }} />
                  ) : (
                    <CheckCircle2 size={9} className="shrink-0" style={{ color: 'var(--color-success)' }} />
                  )}
                  <span style={{ color: tool.status === 'running' ? 'var(--color-primary)' : 'var(--color-text-muted)', fontWeight: 500 }}>
                    {tool.name}
                  </span>
                </div>
              ))}
            </div>
          )}
          {state.content && (
            <pre style={{
              fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)',
              lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
            }}>
              {state.content}
              {state.active && (
                <span className="inline-block w-1.5 h-3 ml-0.5 animate-pulse rounded-sm"
                  style={{ background: 'var(--color-primary)', verticalAlign: 'text-bottom' }} />
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Single tool line                                                   */
/* ------------------------------------------------------------------ */

const ToolLine = memo(function ToolLine({ tool }: { tool: ToolStatus }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = tool.status === 'running';
  const label = getToolLabel(tool.name, tool.status);
  const preview = truncate(tool.preview);
  const hasResult = !isRunning && tool.resultPreview;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-[3px] group"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11.5px',
          lineHeight: '18px',
          cursor: hasResult ? 'pointer' : 'default',
        }}
        onClick={() => hasResult && setExpanded((p) => !p)}
      >
        {/* Status dot */}
        <div className="shrink-0" style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: isRunning ? 'var(--color-primary)' : 'var(--color-success)',
          boxShadow: isRunning ? '0 0 6px var(--color-primary)' : 'none',
          transition: 'all 0.3s',
        }} />

        {/* Label */}
        <span style={{
          color: isRunning ? 'var(--color-text)' : 'var(--color-text-secondary)',
          fontWeight: 500, whiteSpace: 'nowrap',
        }}>
          {label}
        </span>

        {/* Preview */}
        {preview && (
          <span className="truncate" style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
            {preview}
          </span>
        )}

        {/* Expand arrow */}
        {hasResult && (
          <ChevronRight size={10}
            className="shrink-0 ml-auto opacity-0 group-hover:opacity-50 transition-opacity"
            style={{
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
              color: 'var(--color-text-muted)',
            }}
          />
        )}
      </div>

      {expanded && tool.resultPreview && (
        <div style={{
          fontSize: '10.5px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)',
          padding: '2px 0 4px 14px', lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          maxHeight: '160px', overflowY: 'auto', scrollbarWidth: 'thin',
          borderLeft: '2px solid var(--color-border)',
          marginLeft: '2px',
        }}>
          {tool.resultPreview}
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

interface ToolCallPanelProps {
  tools: ToolStatus[];
  /** When true, don't read claudeCode from store (used for history rendering) */
  isHistory?: boolean;
}

export const ToolCallPanel = memo(function ToolCallPanel({ tools, isHistory }: ToolCallPanelProps) {
  const claudeCode = useChatStreamStore((s) => isHistory ? null : s.claudeCode);
  const completedCount = tools.filter((t) => t.status === 'done').length;
  const totalCount = tools.length;
  const allDone = completedCount === totalCount;
  const isAnyRunning = tools.some((t) => t.status === 'running');

  const [collapsed, setCollapsed] = useState(isHistory || false);

  useEffect(() => {
    if (isHistory) return;
    if (allDone && totalCount > 0) {
      setCollapsed(true);
    } else if (isAnyRunning) {
      setCollapsed(false);
    }
  }, [allDone, isAnyRunning, totalCount, isHistory]);

  // Don't show empty panel
  if (tools.length === 0 && !claudeCode) return null;

  return (
    <div className="space-y-2">
      {claudeCode && <ClaudeCodePanel state={claudeCode} />}

      {tools.length > 0 && (
        <div
          style={{
            borderRadius: '12px',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
            onClick={() => setCollapsed((p) => !p)}
            style={{ background: 'transparent', transition: 'background 0.15s' }}
          >
            <ChevronRight
              size={11}
              style={{
                transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 0.2s',
                color: 'var(--color-text-muted)',
              }}
            />

            {/* Summary when collapsed */}
            {collapsed ? (
              <span style={{
                fontSize: '12px', color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-mono)', fontWeight: 400,
              }}>
                {allDone
                  ? `Used ${totalCount} tool${totalCount > 1 ? 's' : ''}`
                  : `Running tools...`
                }
              </span>
            ) : (
              <span style={{
                fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-text)',
              }}>
                Tools
              </span>
            )}

            <div className="flex-1" />

            <div className="flex items-center gap-1.5 shrink-0">
              {!collapsed && (
                <span style={{
                  fontSize: '10px', fontFamily: 'var(--font-mono)',
                  color: allDone ? 'var(--color-success)' : 'var(--color-text-muted)',
                  fontWeight: 500,
                }}>
                  {completedCount}/{totalCount}
                </span>
              )}
              {isAnyRunning ? (
                <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
              ) : (
                <CheckCircle2 size={12} style={{ color: 'var(--color-success)' }} />
              )}
            </div>
          </button>

          {/* Tool list */}
          <div style={{
            maxHeight: collapsed ? '0px' : `${tools.length * 26 + 16}px`,
            opacity: collapsed ? 0 : 1,
            overflow: 'hidden',
            transition: 'max-height 0.25s ease, opacity 0.2s ease',
          }}>
            <div style={{ padding: '2px 12px 8px' }}>
              {tools.map((tool) => (
                <ToolLine key={tool.id} tool={tool} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Historical Spawn Agents Panel                                      */
/* ------------------------------------------------------------------ */

interface SpawnAgentResultData {
  name: string;
  result: string;
  is_error?: boolean;
}

interface HistorySpawnAgentsPanelProps {
  agents: SpawnAgentResultData[];
}

/** Renders spawn agent results from chat history (all completed). */
export const HistorySpawnAgentsPanel = memo(function HistorySpawnAgentsPanel({ agents }: HistorySpawnAgentsPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  return (
    <div style={{
      borderRadius: '12px',
      background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
        onClick={() => setCollapsed((p) => !p)}
        style={{ background: 'transparent', transition: 'background 0.15s' }}
      >
        <ChevronRight
          size={11}
          style={{
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.2s',
            color: 'var(--color-text-muted)',
          }}
        />

        {collapsed ? (
          <span style={{
            fontSize: '12px', color: 'var(--color-text-secondary)',
            fontFamily: 'var(--font-mono)', fontWeight: 400,
          }}>
            {agents.length} agent{agents.length > 1 ? 's' : ''} completed
          </span>
        ) : (
          <span style={{
            fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)',
            fontFamily: 'var(--font-text)',
          }}>
            Agent Team
          </span>
        )}

        <div className="flex-1" />
        <CheckCircle2 size={12} style={{ color: 'var(--color-success)' }} />
      </button>

      {/* Agent list */}
      <div style={{
        maxHeight: collapsed ? '0px' : '600px',
        opacity: collapsed ? 0 : 1,
        overflow: collapsed ? 'hidden' : 'visible',
        transition: 'max-height 0.3s ease, opacity 0.2s ease',
      }}>
        <div style={{ padding: '0 8px 8px' }}>
          {agents.map((agent) => {
            const isExpanded = expandedAgent === agent.name;
            return (
              <div key={agent.name} style={{
                borderRadius: '8px',
                background: 'var(--color-bg)',
                marginBottom: '4px',
                overflow: 'hidden',
              }}>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-bg-muted)]"
                  onClick={() => setExpandedAgent(isExpanded ? null : agent.name)}
                  style={{ background: 'transparent', transition: 'background 0.15s' }}
                >
                  <ChevronRight
                    size={10}
                    style={{
                      transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 0.15s',
                      color: 'var(--color-text-muted)',
                    }}
                  />
                  {agent.is_error ? (
                    <AlertCircle size={11} className="shrink-0" style={{ color: 'var(--color-error, #ef4444)' }} />
                  ) : (
                    <CheckCircle2 size={11} className="shrink-0" style={{ color: 'var(--color-success)' }} />
                  )}
                  <span style={{
                    fontSize: '12px', fontWeight: 500,
                    color: 'var(--color-text)',
                    fontFamily: 'var(--font-text)',
                  }}>
                    {agent.name}
                  </span>
                  {!isExpanded && (
                    <span className="truncate" style={{
                      fontSize: '11px', color: 'var(--color-text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {truncate(agent.result, 60)}
                    </span>
                  )}
                </button>

                {isExpanded && (
                  <div style={{
                    padding: '4px 12px 8px 28px',
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)',
                    color: agent.is_error ? 'var(--color-error, #ef4444)' : 'var(--color-text-secondary)',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    scrollbarWidth: 'thin',
                    borderTop: '1px solid var(--color-border)',
                  }}>
                    {agent.result}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default ToolCallPanel;

/**
 * SpawnAgentPanel — Mission Control for sub-agent execution
 *
 * Design: Industrial terminal aesthetic with monospace accents,
 * real-time streaming logs, Claude Code-style present/past tense
 * tool display, and smooth state transitions.
 */

import { useState, useRef, useEffect, memo, useCallback } from 'react';
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  Terminal,
  Cpu,
  Activity,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

import type { SpawnAgent } from '../stores/chatStreamStore';

export type { SpawnAgent };

export interface SpawnAgentTool {
  name: string;
  status: 'running' | 'done';
  preview?: string;
}

interface SpawnAgentPanelProps {
  agents: SpawnAgent[];
  collapsedAgents: Set<string>;
  onToggleCollapse: (agentName: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Map tool names to present/past tense verbs (Claude Code pattern) */
const TOOL_VERBS: Record<string, [string, string]> = {
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
  spawn_agents: ['Spawning agents', 'Spawned agents'],
  read_pdf: ['Reading PDF', 'Read PDF'],
  create_docx: ['Creating document', 'Created document'],
  create_spreadsheet: ['Creating spreadsheet', 'Created spreadsheet'],
};

function getToolLabel(toolName: string, status: 'running' | 'done'): string {
  const verbs = TOOL_VERBS[toolName];
  if (verbs) return status === 'running' ? verbs[0] : verbs[1];
  // Fallback: capitalize and add -ing/-ed
  const base = toolName.replace(/_/g, ' ');
  return status === 'running' ? `Running ${base}` : `Ran ${base}`;
}

function truncatePreview(preview: string | undefined, maxLen = 60): string {
  if (!preview) return '';
  const oneLine = preview.replace(/\n/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

/** Elapsed time display */
function useElapsed(running: boolean): string {
  const startRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    startRef.current = Date.now();
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running) return '';
  const secs = Math.floor((now - startRef.current) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

/** Single tool call line — terminal log style */
const ToolLine = memo(function ToolLine({ tool }: { tool: SpawnAgentTool }) {
  const isRunning = tool.status === 'running';
  const label = getToolLabel(tool.name, tool.status);
  const preview = truncatePreview(tool.preview);

  return (
    <div
      className="flex items-center gap-1.5 py-[3px] group"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '11.5px',
        lineHeight: '18px',
      }}
    >
      {/* Status icon */}
      {isRunning ? (
        <Loader2
          size={11}
          className="animate-spin shrink-0"
          style={{ color: 'var(--color-primary)' }}
        />
      ) : (
        <CheckCircle2
          size={11}
          className="shrink-0"
          style={{ color: 'var(--color-success)' }}
        />
      )}

      {/* Verb label */}
      <span
        style={{
          color: isRunning ? 'var(--color-primary)' : 'var(--color-text-secondary)',
          fontWeight: 500,
        }}
      >
        {label}
      </span>

      {/* Preview — faded */}
      {preview && (
        <span
          className="truncate"
          style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}
        >
          {preview}
        </span>
      )}
    </div>
  );
});

/** Auto-scrolling content area with streaming cursor */
const StreamingContent = memo(function StreamingContent({
  content,
  isRunning,
}: {
  content: string;
  isRunning: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content]);

  if (!content) return null;

  return (
    <div
      ref={scrollRef}
      className="markdown-body"
      style={{
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--color-text-secondary)',
        maxHeight: '240px',
        overflowY: 'auto',
        padding: '0 2px',
        scrollbarWidth: 'thin',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
      {isRunning && (
        <span
          className="inline-block animate-pulse"
          style={{
            width: '6px',
            height: '14px',
            marginLeft: '2px',
            background: 'var(--color-primary)',
            borderRadius: '1px',
            verticalAlign: 'text-bottom',
          }}
        />
      )}
    </div>
  );
});

/** Single agent card */
const AgentCard = memo(function AgentCard({
  agent,
  isCollapsed,
  onToggle,
  index,
}: {
  agent: SpawnAgent;
  isCollapsed: boolean;
  onToggle: () => void;
  index: number;
}) {
  const isRunning = agent.status === 'running';
  const elapsed = useElapsed(isRunning);
  const completedTools = agent.tools.filter((t) => t.status === 'done').length;
  const totalTools = agent.tools.length;

  return (
    <div
      className="overflow-hidden"
      style={{
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg)',
        border: `1px solid ${isRunning ? 'var(--color-primary-subtle)' : 'transparent'}`,
        boxShadow: isRunning ? '0 0 0 1px var(--color-primary-subtle)' : 'none',
        transition: 'border-color 0.3s, box-shadow 0.3s',
        animationDelay: `${index * 80}ms`,
      }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left group"
        onClick={onToggle}
        style={{
          background: 'transparent',
          transition: 'background var(--transition-fast)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-bg-muted)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        {/* Expand chevron */}
        <div
          style={{
            transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.2s ease',
            color: 'var(--color-text-muted)',
          }}
        >
          <ChevronRight size={12} />
        </div>

        {/* Agent indicator */}
        <div
          className="shrink-0 flex items-center justify-center"
          style={{
            width: '18px',
            height: '18px',
            borderRadius: 'var(--radius-sm)',
            background: isRunning ? 'var(--color-primary-subtle)' : 'rgba(52, 199, 89, 0.1)',
            color: isRunning ? 'var(--color-primary)' : 'var(--color-success)',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
          }}
        >
          {isRunning ? <Activity size={10} /> : <CheckCircle2 size={10} />}
        </div>

        {/* Name */}
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--color-text)',
            fontFamily: 'var(--font-text)',
          }}
        >
          {agent.name}
        </span>

        {/* Task — truncated */}
        <span
          className="truncate flex-1"
          style={{
            fontSize: '11.5px',
            color: 'var(--color-text-tertiary)',
            fontFamily: 'var(--font-text)',
          }}
        >
          {agent.task}
        </span>

        {/* Meta info */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Tool progress */}
          {totalTools > 0 && (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                letterSpacing: '0.02em',
              }}
            >
              {completedTools}/{totalTools}
            </span>
          )}

          {/* Elapsed time */}
          {elapsed && (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                minWidth: '28px',
                textAlign: 'right',
              }}
            >
              {elapsed}
            </span>
          )}

          {/* Status indicator */}
          {isRunning ? (
            <div className="relative shrink-0" style={{ width: '14px', height: '14px' }}>
              <Loader2
                size={14}
                className="animate-spin absolute inset-0"
                style={{ color: 'var(--color-primary)' }}
              />
            </div>
          ) : (
            <CheckCircle2
              size={14}
              className="shrink-0"
              style={{ color: 'var(--color-success)' }}
            />
          )}
        </div>
      </button>

      {/* Collapsible body */}
      <div
        style={{
          maxHeight: isCollapsed ? '0px' : '500px',
          opacity: isCollapsed ? 0 : 1,
          overflow: 'hidden',
          transition: 'max-height 0.25s ease, opacity 0.2s ease',
        }}
      >
        <div
          style={{
            padding: '0 12px 10px',
          }}
        >
          {/* Divider */}
          <div
            style={{
              height: '1px',
              background: 'var(--color-border, rgba(255,255,255,0.06))',
              margin: '0 0 8px',
            }}
          />

          {/* Tool log — vertical list like terminal output */}
          {agent.tools.length > 0 && (
            <div style={{ marginBottom: agent.content ? '8px' : '0' }}>
              {agent.tools.map((tool, tidx) => (
                <ToolLine key={tidx} tool={tool} />
              ))}
            </div>
          )}

          {/* Streaming output */}
          <StreamingContent content={agent.content} isRunning={isRunning} />
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Main Panel                                                         */
/* ------------------------------------------------------------------ */

export const SpawnAgentPanel = memo(function SpawnAgentPanel({
  agents,
  collapsedAgents,
  onToggleCollapse,
}: SpawnAgentPanelProps) {
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const completedCount = agents.filter((a) => a.status === 'complete').length;
  const totalCount = agents.length;
  const allDone = completedCount === totalCount;
  const isAnyRunning = agents.some((a) => a.status === 'running');

  const handleToggleAgent = useCallback(
    (name: string) => onToggleCollapse(name),
    [onToggleCollapse],
  );

  return (
    <div className="flex gap-3 justify-start px-2">
      {/* Avatar */}
      <div
        className="shrink-0 flex items-center justify-center"
        style={{
          width: '32px',
          height: '32px',
          borderRadius: 'var(--radius-md)',
          background: allDone
            ? 'linear-gradient(135deg, rgba(52,199,89,0.15), rgba(52,199,89,0.05))'
            : 'linear-gradient(135deg, var(--color-primary-subtle), rgba(99,102,241,0.05))',
          color: allDone ? 'var(--color-success)' : 'var(--color-primary)',
          marginTop: '2px',
          transition: 'background 0.5s ease, color 0.5s ease',
        }}
      >
        <Cpu size={16} />
      </div>

      {/* Panel body */}
      <div className="flex-1 min-w-0">
        <div
          style={{
            borderRadius: 'var(--radius-lg)',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border, rgba(255,255,255,0.06))',
            boxShadow: 'var(--shadow-sm)',
            overflow: 'hidden',
          }}
        >
          {/* Panel header */}
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
            onClick={() => setPanelCollapsed((p) => !p)}
            style={{
              background: 'transparent',
              borderBottom: panelCollapsed
                ? 'none'
                : '1px solid var(--color-border, rgba(255,255,255,0.06))',
              transition: 'background var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-bg-muted)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {/* Toggle */}
            <div
              style={{
                transform: panelCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 0.2s ease',
                color: 'var(--color-text-muted)',
              }}
            >
              <ChevronRight size={13} />
            </div>

            {/* Title */}
            <Terminal
              size={13}
              style={{ color: isAnyRunning ? 'var(--color-primary)' : 'var(--color-success)' }}
            />
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--color-text)',
                fontFamily: 'var(--font-text)',
              }}
            >
              Agent Team
            </span>

            {/* Progress indicator */}
            <div className="flex items-center gap-2 ml-auto">
              {/* Mini progress dots */}
              <div className="flex items-center gap-1">
                {agents.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background:
                        a.status === 'complete'
                          ? 'var(--color-success)'
                          : 'var(--color-primary)',
                      opacity: a.status === 'complete' ? 1 : 0.5,
                      transition: 'background 0.3s, opacity 0.3s',
                      animation:
                        a.status === 'running' ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
                    }}
                  />
                ))}
              </div>

              {/* Count */}
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: allDone ? 'var(--color-success)' : 'var(--color-text-muted)',
                  fontWeight: 500,
                  transition: 'color 0.3s',
                }}
              >
                {completedCount}/{totalCount}
              </span>

              {allDone ? (
                <CheckCircle2 size={14} style={{ color: 'var(--color-success)' }} />
              ) : (
                <Loader2
                  size={14}
                  className="animate-spin"
                  style={{ color: 'var(--color-primary)' }}
                />
              )}
            </div>
          </button>

          {/* Agent cards */}
          <div
            style={{
              maxHeight: panelCollapsed ? '0px' : '2000px',
              opacity: panelCollapsed ? 0 : 1,
              overflow: panelCollapsed ? 'hidden' : 'visible',
              transition: 'max-height 0.3s ease, opacity 0.2s ease',
            }}
          >
            <div className="p-2 space-y-1.5">
              {agents.map((agent, idx) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  isCollapsed={collapsedAgents.has(agent.name)}
                  onToggle={() => handleToggleAgent(agent.name)}
                  index={idx}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
});

export default SpawnAgentPanel;

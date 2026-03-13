/**
 * SpawnAgentPanel — Live sub-agent execution panel.
 *
 * Design: Clean card-based layout matching ToolCallPanel.
 * Progressive disclosure with smooth transitions.
 */

import { useState, useRef, useEffect, memo, useCallback } from 'react';
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Cpu,
  Activity,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import { TOOL_VERBS, getToolLabel } from './ToolCallPanel';

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
/*  Streaming content                                                  */
/* ------------------------------------------------------------------ */

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
        maxHeight: '200px',
        overflowY: 'auto',
        scrollbarWidth: 'thin',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
      {isRunning && (
        <span className="inline-block animate-pulse"
          style={{ width: '6px', height: '14px', marginLeft: '2px', background: 'var(--color-primary)', borderRadius: '1px', verticalAlign: 'text-bottom' }}
        />
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Agent Card                                                         */
/* ------------------------------------------------------------------ */

const AgentCard = memo(function AgentCard({
  agent,
  isCollapsed,
  onToggle,
}: {
  agent: SpawnAgent;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const isRunning = agent.status === 'running';
  const elapsed = useElapsed(isRunning);
  const completedTools = agent.tools.filter((t) => t.status === 'done').length;
  const totalTools = agent.tools.length;

  return (
    <div style={{
      borderRadius: '8px',
      background: 'var(--color-bg)',
      overflow: 'hidden',
      border: isRunning ? '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)' : '1px solid transparent',
      transition: 'border-color 0.3s',
    }}>
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-bg-muted)]"
        onClick={onToggle}
        style={{ background: 'transparent', transition: 'background 0.15s' }}
      >
        <ChevronRight
          size={10}
          style={{
            transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.2s',
            color: 'var(--color-text-muted)',
          }}
        />

        {/* Status */}
        {isRunning ? (
          <Activity size={11} className="shrink-0" style={{ color: 'var(--color-primary)' }} />
        ) : (
          <CheckCircle2 size={11} className="shrink-0" style={{ color: 'var(--color-success)' }} />
        )}

        {/* Name */}
        <span style={{
          fontSize: '12px', fontWeight: 500,
          color: 'var(--color-text)',
          fontFamily: 'var(--font-text)',
        }}>
          {agent.name}
        </span>

        {/* Task preview when collapsed */}
        {isCollapsed && (
          <span className="truncate flex-1" style={{
            fontSize: '11px', color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-text)',
          }}>
            {agent.task}
          </span>
        )}

        {!isCollapsed && <div className="flex-1" />}

        {/* Meta */}
        <div className="flex items-center gap-1.5 shrink-0">
          {totalTools > 0 && (
            <span style={{
              fontSize: '10px', fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-muted)',
            }}>
              {completedTools}/{totalTools}
            </span>
          )}
          {elapsed && (
            <span style={{
              fontSize: '10px', fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-muted)',
            }}>
              {elapsed}
            </span>
          )}
          {isRunning && (
            <Loader2 size={11} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
          )}
        </div>
      </button>

      {/* Body */}
      <div style={{
        maxHeight: isCollapsed ? '0px' : '400px',
        opacity: isCollapsed ? 0 : 1,
        overflow: isCollapsed ? 'hidden' : 'auto',
        transition: 'max-height 0.25s ease, opacity 0.2s ease',
      }}>
        <div style={{ padding: '0 12px 8px', borderTop: '1px solid var(--color-border)' }}>
          {/* Tools */}
          {agent.tools.length > 0 && (
            <div style={{ padding: '6px 0' }}>
              {agent.tools.map((tool, tidx) => (
                <div key={tidx} className="flex items-center gap-2 py-[2px]"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '16px' }}>
                  <div className="shrink-0" style={{
                    width: '5px', height: '5px', borderRadius: '50%',
                    background: tool.status === 'running' ? 'var(--color-primary)' : 'var(--color-success)',
                    boxShadow: tool.status === 'running' ? '0 0 4px var(--color-primary)' : 'none',
                  }} />
                  <span style={{
                    color: tool.status === 'running' ? 'var(--color-text)' : 'var(--color-text-muted)',
                    fontWeight: 500,
                  }}>
                    {getToolLabel(tool.name, tool.status)}
                  </span>
                  {tool.preview && (
                    <span className="truncate" style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
                      {tool.preview.replace(/\n/g, ' ').slice(0, 50)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Content */}
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
          width: '32px', height: '32px', borderRadius: '10px',
          background: allDone
            ? 'linear-gradient(135deg, rgba(52,199,89,0.12), rgba(52,199,89,0.04))'
            : 'linear-gradient(135deg, var(--color-primary-subtle), rgba(99,102,241,0.04))',
          color: allDone ? 'var(--color-success)' : 'var(--color-primary)',
          marginTop: '2px',
          transition: 'background 0.5s, color 0.5s',
        }}
      >
        <Cpu size={16} />
      </div>

      {/* Panel */}
      <div className="flex-1 min-w-0">
        <div style={{
          borderRadius: '12px',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
            onClick={() => setPanelCollapsed((p) => !p)}
            style={{ background: 'transparent', transition: 'background 0.15s' }}
          >
            <ChevronRight
              size={11}
              style={{
                transform: panelCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 0.2s',
                color: 'var(--color-text-muted)',
              }}
            />

            {panelCollapsed ? (
              <span style={{
                fontSize: '12px', color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-mono)', fontWeight: 400,
              }}>
                {allDone
                  ? `${totalCount} agent${totalCount > 1 ? 's' : ''} completed`
                  : `Running ${totalCount} agent${totalCount > 1 ? 's' : ''}...`
                }
              </span>
            ) : (
              <span style={{
                fontSize: '12px', fontWeight: 500,
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-text)',
              }}>
                Agent Team
              </span>
            )}

            <div className="flex-1" />

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Progress dots */}
              <div className="flex items-center gap-1">
                {agents.map((a, i) => (
                  <div key={i} style={{
                    width: '5px', height: '5px', borderRadius: '50%',
                    background: a.status === 'complete' ? 'var(--color-success)' : 'var(--color-primary)',
                    opacity: a.status === 'complete' ? 1 : 0.5,
                    transition: 'all 0.3s',
                    animation: a.status === 'running' ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
                  }} />
                ))}
              </div>

              {!panelCollapsed && (
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

          {/* Agent cards */}
          <div style={{
            maxHeight: panelCollapsed ? '0px' : '2000px',
            opacity: panelCollapsed ? 0 : 1,
            overflow: panelCollapsed ? 'hidden' : 'visible',
            transition: 'max-height 0.3s ease, opacity 0.2s ease',
          }}>
            <div style={{ padding: '4px 8px 8px' }} className="space-y-1">
              {agents.map((agent, idx) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  isCollapsed={collapsedAgents.has(agent.name)}
                  onToggle={() => handleToggleAgent(agent.name)}
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

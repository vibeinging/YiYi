/**
 * ClaudeCodeTerminal — Standalone window for viewing Claude Code live output.
 * Opened via pop-out button in ClaudeCodePanel.
 * Listens to chat://claude_code_stream events and renders terminal-style output.
 */

import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Loader2, CheckCircle2, Terminal, XCircle } from 'lucide-react';

interface SubTool {
  name: string;
  status: 'running' | 'done';
}

export function ClaudeCodeTerminal() {
  const [active, setActive] = useState(true);
  const [content, setContent] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [subTools, setSubTools] = useState<SubTool[]>([]);
  const [error, setError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Get session_id from URL params
  const sessionId = new URLSearchParams(window.location.search).get('session') || '';

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, subTools]);

  useEffect(() => {
    const unlisten = listen<{
      type: string;
      session_id: string;
      content?: string;
      tool_name?: string;
      working_dir?: string;
      error?: boolean;
    }>('chat://claude_code_stream', (event) => {
      if (sessionId && event.payload.session_id !== sessionId) return;

      const { type, content: text, tool_name, working_dir: wd } = event.payload;

      switch (type) {
        case 'start':
          setActive(true);
          setContent('');
          setSubTools([]);
          setError(false);
          if (wd) setWorkingDir(wd);
          break;
        case 'text_delta':
          if (text) {
            setContent((prev) => {
              const MAX = 100_000;
              const next = prev + text;
              return next.length > MAX
                ? '...(earlier output truncated)\n' + next.slice(-MAX)
                : next;
            });
          }
          break;
        case 'tool_start':
          if (tool_name) {
            setSubTools((prev) => [...prev, { name: tool_name, status: 'running' }]);
          }
          break;
        case 'tool_end':
          if (tool_name) {
            setSubTools((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].name === tool_name && next[i].status === 'running') {
                  next[i] = { ...next[i], status: 'done' };
                  break;
                }
              }
              return next;
            });
          }
          break;
        case 'done':
          setActive(false);
          if (event.payload.error) setError(true);
          break;
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionId]);

  const activeSubTools = subTools.filter((t) => t.status === 'running');

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#1a1b26',
        color: '#a9b1d6',
        fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
        overflow: 'hidden',
      }}
    >
      {/* Title bar / Header */}
      <div
        data-tauri-drag-region
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 16px',
          background: '#16161e',
          borderBottom: '1px solid #292e42',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          flexShrink: 0,
        }}
      >
        <Terminal size={14} style={{ color: '#7aa2f7' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#c0caf5' }}>
          Claude Code
        </span>

        {activeSubTools.length > 0 && (
          <span style={{ fontSize: '11px', color: '#565f89' }}>
            {activeSubTools.map((t) => t.name).join(', ')}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {workingDir && (
          <span style={{ fontSize: '11px', color: '#565f89' }}>
            {workingDir}
          </span>
        )}

        {active ? (
          <Loader2 size={13} className="animate-spin" style={{ color: '#7aa2f7' }} />
        ) : error ? (
          <XCircle size={13} style={{ color: '#f7768e' }} />
        ) : (
          <CheckCircle2 size={13} style={{ color: '#9ece6a' }} />
        )}
      </div>

      {/* Sub-tools status */}
      {subTools.length > 0 && (
        <div
          style={{
            padding: '6px 16px',
            background: '#16161e',
            borderBottom: '1px solid #292e42',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 12px',
            flexShrink: 0,
          }}
        >
          {subTools.map((tool, i) => (
            <div
              key={`${tool.name}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                lineHeight: '18px',
              }}
            >
              {tool.status === 'running' ? (
                <Loader2 size={10} className="animate-spin" style={{ color: '#7aa2f7' }} />
              ) : (
                <CheckCircle2 size={10} style={{ color: '#9ece6a' }} />
              )}
              <span
                style={{
                  color: tool.status === 'running' ? '#7aa2f7' : '#565f89',
                  fontWeight: 500,
                }}
              >
                {tool.name}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Terminal content */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          scrollbarWidth: 'thin',
          scrollbarColor: '#292e42 transparent',
        }}
      >
        {content ? (
          <pre
            style={{
              margin: 0,
              fontSize: '12.5px',
              lineHeight: '1.7',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: '#a9b1d6',
            }}
          >
            {content}
            {active && (
              <span
                className="animate-pulse"
                style={{
                  display: 'inline-block',
                  width: '7px',
                  height: '15px',
                  background: '#7aa2f7',
                  borderRadius: '1px',
                  verticalAlign: 'text-bottom',
                  marginLeft: '2px',
                }}
              />
            )}
          </pre>
        ) : active ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: '#565f89',
              fontSize: '13px',
              paddingTop: '20px',
            }}
          >
            <Loader2 size={14} className="animate-spin" style={{ color: '#7aa2f7' }} />
            Waiting for output...
          </div>
        ) : (
          <div style={{ color: '#565f89', fontSize: '13px', paddingTop: '20px' }}>
            {error ? 'Claude Code exited with an error.' : 'Claude Code completed.'}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '4px 16px',
          background: '#16161e',
          borderTop: '1px solid #292e42',
          fontSize: '11px',
          color: '#565f89',
          flexShrink: 0,
        }}
      >
        <span>
          {active ? 'Running' : error ? 'Error' : 'Completed'}
        </span>
        <div style={{ flex: 1 }} />
        <span>{subTools.length} tools used</span>
      </div>
    </div>
  );
}

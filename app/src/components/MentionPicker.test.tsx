import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MentionPicker, buildMentionList } from './MentionPicker';
import type { BotInfo } from '../api/bots';
import type { WorkspaceFile } from '../api/workspace';
import type { AgentSummary } from '../api/agents';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const bot = (over: Partial<BotInfo> = {}): BotInfo => ({
  id: 'b1',
  name: 'MyBot',
  platform: 'discord',
  enabled: true,
  config: {},
  created_at: 0,
  updated_at: 0,
  ...over,
});

const file = (over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  name: 'readme.md',
  path: '/ws/readme.md',
  size: 1024,
  is_dir: false,
  modified: 0,
  ...over,
});

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: 'Planner',
  description: 'Makes plans',
  emoji: '🧠',
  color: '#fff',
  is_builtin: true,
  model: null,
  tool_count: 3,
  ...over,
});

describe('buildMentionList', () => {
  it('returns agents → bots → files ordering', () => {
    const items = buildMentionList(
      [bot()],
      [file()],
      '',
      [agent()],
    );
    expect(items.map((i) => i.type)).toEqual(['agent', 'bot', 'file']);
  });

  it('filters disabled bots', () => {
    const items = buildMentionList(
      [bot({ enabled: false, name: 'Disabled' }), bot({ id: 'b2', name: 'Live' })],
      [],
      '',
    );
    expect(items).toHaveLength(1);
    expect((items[0] as any).bot.name).toBe('Live');
  });

  it('case-insensitive query filter across agents/bots/files', () => {
    const items = buildMentionList(
      [bot({ name: 'Alpha' }), bot({ id: 'b2', name: 'Beta' })],
      [file({ name: 'alpha.ts' }), file({ path: '/x', name: 'zeta.ts' })],
      'ALPHA',
      [agent({ name: 'AlphaAgent' })],
    );
    expect(items).toHaveLength(3);
    expect(items.some((i) => i.type === 'agent')).toBe(true);
  });

  it('returns empty when nothing matches', () => {
    expect(buildMentionList([bot()], [file()], 'xyzxyz')).toEqual([]);
  });

  it('caps file results at MAX_FILES (8)', () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      file({ name: `f${i}.txt`, path: `/p/f${i}.txt` }),
    );
    const items = buildMentionList([], files, '');
    expect(items.filter((i) => i.type === 'file')).toHaveLength(8);
  });

  it('fuzzy matches non-contiguous query characters', () => {
    const items = buildMentionList(
      [],
      [
        file({ name: 'product-introduction.md', path: '/p/product-introduction.md' }),
        file({ name: 'random.txt', path: '/r.txt' }),
      ],
      'prdc',
    );
    expect(items).toHaveLength(1);
    expect((items[0] as any).file.name).toBe('product-introduction.md');
  });

  it('exact substring outranks scattered match', () => {
    const items = buildMentionList(
      [],
      [
        file({ name: 'agent-tools.ts', path: '/a/agent-tools.ts' }),
        file({ name: 'tool.md', path: '/tool.md' }),
      ],
      'tool',
    );
    expect((items[0] as any).file.name).toBe('tool.md');
  });
});

describe('MentionPicker file badges', () => {
  it('renders binary + large badges for flagged files', () => {
    render(
      <MentionPicker
        bots={[]}
        files={[
          file({ name: 'photo.png', path: '/p/photo.png', is_binary: true, size: 200_000 }),
          file({ name: 'huge.json', path: '/h.json', is_large: true, size: 5_000_000 }),
        ]}
        query=""
        selectedIndex={0}
        onSelectBot={() => {}}
        onSelectFile={() => {}}
      />,
    );
    expect(screen.getByText('binary')).toBeInTheDocument();
    expect(screen.getByText('large')).toBeInTheDocument();
  });
});

describe('MentionPicker', () => {
  it('shows "No results" when list is empty', () => {
    render(
      <MentionPicker
        bots={[]}
        files={[]}
        query="xxx"
        selectedIndex={0}
        onSelectBot={() => {}}
        onSelectFile={() => {}}
      />,
    );
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('renders agents, bots, files sections with labels', () => {
    render(
      <MentionPicker
        bots={[bot()]}
        files={[file({ name: 'a.ts', path: '/a.ts' })]}
        query=""
        selectedIndex={0}
        onSelectBot={() => {}}
        onSelectFile={() => {}}
        agents={[agent()]}
        onSelectAgent={() => {}}
      />,
    );
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Bots')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Planner')).toBeInTheDocument();
    expect(screen.getByText('MyBot')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('click on agent / bot / file fires matching callback', () => {
    const onAgent = vi.fn();
    const onBot = vi.fn();
    const onFile = vi.fn();
    render(
      <MentionPicker
        bots={[bot()]}
        files={[file({ name: 'a.ts', path: '/a.ts' })]}
        query=""
        selectedIndex={0}
        onSelectBot={onBot}
        onSelectFile={onFile}
        agents={[agent()]}
        onSelectAgent={onAgent}
      />,
    );
    fireEvent.click(screen.getByText('Planner'));
    fireEvent.click(screen.getByText('MyBot'));
    fireEvent.click(screen.getByText('a.ts'));
    expect(onAgent).toHaveBeenCalled();
    expect(onBot).toHaveBeenCalled();
    expect(onFile).toHaveBeenCalled();
  });
});

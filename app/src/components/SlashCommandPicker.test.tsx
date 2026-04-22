import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  SlashCommandPicker,
  SLASH_COMMANDS,
  filterCommands,
} from './SlashCommandPicker';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('filterCommands', () => {
  it('returns every command for empty query', () => {
    expect(filterCommands('')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('filters by prefix substring match', () => {
    const res = filterCommands('pla');
    expect(res.map((c) => c.name)).toContain('plan');
  });

  it('returns empty when nothing matches', () => {
    expect(filterCommands('nothinglikeme')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(filterCommands('CLEAR').map((c) => c.name)).toContain('clear');
  });
});

describe('SlashCommandPicker', () => {
  const t = (k: string) => k;

  it('returns null when no items match', () => {
    const { container } = render(
      <SlashCommandPicker query="xyzxyz" selectedIndex={0} onSelect={() => {}} t={t} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders all commands for empty query', () => {
    render(<SlashCommandPicker query="" selectedIndex={0} onSelect={() => {}} t={t} />);
    for (const cmd of SLASH_COMMANDS) {
      expect(screen.getByText(`/${cmd.name}`)).toBeInTheDocument();
    }
  });

  it('onSelect fires with the chosen command', () => {
    const onSelect = vi.fn();
    render(<SlashCommandPicker query="" selectedIndex={0} onSelect={onSelect} t={t} />);
    fireEvent.click(screen.getByText('/clear'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'clear' }));
  });
});

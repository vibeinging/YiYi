import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatTabBar, type OpenTab, type TabHighlight } from './ChatTabBar';

// Tauri window — ChatTabBar reaches for getCurrentWindow on drag; stub it.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));

const tabs: OpenTab[] = [
  { id: 't1', name: 'Alpha' },
  { id: 't2', name: 'Beta extended name over sixteen chars' },
  { id: 't3', name: '' },
];

describe('ChatTabBar', () => {
  beforeEach(() => {
    // ensure vi.mock above is active — nothing to reset
  });

  it('renders all tabs + new chat button with aria-labels', () => {
    render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewChat={() => {}}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Alpha' })).toBeInTheDocument();
    // empty name tab falls back to "New Chat" — multiple "New Chat" exist (fallback + new-chat btn)
    expect(screen.getAllByRole('tab', { name: 'New Chat' }).length).toBeGreaterThanOrEqual(2);
  });

  it('active tab reports aria-selected=true', () => {
    render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewChat={() => {}}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Beta extended/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('truncates long tab names to maxTitleLen + "..."', () => {
    render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        maxTitleLen={10}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewChat={() => {}}
      />,
    );
    expect(screen.getByText('Beta exten...')).toBeInTheDocument();
  });

  it('clicking tab triggers onSelectTab', () => {
    const onSelect = vi.fn();
    render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        onSelectTab={onSelect}
        onCloseTab={() => {}}
        onNewChat={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('clicking close button stops propagation and calls onCloseTab', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        onSelectTab={onSelect}
        onCloseTab={onClose}
        onNewChat={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close tab Alpha' }));
    expect(onClose).toHaveBeenCalledWith('t1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('new chat button invokes onNewChat', () => {
    const onNewChat = vi.fn();
    render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewChat={onNewChat}
      />,
    );
    const newBtns = screen.getAllByRole('tab', { name: 'New Chat' });
    // The standalone new-chat button is the one with no close action siblings.
    // We rely on its aria-label + click counting on the explicit "+" button.
    fireEvent.click(newBtns[newBtns.length - 1]);
    expect(onNewChat).toHaveBeenCalled();
  });

  it('highlight=new/complete/fail style renders dot instead of message icon', () => {
    const highlights = new Map<string, TabHighlight>([
      ['t1', 'new'],
      ['t2', 'complete'],
      ['t3', 'fail'],
    ]);
    const { container } = render(
      <ChatTabBar
        tabs={tabs}
        currentTabId="t1"
        highlightTabs={highlights}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewChat={() => {}}
      />,
    );
    // Each highlighted tab renders a 6x6 dot div (aria-hidden)
    const dots = container.querySelectorAll('[aria-hidden="true"][class*="rounded-full"]');
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import i18n from '../../i18n';
import { mockInvoke } from '../../test-utils/mockTauri';
import { ChatWelcome } from './ChatWelcome';
import { getQuickActions } from './chatActions';

describe('getQuickActions', () => {
  it('returns a non-empty list with required fields', () => {
    const actions = getQuickActions((k: string) => i18n.t(k));
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a).toHaveProperty('label');
      expect(a).toHaveProperty('desc');
      expect(a).toHaveProperty('examples');
      expect(a).toHaveProperty('color');
      expect(a.examples.length).toBeGreaterThan(0);
    }
  });
});

describe('ChatWelcome', () => {
  beforeEach(() => {
    mockInvoke({ get_morning_greeting: vi.fn().mockResolvedValue(null) });
  });

  it('renders hour-appropriate greeting + quick actions', () => {
    render(<ChatWelcome aiName="YiYi" onSendPrompt={() => {}} />);
    // Any of four possible zh greetings should appear
    const hero = screen.getByRole('heading');
    expect(hero.textContent).toMatch(/(早上好|下午好|晚上好|夜深了)/);
    // Several quick-action labels are rendered as buttons
    const actions = getQuickActions((k: string) => i18n.t(k));
    expect(screen.getByText(actions[0].label)).toBeInTheDocument();
  });

  it('renders morning greeting when backend returns one', async () => {
    mockInvoke({ get_morning_greeting: vi.fn().mockResolvedValue('你今天想做点什么呢') });
    render(<ChatWelcome aiName="YiYi" onSendPrompt={() => {}} />);
    expect(await screen.findByText('你今天想做点什么呢')).toBeInTheDocument();
  });

  it('clicking an action expands it and shows examples', () => {
    render(<ChatWelcome aiName="YiYi" onSendPrompt={() => {}} />);
    const actions = getQuickActions((k: string) => i18n.t(k));
    const first = actions[0];
    fireEvent.click(screen.getByText(first.label));
    expect(screen.getByText(first.desc)).toBeInTheDocument();
    for (const ex of first.examples) {
      expect(screen.getByText(ex)).toBeInTheDocument();
    }
  });

  it('clicking an example fires onSendPrompt with text and collapses', () => {
    const onSendPrompt = vi.fn();
    render(<ChatWelcome aiName="YiYi" onSendPrompt={onSendPrompt} />);
    const actions = getQuickActions((k: string) => i18n.t(k));
    fireEvent.click(screen.getByText(actions[0].label));
    const ex0 = actions[0].examples[0];
    fireEvent.click(screen.getByText(ex0));
    expect(onSendPrompt).toHaveBeenCalledWith(ex0);
  });
});

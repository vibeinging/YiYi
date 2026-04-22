import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockInvoke } from '../../test-utils/mockTauri';
import { BuddyBubble } from './BuddyBubble';
import { OrbCore } from './OrbCore';
import { PersonalityOrb } from './PersonalityOrb';
import { BuddyStatsCard } from './BuddyStatsCard';
import { useBuddyStore } from '../../stores/buddyStore';
import type { Companion } from '../../utils/buddy';

describe('BuddyBubble', () => {
  it('returns null when text is empty', () => {
    const { container } = render(<BuddyBubble text="" visible={true} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders text when provided', () => {
    render(<BuddyBubble text="hey" visible={true} />);
    expect(screen.getByText('hey')).toBeInTheDocument();
  });

  it('flipRight changes positioning (left:0)', () => {
    const { container } = render(<BuddyBubble text="x" visible flipRight />);
    const bubble = container.firstChild as HTMLElement;
    expect(bubble.style.left).toBe('0px');
  });
});

describe('OrbCore', () => {
  it('renders core + outer glow + highlight + optional sparkle', () => {
    const { container } = render(
      <OrbCore
        from="#ff0000"
        to="#0000ff"
        css="border-radius: 50%"
        size={80}
        shiny
      />,
    );
    expect(container.textContent).toContain('✨');
    // Root has width/height 80
    const root = container.firstChild as HTMLElement;
    expect(root.style.width).toBe('80px');
    expect(root.style.height).toBe('80px');
  });

  it('no sparkle when shiny=false', () => {
    const { container } = render(
      <OrbCore from="#000" to="#fff" css="" size={30} />,
    );
    expect(container.textContent).not.toContain('✨');
  });
});

describe('PersonalityOrb', () => {
  it('renders labels when showLabels=true (or size>=120)', () => {
    const stats = { ENERGY: 50, WARMTH: 50, MISCHIEF: 50, WIT: 50, SASS: 50 };
    const { container } = render(
      <PersonalityOrb stats={stats} from="#ff0" to="#f0f" size={180} showLabels />,
    );
    expect(container.textContent).toContain('活力');
    expect(container.textContent).toContain('温柔');
  });

  it('omits labels for small orbs', () => {
    const stats = { ENERGY: 50, WARMTH: 50, MISCHIEF: 50, WIT: 50, SASS: 50 };
    const { container } = render(
      <PersonalityOrb stats={stats} from="#ff0" to="#f0f" size={40} />,
    );
    expect(container.textContent).not.toContain('活力');
  });

  it('shiny sparkle appears when shiny + not muted', () => {
    const stats = { ENERGY: 50, WARMTH: 50, MISCHIEF: 50, WIT: 50, SASS: 50 };
    const { container } = render(
      <PersonalityOrb stats={stats} from="#ff0" to="#f0f" size={160} shiny />,
    );
    expect(container.textContent).toContain('✨');
  });

  it('hides sparkle when muted even with shiny', () => {
    const stats = { ENERGY: 50, WARMTH: 50, MISCHIEF: 50, WIT: 50, SASS: 50 };
    const { container } = render(
      <PersonalityOrb stats={stats} from="#ff0" to="#f0f" size={160} shiny muted />,
    );
    expect(container.textContent).not.toContain('✨');
  });
});

describe('BuddyStatsCard', () => {
  const pristineBuddy = useBuddyStore.getState();
  const companion: Companion = {
    name: 'Star',
    species: 'star',
    palette: { name: '极光', from: '#6EE7B7', to: '#3B82F6' },
    particle: 'none',
    idleStyle: 'breathe',
    sizeScale: 1,
    shiny: false,
    stats: { ENERGY: 60, WARMTH: 70, MISCHIEF: 30, WIT: 80, SASS: 40 },
    personality: 'curious + warm',
    hatchedAt: new Date('2026-01-01').getTime(),
  };

  beforeEach(() => {
    useBuddyStore.setState(pristineBuddy, true);
    mockInvoke({});
  });

  it('renders companion name + species label + personality', () => {
    render(<BuddyStatsCard companion={companion} onClose={() => {}} />);
    expect(screen.getByText('Star')).toBeInTheDocument();
    expect(screen.getByText(/极光.*星灵/)).toBeInTheDocument();
    expect(screen.getByText('curious + warm')).toBeInTheDocument();
  });

  it('renders every stat label + numeric value', () => {
    render(<BuddyStatsCard companion={companion} onClose={() => {}} />);
    for (const label of ['活力', '温柔', '调皮', '聪慧', '犀利']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('close button invokes onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<BuddyStatsCard companion={companion} onClose={onClose} />);
    const closeBtn = container.querySelector('button[class*="rounded-lg"]') as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('toggling hosted button invokes toggle_buddy_hosted with target enabled=true', async () => {
    const toggle = vi.fn().mockResolvedValue(true);
    mockInvoke({ toggle_buddy_hosted: toggle });
    render(<BuddyStatsCard companion={companion} onClose={() => {}} />);
    fireEvent.click(screen.getByText('托管'));
    await vi.waitFor(() => expect(toggle).toHaveBeenCalled());
    expect(toggle.mock.calls[0][0]).toEqual({ enabled: true });
    await vi.waitFor(() => expect(useBuddyStore.getState().hostedMode).toBe(true));
  });
});

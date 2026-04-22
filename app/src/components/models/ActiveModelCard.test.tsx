import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ActiveModelCard } from './ActiveModelCard';
import type { ProviderDisplay } from '../../api/models';

const providers = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'zhipu', name: '智谱' },
] as unknown as ProviderDisplay[];

describe('ActiveModelCard', () => {
  it('renders active model + provider display name', () => {
    render(
      <ActiveModelCard
        activeLlm={{ provider_id: 'openai', model: 'gpt-4o' }}
        providers={providers}
        expandedProvider={null}
        setExpandedProvider={() => {}}
      />,
    );
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
  });

  it('falls back to provider_id when provider not found in list', () => {
    render(
      <ActiveModelCard
        activeLlm={{ provider_id: 'unknown', model: 'x' }}
        providers={providers}
        expandedProvider={null}
        setExpandedProvider={() => {}}
      />,
    );
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('click toggles expandedProvider between id and null', () => {
    const setExpanded = vi.fn();
    render(
      <ActiveModelCard
        activeLlm={{ provider_id: 'openai', model: 'gpt-4o' }}
        providers={providers}
        expandedProvider={null}
        setExpandedProvider={setExpanded}
      />,
    );
    fireEvent.click(screen.getByText('gpt-4o'));
    expect(setExpanded).toHaveBeenCalledWith('openai');
  });

  it('click when already expanded collapses to null', () => {
    const setExpanded = vi.fn();
    render(
      <ActiveModelCard
        activeLlm={{ provider_id: 'openai', model: 'gpt-4o' }}
        providers={providers}
        expandedProvider="openai"
        setExpandedProvider={setExpanded}
      />,
    );
    fireEvent.click(screen.getByText('gpt-4o'));
    expect(setExpanded).toHaveBeenCalledWith(null);
  });
});

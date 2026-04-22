import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders title only when description & actions absent', () => {
    render(<PageHeader title="Settings" />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByText(/./, { selector: 'p' })).not.toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<PageHeader title="Settings" description="Manage your preferences" />);
    expect(screen.getByText('Manage your preferences')).toBeInTheDocument();
  });

  it('renders actions container when provided', () => {
    render(
      <PageHeader
        title="Settings"
        actions={<button>Save</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});

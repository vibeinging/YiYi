import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasRenderer } from './CanvasRenderer';
import { CanvasCard } from './CanvasCard';
import { CanvasStatus } from './CanvasStatus';
import { CanvasTable } from './CanvasTable';
import { CanvasActions } from './CanvasActions';
import { CanvasList } from './CanvasList';
import { CanvasForm } from './CanvasForm';

describe('CanvasCard', () => {
  it('renders title + description + footer + tags', () => {
    render(
      <CanvasCard
        data={{
          type: 'card',
          title: 'Hello',
          description: 'Some desc',
          footer: 'f',
          tags: ['red', 'blue'],
        }}
      />,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Some desc')).toBeInTheDocument();
    expect(screen.getByText('f')).toBeInTheDocument();
    expect(screen.getByText('red')).toBeInTheDocument();
    expect(screen.getByText('blue')).toBeInTheDocument();
  });

  it('renders image when provided', () => {
    const { container } = render(
      <CanvasCard data={{ type: 'card', title: 'x', image: '/pic.png' }} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/pic.png');
  });
});

describe('CanvasStatus', () => {
  it('renders step label + detail + correct aria alt text', () => {
    render(
      <CanvasStatus
        data={{
          type: 'status',
          steps: [
            { label: 'Init', status: 'done' },
            { label: 'Run', status: 'running', detail: 'step detail' },
            { label: 'Fail', status: 'error' },
            { label: 'Wait', status: 'pending' },
          ],
        }}
      />,
    );
    expect(screen.getByLabelText('Init: Completed')).toBeInTheDocument();
    expect(screen.getByLabelText('Run: In progress')).toBeInTheDocument();
    expect(screen.getByLabelText('Fail: Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Wait: Pending')).toBeInTheDocument();
    expect(screen.getByText('step detail')).toBeInTheDocument();
  });
});

describe('CanvasTable', () => {
  it('renders headers + rows with cell formatting', () => {
    render(
      <CanvasTable
        data={{
          type: 'table',
          headers: ['Name', 'Active', 'Meta'],
          rows: [
            ['Alice', true, null],
            ['Bob', false, { key: 'v' }],
          ],
        }}
      />,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('{"key":"v"}')).toBeInTheDocument();
  });
});

describe('CanvasActions', () => {
  it('fires onAction with canvas+component+action on click', () => {
    const onAction = vi.fn();
    render(
      <CanvasActions
        canvasId="cv1"
        onAction={onAction}
        data={{
          type: 'actions',
          id: 'act',
          buttons: [
            { label: 'Go', action: 'go' },
            { label: 'Del', action: 'del', variant: 'danger' },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onAction).toHaveBeenCalledWith('cv1', 'act', 'go', 'Go');
    fireEvent.click(screen.getByRole('button', { name: 'Del' }));
    expect(onAction).toHaveBeenCalledWith('cv1', 'act', 'del', 'Del');
  });

  it('does not throw when onAction is undefined', () => {
    render(
      <CanvasActions
        canvasId="x"
        data={{ type: 'actions', id: 'a', buttons: [{ label: 'Ok', action: 'ok' }] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ok' }));
  });
});

describe('CanvasList', () => {
  it('renders item title, subtitle, and badge', () => {
    render(
      <CanvasList
        data={{
          type: 'list',
          items: [
            { title: 'First', subtitle: 'sub', badge: 'NEW' },
            { title: 'Second', icon: '★' },
          ],
        }}
      />,
    );
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('sub')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('★')).toBeInTheDocument();
  });
});

describe('CanvasForm', () => {
  const baseData = {
    type: 'form' as const,
    id: 'f1',
    title: 'My Form',
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'age', label: 'Age', field_type: 'number' as const },
      { name: 'role', label: 'Role', field_type: 'select' as const, options: ['admin', 'user'] },
      { name: 'bio', label: 'Bio', field_type: 'textarea' as const },
      { name: 'sub', label: 'Subscribe', field_type: 'toggle' as const },
    ],
  };

  it('renders all field types with title', () => {
    render(<CanvasForm canvasId="cv" data={baseData} />);
    expect(screen.getAllByText('My Form').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Name *')).toBeInTheDocument();
    expect(screen.getByText('Age')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getByText('Subscribe')).toBeInTheDocument();
  });

  it('submit fires onAction with collected values and flips to Submitted', () => {
    const onAction = vi.fn();
    const { container } = render(<CanvasForm canvasId="cv" data={baseData} onAction={onAction} />);
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'My Form' }));
    expect(onAction).toHaveBeenCalledWith(
      'cv',
      'f1',
      'form_submitted',
      expect.objectContaining({ name: 'Alice' }),
    );
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });
});

describe('CanvasRenderer', () => {
  it('renders title + dispatches each component type', () => {
    render(
      <CanvasRenderer
        canvasId="cv"
        title="The Title"
        components={[
          { type: 'card', title: 'card-a' },
          { type: 'status', steps: [{ label: 'ok', status: 'done' }] },
          { type: 'table', headers: ['H'], rows: [['v']] },
          { type: 'actions', id: 'a', buttons: [{ label: 'Btn', action: 'go' }] },
          { type: 'list', items: [{ title: 'li-1' }] },
        ]}
      />,
    );
    expect(screen.getByText('The Title')).toBeInTheDocument();
    expect(screen.getByText('card-a')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('H')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Btn' })).toBeInTheDocument();
    expect(screen.getByText('li-1')).toBeInTheDocument();
  });

  it('unknown component type is silently ignored', () => {
    const { container } = render(
      <CanvasRenderer
        canvasId="cv"
        components={[{ type: 'unknown' } as any]}
      />,
    );
    expect(container.querySelector('[role="region"]')).toBeTruthy();
  });

  it('onAction threads through to button clicks', () => {
    const onAction = vi.fn();
    render(
      <CanvasRenderer
        canvasId="cv"
        onAction={onAction}
        components={[
          { type: 'actions', id: 'x', buttons: [{ label: 'Ok', action: 'ok' }] },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ok' }));
    expect(onAction).toHaveBeenCalledWith('cv', 'x', 'ok', 'Ok');
  });
});

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('connected state includes ping animation element', () => {
    const { container } = render(<StatusDot state="connected" />);
    expect(container.querySelector('.animate-ping')).toBeTruthy();
  });

  it('non-connected states do not pulse', () => {
    for (const state of ['connecting', 'reconnecting', 'error', 'disconnected'] as const) {
      const { container } = render(<StatusDot state={state} />);
      expect(container.querySelector('.animate-ping')).toBeFalsy();
    }
  });

  it('title uses label only when no message', () => {
    const { container } = render(<StatusDot state="connected" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute('title')).toBe('Connected');
  });

  it('title combines label and message', () => {
    const { container } = render(<StatusDot state="error" message="timeout" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute('title')).toBe('Error: timeout');
  });
});

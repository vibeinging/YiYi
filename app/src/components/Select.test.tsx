import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from './Select';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const OPTIONS = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry', disabled: true },
  { value: 'd', label: 'Date' },
];

describe('Select', () => {
  it('renders placeholder when no value', () => {
    render(
      <Select value="" onChange={() => {}} options={OPTIONS} placeholder="Pick one" />,
    );
    expect(screen.getByText('Pick one')).toBeInTheDocument();
  });

  it('renders selected option label', () => {
    render(<Select value="b" onChange={() => {}} options={OPTIONS} />);
    expect(screen.getByRole('button')).toHaveTextContent('Banana');
  });

  it('opens dropdown on trigger click and selects option', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('does not call onChange when clicking disabled option', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('option', { name: 'Cherry' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not open when disabled', () => {
    render(<Select value="a" onChange={() => {}} options={OPTIONS} disabled />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('arrow + enter keyboard selects next non-disabled option', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} />);
    const combobox = screen.getByRole('combobox');
    combobox.focus();
    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    // open — focused should be index 0 (value 'a'). Move down to 1 (Banana).
    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Escape closes the dropdown', () => {
    render(<Select value="a" onChange={() => {}} options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on outside mousedown', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <Select value="a" onChange={() => {}} options={OPTIONS} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

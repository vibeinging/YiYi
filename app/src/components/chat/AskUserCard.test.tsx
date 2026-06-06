import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { type PendingQuestionState } from '../../stores/chatStreamStore';
import { AskUserCard } from './AskUserCard';

function question(over: Partial<PendingQuestionState> = {}): PendingQuestionState {
  return {
    requestId: 'q-1',
    sessionId: 'sess-1',
    companionId: 0,
    askerName: '小冰',
    question: '这个 app 给谁用?',
    options: [],
    kind: 'text',
    status: 'pending',
    ...over,
  };
}

describe('AskUserCard', () => {
  it('renders asker name + question text as an in-stream bubble', () => {
    render(<AskUserCard question={question()} onAnswer={() => {}} />);
    expect(screen.getByText('小冰')).toBeInTheDocument();
    expect(screen.getByText('这个 app 给谁用?')).toBeInTheDocument();
  });

  it('shows a "reply below" hint for free-text questions (answer via main input)', () => {
    render(<AskUserCard question={question()} onAnswer={() => {}} />);
    expect(screen.getByText(/在下方输入框回复/)).toBeInTheDocument();
    // 自由文本问题不渲染选项按钮。
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders options as chips and calls onAnswer with the chosen option', () => {
    const onAnswer = vi.fn();
    const q = question({ options: ['React', 'Vue'], kind: 'choice' });
    render(<AskUserCard question={q} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Vue' }));
    expect(onAnswer).toHaveBeenCalledWith('Vue');
  });

  it('falls back to YiYi when askerName is empty', () => {
    render(<AskUserCard question={question({ askerName: '' })} onAnswer={() => {}} />);
    expect(screen.getByText('YiYi')).toBeInTheDocument();
  });
});

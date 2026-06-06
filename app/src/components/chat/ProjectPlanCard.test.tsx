import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockInvoke } from '../../test-utils/mockTauri';
import { useChatStreamStore, type ProjectPlanState } from '../../stores/chatStreamStore';
import { ProjectPlanCard } from './ProjectPlanCard';

const pristine = useChatStreamStore.getState();

function plan(over: Partial<ProjectPlanState> = {}): ProjectPlanState {
  return {
    requestId: 'pp-1',
    summary: '做个 todo app',
    tasks: [
      { role: 'backend_dev', objective: '写 API', depends_on: [] },
      { role: 'frontend_dev', objective: '写前端', depends_on: [0] },
    ],
    ...over,
  };
}

describe('ProjectPlanCard', () => {
  beforeEach(() => {
    useChatStreamStore.setState(pristine, true);
    useChatStreamStore.setState({ sessionId: 'sess-1', projectPlan: plan() });
    mockInvoke({});
  });

  it('renders summary + tasks with role names and objectives', () => {
    render(<ProjectPlanCard plan={plan()} />);
    expect(screen.getByText('做个 todo app')).toBeInTheDocument();
    expect(screen.getByText('后端')).toBeInTheDocument();
    expect(screen.getByText('写 API')).toBeInTheDocument();
    expect(screen.getByText('前端')).toBeInTheDocument();
    expect(screen.getByText('写前端')).toBeInTheDocument();
  });

  it('开工 invokes commit_project_plan with sessionId + the plan tasks', async () => {
    const commit = vi.fn().mockResolvedValue(1);
    mockInvoke({ commit_project_plan: commit });
    render(<ProjectPlanCard plan={plan()} />);

    fireEvent.click(screen.getByRole('button', { name: /开工/ }));
    await waitFor(() => expect(commit).toHaveBeenCalled());
    expect(commit.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-1' });
    expect(commit.mock.calls[0][0].plan.tasks).toHaveLength(2);
    expect(commit.mock.calls[0][0].plan.tasks[1].role).toBe('frontend_dev');
  });

  it('算了 clears the plan without dispatching', () => {
    const commit = vi.fn();
    mockInvoke({ commit_project_plan: commit });
    render(<ProjectPlanCard plan={plan()} />);

    fireEvent.click(screen.getByRole('button', { name: /算了/ }));
    expect(commit).not.toHaveBeenCalled();
    expect(useChatStreamStore.getState().projectPlan).toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { useChatEventBridge } from './useChatEventBridge';

const SID = 'session-active';
const pristine = useChatStreamStore.getState();

async function setup() {
  const bridge = mockEventBridge();
  useChatStreamStore.setState({ ...pristine, sessionId: SID }, true);
  renderHook(() => useChatEventBridge());
  await vi.waitFor(() => expect(bridge.channels()).toContain('chat://chunk'));
  return bridge;
}

describe('useChatEventBridge', () => {
  beforeEach(() => {
    useChatStreamStore.setState(pristine, true);
  });

  it('appendChunk on chat://chunk when session matches', async () => {
    const bridge = await setup();
    act(() => {
      bridge.dispatch('chat://chunk', { text: 'Hel', session_id: SID });
      bridge.dispatch('chat://chunk', { text: 'lo', session_id: SID });
    });
    expect(useChatStreamStore.getState().streamingContent).toBe('Hello');
  });

  it('ignores chunk for mismatched session_id', async () => {
    const bridge = await setup();
    act(() => {
      bridge.dispatch('chat://chunk', { text: 'hi', session_id: 'other' });
    });
    expect(useChatStreamStore.getState().streamingContent).toBe('');
  });

  it('chat://tool_status start/end routes to toolStart/toolEnd', async () => {
    const bridge = await setup();
    act(() => {
      bridge.dispatch('chat://tool_status', { type: 'start', name: 'read_file', preview: '/a', session_id: SID });
    });
    expect(useChatStreamStore.getState().activeTools).toHaveLength(1);
    const toolId = useChatStreamStore.getState().activeTools[0].id;
    act(() => {
      bridge.dispatch('chat://tool_status', { type: 'end', name: 'read_file', preview: 'done', session_id: SID });
    });
    expect(useChatStreamStore.getState().activeTools[0].status).toBe('done');
    expect(toolId).toBeGreaterThan(0);
  });

  it('chat://complete ends stream', async () => {
    const bridge = await setup();
    useChatStreamStore.setState({ loading: true });
    act(() => {
      bridge.dispatch('chat://complete', { text: '', session_id: SID });
    });
    expect(useChatStreamStore.getState().loading).toBe(false);
  });

  it('chat://error ends stream with error text', async () => {
    const bridge = await setup();
    useChatStreamStore.setState({ loading: true });
    act(() => {
      bridge.dispatch('chat://error', { text: 'boom', session_id: SID });
    });
    expect(useChatStreamStore.getState().loading).toBe(false);
  });

  it('chat://retry sets retry status (not session-scoped)', async () => {
    const bridge = await setup();
    act(() => {
      bridge.dispatch('chat://retry', {
        attempt: 2,
        max_retries: 5,
        delay_ms: 1000,
        error_category: { type: 'rate_limit' },
        provider: 'openai',
      });
    });
    const rs = useChatStreamStore.getState().retryStatus;
    expect(rs?.attempt).toBe(2);
    expect(rs?.error_type).toBe('rate_limit');
  });

  it('chat://retry-resolved clears retry status', async () => {
    const bridge = await setup();
    useChatStreamStore.setState({
      retryStatus: { attempt: 1, max_retries: 3, delay_ms: 100, error_type: 'transient', provider: 'x' },
    });
    act(() => {
      bridge.dispatch('chat://retry-resolved', {});
    });
    expect(useChatStreamStore.getState().retryStatus).toBeNull();
  });

  it('chat://spawn_start populates spawnAgents', async () => {
    const bridge = await setup();
    act(() => {
      bridge.dispatch('chat://spawn_start', {
        agents: [{ name: 'a', task: 't1' }, { name: 'b', task: 't2' }],
        session_id: SID,
      });
    });
    expect(useChatStreamStore.getState().spawnAgents).toHaveLength(2);
  });

  it('chat://auto_continue round_start updates longTask', async () => {
    const bridge = await setup();
    act(() => {
      bridge.dispatch('chat://auto_continue', {
        type: 'round_start',
        session_id: SID,
        round: 1,
        max_rounds: 10,
      });
    });
    const lt = useChatStreamStore.getState().longTask;
    expect(lt.currentRound).toBe(1);
    expect(lt.maxRounds).toBe(10);
  });
});

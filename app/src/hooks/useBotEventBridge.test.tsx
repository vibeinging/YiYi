import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { mockInvoke } from '../test-utils/mockTauri';
import { useBotEventBridge, useBotMessageStore } from './useBotEventBridge';

describe('useBotEventBridge', () => {
  let bridge: ReturnType<typeof mockEventBridge>;

  beforeEach(() => {
    bridge = mockEventBridge();
    useBotMessageStore.getState().clearMessages();
    mockInvoke({});
  });

  it('subscribes to bot://message, response, auto-start, auto-stop', async () => {
    renderHook(() => useBotEventBridge());
    await vi.waitFor(() => {
      expect(bridge.channels()).toEqual(
        expect.arrayContaining([
          'bot://message',
          'bot://response',
          'bot://auto-start',
          'bot://auto-stop',
        ]),
      );
    });
  });

  it('incoming message appends to store with direction=incoming', async () => {
    renderHook(() => useBotEventBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('bot://message'));
    act(() => {
      bridge.dispatch('bot://message', {
        bot_id: 'b1',
        platform: 'discord',
        conversation_id: 'c1',
        content: 'hello',
        timestamp: 1234,
        sender_name: 'Alice',
      });
    });
    const msgs = useBotMessageStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      direction: 'incoming',
      content: 'hello',
      senderName: 'Alice',
      botId: 'b1',
    });
  });

  it('outgoing response appends with direction=outgoing', async () => {
    renderHook(() => useBotEventBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('bot://response'));
    act(() => {
      bridge.dispatch('bot://response', {
        bot_id: 'b1',
        platform: 'discord',
        conversation_id: 'c1',
        content: 'reply',
      });
    });
    const msgs = useBotMessageStore.getState().messages;
    expect(msgs[0].direction).toBe('outgoing');
    expect(msgs[0].content).toBe('reply');
  });

  it('caps message history at 100 entries', async () => {
    renderHook(() => useBotEventBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('bot://message'));
    act(() => {
      for (let i = 0; i < 150; i++) {
        bridge.dispatch('bot://message', {
          bot_id: 'b1',
          platform: 'discord',
          conversation_id: 'c',
          content: `msg-${i}`,
          timestamp: i,
        });
      }
    });
    expect(useBotMessageStore.getState().messages).toHaveLength(100);
  });

  it('auto-start invokes start_one_bot command', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ bots_start_one: start });
    renderHook(() => useBotEventBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('bot://auto-start'));
    act(() => {
      bridge.dispatch('bot://auto-start', { bot_id: 'b1' });
    });
    await waitFor(() => expect(start).toHaveBeenCalledWith({ botId: 'b1' }));
  });

  it('auto-stop invokes stop_one_bot command', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ bots_stop_one: stop });
    renderHook(() => useBotEventBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('bot://auto-stop'));
    act(() => {
      bridge.dispatch('bot://auto-stop', { bot_id: 'b1' });
    });
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ botId: 'b1' }));
  });
});

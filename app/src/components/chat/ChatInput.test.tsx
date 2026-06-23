/**
 * ChatInput @mention KEYBOARD path — 端到端回归。
 *
 * 守的 bug(2026-06-13 review):在 work 会话里打字 `@工人` + 回车,键盘处理器原本用
 * builtin-only `agents` 列表、且把选中项 tag 成 name 而非 `companion:<id>` —— 后端收不到
 * companion id,@ 工人的消息静默落到牵头者。整个 @ 功能在「直接打字」这条常用路径下是坏的,
 * 而之前的 live 测试直接调 dispatch_work_followup(&[id]) 绕过了前端,从没暴露。
 *
 * 本测试用 MentionInput 的测试替身驱动**真实** handleKeyDown:开 picker → 回车 → 断言
 * insertMention 收到 `{ type:'agent', id:'companion:<id>', name }`。旧代码下 items 来自
 * builtin-only(本测试里为空)→ 回车选中 undefined → insertMention 根本不被调用,断言失败。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, screen, waitFor } from '@testing-library/react';
import '../../i18n';
import { mockInvoke } from '../../test-utils/mockTauri';
import type { Companion } from '../../api/companions';

// MentionInput 替身:暴露 insertMention(spy)+ 捕获 onMentionTrigger,渲染一个把 keydown
// 转给真实 handleKeyDown 的元素。hoisted 让 vi.mock 工厂能引用。
const h = vi.hoisted(() => ({
  insertMention: vi.fn(),
  trigger: { fn: null as null | ((q: string) => void) },
}));

vi.mock('../MentionInput', () => {
  const React = require('react');
  return {
    MentionInput: React.forwardRef((props: any, ref: any) => {
      h.trigger.fn = props.onMentionTrigger;
      React.useImperativeHandle(ref, () => ({
        focus: () => {},
        insertMention: h.insertMention,
        insertText: () => {},
        getPlainText: () => '',
        getMentions: () => [],
        clear: () => {},
        isEmpty: () => true,
        getElement: () => null,
      }));
      return React.createElement('textarea', { 'data-testid': 'mention-input', onKeyDown: props.onKeyDown });
    }),
  };
});

import { ChatInput } from './ChatInput';

function worker(): Companion {
  return {
    id: 42,
    name: '前端',
    agent_definition_name: 'frontend_dev',
    avatar_emoji: '💻',
    color_hex: '#10B981',
    role_label: '前端工程师',
    kind: 'worker',
  } as unknown as Companion;
}

function renderInput(groupMembers: Companion[]) {
  mockInvoke({ list_agents: () => [], list_companions: () => [] });
  return render(
    <ChatInput
      loading={false}
      groupMembers={groupMembers}
      workspaceFiles={[]}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onSelectCommand={vi.fn()}
      onSelectTask={vi.fn()}
      onFileSelect={vi.fn()}
      onFetchWorkspaceFiles={vi.fn()}
    />,
  );
}

describe('ChatInput @mention keyboard path', () => {
  beforeEach(() => {
    // jsdom 没有 scrollIntoView —— 真实 MentionPicker 渲染时会调,补桩。
    (window.HTMLElement.prototype as any).scrollIntoView = vi.fn();
    h.insertMention.mockClear();
    h.trigger.fn = null;
  });

  it('typing @worker + Enter inserts a companion:<id> tag (not a name tag)', async () => {
    renderInput([worker()]);
    // mount effects (listAgents/listCompanions → []) settle.
    await waitFor(() => expect(h.trigger.fn).toBeTruthy());

    // 打 `@`(空 query)开 picker —— 群成员(worker)排在候选首位。
    await act(async () => { h.trigger.fn!(''); });

    // 回车选中首项。
    fireEvent.keyDown(screen.getByTestId('mention-input'), { key: 'Enter' });

    expect(h.insertMention).toHaveBeenCalledWith({
      type: 'agent',
      id: 'companion:42',
      name: '前端',
    });
  });

  it('typing @前 + Enter resolves the worker by fuzzy query to companion:<id>', async () => {
    renderInput([worker()]);
    await waitFor(() => expect(h.trigger.fn).toBeTruthy());

    await act(async () => { h.trigger.fn!('前'); });
    fireEvent.keyDown(screen.getByTestId('mention-input'), { key: 'Enter' });

    expect(h.insertMention).toHaveBeenCalledWith({
      type: 'agent',
      id: 'companion:42',
      name: '前端',
    });
  });
});

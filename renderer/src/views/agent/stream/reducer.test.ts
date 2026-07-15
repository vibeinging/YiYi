import { describe, expect, it } from 'vitest'
import type { WorkstationDraft } from './types'
import { mapServerMessage, mergeWorkspaceEvent } from './streamAdapter'
import {
  applyWorkstationPatch,
  backfillWorkstationFromMessages,
  completeOpenPlanSteps,
  reduceContentItem,
  reduceStreamEvent
} from './reducer'

function draft(): WorkstationDraft {
  return {
    tools: new Map(),
    artifacts: new Map(),
    skills: new Map(),
    plan: []
  }
}

describe('agent stream reducer', () => {
  it('projects v1 answer, skill, tool, and workspace events into chat/workstation lanes', () => {
    const answer = reduceStreamEvent({
      v: 1,
      type: 'message.delta',
      visibility: 'primary',
      payload: { block_id: 'answer-1', channel: 'answer', format: 'markdown', content: 'hello' }
    })
    expect(answer.block).toMatchObject({ id: 'answer-1', type: 'markdown', content: 'hello' })

    const ws = draft()
    const skill = reduceStreamEvent({
      v: 1,
      type: 'skill.selected',
      visibility: 'secondary',
      payload: { name: 'smart_query', runtime: 'service', status: 'running', reason: 'data question' }
    })
    applyWorkstationPatch(skill.workstation, ws)
    expect(ws.skills.get('smart_query')).toMatchObject({ name: 'smart_query', runtime: 'service', status: 'running' })

    const tool = reduceStreamEvent({
      v: 1,
      type: 'tool.started',
      visibility: 'secondary',
      payload: { tool_call_id: 'tool-1', name: 'mcp_query', args_preview: '{"sql":"select 1"}' }
    })
    expect(tool.block).toMatchObject({ id: 'tool-1', type: 'tool', title: 'running' })
    applyWorkstationPatch(tool.workstation, ws)
    expect(ws.tools.get('tool-1')).toMatchObject({ name: 'mcp_query', where: 'cloud', status: 'running' })

    const workspace = reduceStreamEvent({
      v: 1,
      type: 'workspace.updated',
      visibility: 'hidden',
      payload: { event: 'project_ready_for_query', project_id: 'project-1' }
    })
    expect(workspace.workspaceEvent?.project_id).toBe('project-1')
  })

  it('keeps project_created session info when later import workspace events arrive', () => {
    const created = reduceStreamEvent({
      v: 1,
      type: 'workspace.updated',
      visibility: 'hidden',
      payload: {
        event: 'project_created',
        origin_project_id: '__chat__',
        session_id: 'chat-session-1',
        project_id: 'project-1',
        project: { name: '打车发票统计' }
      }
    }).workspaceEvent
    const preparing = reduceStreamEvent({
      v: 1,
      type: 'workspace.updated',
      visibility: 'hidden',
      payload: {
        event: 'project_data_preparing',
        origin_project_id: '__chat__',
        session_id: 'chat-session-1',
        project_id: 'project-1',
        data_source_id: 'ds-1'
      }
    }).workspaceEvent

    const merged = mergeWorkspaceEvent(created || null, preparing!)

    expect(merged.event).toBe('project_created')
    expect(merged.origin_project_id).toBe('__chat__')
    expect(merged.session_id).toBe('chat-session-1')
    expect(merged.data_source_id).toBe('ds-1')
    expect(merged.project_id).toBe('project-1')
  })

  it('keeps session_moved info when later workspace events arrive', () => {
    const moved = reduceStreamEvent({
      v: 1,
      type: 'workspace.updated',
      visibility: 'hidden',
      payload: {
        event: 'session_moved',
        origin_project_id: '__chat__',
        session_id: 'chat-session-1',
        project_id: 'project-1'
      }
    }).workspaceEvent
    const ready = reduceStreamEvent({
      v: 1,
      type: 'workspace.updated',
      visibility: 'hidden',
      payload: {
        event: 'project_ready_for_query',
        origin_project_id: 'project-1',
        session_id: 'chat-session-1',
        project_id: 'project-1',
        connection_id: 'conn-1'
      }
    }).workspaceEvent

    const merged = mergeWorkspaceEvent(moved || null, ready!)

    expect(merged.event).toBe('session_moved')
    expect(merged.origin_project_id).toBe('__chat__')
    expect(merged.session_id).toBe('chat-session-1')
    expect(merged.connection_id).toBe('conn-1')
  })

  it('keeps smart query tool progress visible in the chat stream', () => {
    const started = reduceStreamEvent({
      v: 1,
      type: 'tool.started',
      visibility: 'secondary',
      payload: {
        tool_call_id: 'sql-1',
        name: 'sql_scan_operator',
        args_preview: '{"question":"查询销售额最高的前10个客户"}'
      }
    })
    expect(started.block).toMatchObject({
      id: 'sql-1',
      type: 'tool',
      title: 'running',
      content: expect.stringContaining('查询数据库')
    })

    const completed = reduceStreamEvent({
      v: 1,
      type: 'tool.completed',
      visibility: 'secondary',
      payload: {
        tool_call_id: 'sql-1',
        name: 'sql_scan_operator',
        args_preview: '{"question":"查询销售额最高的前10个客户"}'
      }
    })
    expect(completed.block).toMatchObject({ id: 'sql-1', type: 'tool', title: 'done' })

    const output = reduceStreamEvent({
      v: 1,
      type: 'tool.output',
      visibility: 'secondary',
      payload: {
        tool_call_id: 'sql-1',
        name: 'sql_scan_operator',
        result_preview: '已查询并存入中间表 r_abcd'
      }
    })
    expect(output.block).toMatchObject({
      id: 'result:sql-1',
      type: 'tool_result',
      title: '查询数据库',
      content: '已查询并存入中间表 r_abcd'
    })
  })

  it('keeps local listing output visible and expanded as soon as it streams', () => {
    const started = reduceStreamEvent({
      v: 1,
      type: 'tool.started',
      visibility: 'secondary',
      payload: {
        tool_call_id: 'ls-1',
        name: 'ls',
        args_preview: '{"path":"/Users/Four/Desktop"}'
      }
    })
    expect(started.block).toMatchObject({
      id: 'ls-1',
      type: 'tool',
      title: 'running',
      content: expect.stringContaining('列出文件')
    })

    const output = reduceStreamEvent({
      v: 1,
      type: 'tool.output',
      visibility: 'secondary',
      payload: {
        tool_call_id: 'ls-1',
        name: 'ls',
        result_preview: 'report.xlsx\ninvoice.pdf'
      }
    })
    expect(output.block).toMatchObject({
      id: 'result:ls-1',
      type: 'tool_result',
      title: '列出文件',
      content: 'report.xlsx\ninvoice.pdf',
      metadata: {
        tool_call_id: 'ls-1',
        tool_name: 'ls',
        auto_expand: true
      }
    })
  })

  it('replays persisted hidden skill items into Workstation without adding chat blocks', () => {
    const patch = reduceContentItem({
      id: 'skill:smart_query',
      type: 'skill_invocation',
      content: JSON.stringify({ skill_name: 'smart_query', runtime: 'service', status: 'selected' }),
      metadata: { display: false }
    })

    expect(patch.block).toBeUndefined()
    expect(patch.workstation?.skill?.value).toMatchObject({ name: 'smart_query', runtime: 'service' })
  })

  it('replaces plan title and state from the latest plan.updated event', () => {
    const ws = draft()
    applyWorkstationPatch(
      reduceStreamEvent({
        v: 1,
        type: 'plan.updated',
        visibility: 'secondary',
        payload: {
          steps: [
            { title: '查找比赛信息', status: 'doing' },
            { title: '获取第二名成绩', status: 'todo' }
          ]
        }
      }).workstation,
      ws
    )

    expect(ws.plan).toEqual([
      { title: '查找比赛信息', detail: undefined, state: 'running' },
      { title: '获取第二名成绩', detail: undefined, state: 'todo' }
    ])

    applyWorkstationPatch(
      reduceStreamEvent({
        v: 1,
        type: 'plan.updated',
        visibility: 'secondary',
        payload: {
          steps: [
            { title: '确认 2008 年中奖赛排名', status: 'done' },
            { title: '获取第二名车手完赛时间', status: 'doing' }
          ]
        }
      }).workstation,
      ws
    )

    expect(ws.plan).toEqual([
      { title: '确认 2008 年中奖赛排名', detail: undefined, state: 'done' },
      { title: '获取第二名车手完赛时间', detail: undefined, state: 'running' }
    ])
  })

  it('marks open plan steps done when a run completes successfully', () => {
    expect(
      completeOpenPlanSteps([
        { title: '确认比赛 ID', state: 'done' },
        { title: '查询第二名完赛时间', state: 'running' },
        { title: '展示最终答案', state: 'todo' }
      ])
    ).toEqual([
      { title: '确认比赛 ID', state: 'done' },
      { title: '查询第二名完赛时间', state: 'done' },
      { title: '展示最终答案', state: 'done' }
    ])
  })

  it('backfills Workstation from hidden skill items after server message mapping', () => {
    const mapped = mapServerMessage({
      role: 'assistant',
      content_items: [
        {
          id: 'skill:data_onboarding',
          type: 'skill_invocation',
          content: JSON.stringify({ skill_name: 'data_onboarding', runtime: 'prompt', status: 'running' }),
          title: 'data_onboarding',
          metadata: { display: false, skill_name: 'data_onboarding' }
        },
        {
          id: 'answer-1',
          type: 'markdown',
          content: '已开始接入数据',
          display_type: 'text',
          metadata: { display: true }
        }
      ]
    })

    expect(mapped.blocks).toHaveLength(1)
    expect(mapped.blocks[0]).toMatchObject({ id: 'answer-1', type: 'markdown', display_type: 'text' })

    const draft = backfillWorkstationFromMessages([mapped])
    expect(draft.skills.get('data_onboarding')).toMatchObject({ name: 'data_onboarding', runtime: 'prompt', status: 'running' })
  })

  it('backfills Workstation from hidden final plan items without adding chat blocks', () => {
    const mapped = mapServerMessage({
      role: 'assistant',
      content_items: [
        {
          id: 'plan',
          type: 'plan',
          content: JSON.stringify([
            { title: '查询该客户的公司名称', status: 'done' },
            { title: '整合结果并回答问题', status: 'done' }
          ]),
          metadata: { display: false }
        },
        {
          id: 'answer-1',
          type: 'markdown',
          content: '答案已生成',
          display_type: 'text',
          metadata: { display: true }
        }
      ]
    })

    expect(mapped.blocks).toHaveLength(1)

    const draft = backfillWorkstationFromMessages([mapped])
    expect(draft.plan).toEqual([
      { title: '查询该客户的公司名称', detail: undefined, state: 'done' },
      { title: '整合结果并回答问题', detail: undefined, state: 'done' }
    ])
  })

  it('does not mark failed user input resolution as resolved', () => {
    const failed = reduceStreamEvent({
      v: 1,
      type: 'user_input.resolved',
      visibility: 'primary',
      payload: { request_id: 'ask-1', value: 'Alpha', status: 'failed' }
    })
    expect(failed.block).toMatchObject({
      id: 'user_input:ask-1',
      type: 'user_input',
      title: 'failed',
      metadata: { status: 'failed', response: 'Alpha' }
    })

    const answered = reduceStreamEvent({
      v: 1,
      type: 'user_input.resolved',
      visibility: 'primary',
      payload: { request_id: 'ask-1', value: 'Alpha', status: 'answered' }
    })
    expect(answered.block).toMatchObject({
      title: 'resolved',
      metadata: { status: 'resolved', response: 'Alpha' }
    })
  })

  it('updates approval cards without losing the original command text', () => {
    const requested = reduceStreamEvent({
      v: 1,
      type: 'approval.requested',
      visibility: 'action',
      payload: { approval_id: 'call-1', tool_call_id: 'call-1', name: 'bash', summary: 'bash {"cmd":"pwd"}' }
    })
    expect(requested.block).toMatchObject({ id: 'confirm:call-1', type: 'confirm', content: 'bash {"cmd":"pwd"}' })

    const resolved = reduceStreamEvent({
      v: 1,
      type: 'approval.resolved',
      visibility: 'hidden',
      payload: { approval_id: 'call-1', tool_call_id: 'call-1', approved: true, summary: 'bash {"cmd":"pwd"}' }
    })
    expect(resolved.block).toMatchObject({ id: 'confirm:call-1', title: 'approved', content: 'bash {"cmd":"pwd"}' })
  })

  it('projects user input action events into confirmation cards', () => {
    const requested = reduceStreamEvent({
      v: 1,
      type: 'user_input.requested',
      visibility: 'action',
      payload: {
        request_id: 'ask-1',
        run_id: 'run-1',
        resume_handle: { type: 'user_input_resume', run_id: 'run-1', session_id: 'session-1', request_id: 'ask-1' },
        prompt: '请选择客户',
        options: [{ label: '宏远科技' }]
      }
    })
    expect(requested.block).toMatchObject({ id: 'user_input:ask-1', type: 'user_input', title: 'requested' })
    expect(JSON.parse(requested.block?.content || '{}')).toMatchObject({
      request_id: 'ask-1',
      run_id: 'run-1',
      resume_handle: { type: 'user_input_resume', run_id: 'run-1', session_id: 'session-1', request_id: 'ask-1' },
      prompt: '请选择客户',
      options: [{ label: '宏远科技' }]
    })

    const resolved = reduceStreamEvent({
      v: 1,
      type: 'user_input.resolved',
      visibility: 'hidden',
      payload: { request_id: 'ask-1', value: '宏远科技' }
    })
    expect(resolved.block).toMatchObject({ id: 'user_input:ask-1', type: 'user_input', title: 'resolved', content: '' })
  })

  it('classifies image artifacts for Workstation rendering', () => {
    const patch = reduceStreamEvent({
      v: 1,
      type: 'artifact.created',
      visibility: 'secondary',
      payload: {
        artifact_id: 'file:/Users/Four/.yiw/projects/__chat__/red_solid.png',
        kind: 'image',
        name: 'red_solid.png',
        path: '/Users/Four/.yiw/projects/__chat__/red_solid.png',
        source_tool_call_id: 'tool-image'
      }
    })

    expect(patch.workstation?.artifact?.value).toMatchObject({ name: 'red_solid.png', kind: 'image' })
  })
})

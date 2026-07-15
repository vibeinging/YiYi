import { describe, expect, it } from 'vitest'
import { consumeAgentStream } from './consumeAgentStream'
import { isTerminalRunEvent } from './streamAdapter'

const sse = (event: any) => `data: ${JSON.stringify(event)}`

describe('consumeAgentStream', () => {
  it('settles the UI run when run.completed arrives, without waiting for the transport to close', async () => {
    const patches: any[] = []
    let flushed = 0
    const subscribe = (_req: any, onLine: (line: string) => void) => {
      onLine(sse({
        v: 1,
        type: 'message.delta',
        visibility: 'primary',
        payload: { block_id: 'answer-1', channel: 'answer', format: 'markdown', content: '你好' }
      }))
      onLine(sse({ v: 1, type: 'run.completed', payload: { status: 'completed' } }))
      return new Promise<void>(() => {})
    }

    await expect(
      consumeAgentStream(
        { url: '/stream' },
        {
          subscribe: subscribe as any,
          onPatch: (patch) => patches.push(patch),
          flushQueuedBlocks: () => {
            flushed += 1
          }
        }
      )
    ).resolves.toEqual({ runCompleted: true, runFailed: false })

    expect(flushed).toBe(1)
    expect(patches[0].block).toMatchObject({ id: 'answer-1', content: '你好' })
  })

  it('ignores late lines after a terminal run event', async () => {
    const patches: any[] = []
    const subscribe = (_req: any, onLine: (line: string) => void) => {
      onLine(sse({ v: 1, type: 'run.completed', payload: { status: 'completed' } }))
      onLine(sse({
        v: 1,
        type: 'message.delta',
        visibility: 'primary',
        payload: { block_id: 'late-answer', channel: 'answer', format: 'markdown', content: 'late' }
      }))
      return Promise.resolve()
    }

    await consumeAgentStream(
      { url: '/stream' },
      {
        subscribe: subscribe as any,
        onPatch: (patch) => patches.push(patch),
        flushQueuedBlocks: () => {}
      }
    )

    expect(patches.some((patch) => patch.block?.id === 'late-answer')).toBe(false)
  })

  it('rejects transport errors before any terminal event', async () => {
    const subscribe = () => Promise.reject(new Error('boom'))
    await expect(
      consumeAgentStream(
        { url: '/stream' },
        {
          subscribe: subscribe as any,
          onPatch: () => {},
          flushQueuedBlocks: () => {}
        }
      )
    ).rejects.toThrow('boom')
  })
})

describe('agent run terminal events', () => {
  it('treats suspended runs as terminal for the input busy state', () => {
    expect(isTerminalRunEvent({ v: 1, type: 'run.suspended', payload: { status: 'suspended' } })).toBe(true)
  })
})

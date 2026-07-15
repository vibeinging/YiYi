import { subscribeStream, type StreamReq } from '@/utils/api-stream'
import type { AgentStreamPatch } from './types'
import { reduceStreamEvent } from './reducer'
import { isCompletedRunEvent, isFailedRunEvent, isTerminalRunEvent, parseSseJsonLine } from './streamAdapter'

export interface AgentStreamResult {
  runCompleted: boolean
  runFailed: boolean
}

interface ConsumeAgentStreamOptions {
  onPatch: (patch: AgentStreamPatch) => void
  flushQueuedBlocks: () => void
  subscribe?: typeof subscribeStream
}

export function consumeAgentStream(req: StreamReq, options: ConsumeAgentStreamOptions): Promise<AgentStreamResult> {
  const subscribe = options.subscribe || subscribeStream
  let runCompleted = false
  let runFailed = false
  let terminalSeen = false
  let resolveResult: (result: AgentStreamResult) => void = () => {}
  let rejectResult: (error: unknown) => void = () => {}

  const finish = () => {
    if (terminalSeen) return
    terminalSeen = true
    options.flushQueuedBlocks()
    resolveResult({ runCompleted, runFailed })
  }

  const resultPromise = new Promise<AgentStreamResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let streamPromise: Promise<void>
  try {
    streamPromise = Promise.resolve(subscribe(req, (line) => {
      if (terminalSeen) return
      const evt = parseSseJsonLine(line)
      if (!evt) return
      if (isCompletedRunEvent(evt)) runCompleted = true
      if (isFailedRunEvent(evt)) runFailed = true
      options.onPatch(reduceStreamEvent(evt))
      if (isTerminalRunEvent(evt)) finish()
    }))
  } catch (error) {
    terminalSeen = true
    rejectResult(error)
    return resultPromise
  }

  streamPromise.then(
    () => finish(),
    (error) => {
      if (terminalSeen) return
      terminalSeen = true
      rejectResult(error)
    },
  )

  return resultPromise
}

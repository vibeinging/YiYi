import { useEffect, useState } from 'react'
import { getAgentSessionTraces, type AgentTraceRun, type AgentSessionTraceResponse } from '@/api/yiw'

export function useTraceOptimizationTraceRuns(projectId?: string, sessionId?: string | null) {
  const [traceRuns, setTraceRuns] = useState<AgentTraceRun[]>([])

  useEffect(() => {
    if (!projectId || !sessionId) {
      setTraceRuns([])
      return undefined
    }

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const load = async (attempt = 0) => {
      try {
        const res: any = await getAgentSessionTraces(projectId, sessionId, {
          limit: 20,
          resolveTrace: true
        })
        if (cancelled) return
        const payload: AgentSessionTraceResponse = res?.data || res || { enabled: false, items: [] }
        setTraceRuns(payload.enabled === false ? [] : payload.items || [])

        const shouldRetry = payload.traceResolveDeferred || payload.traceReadTimeout || payload.traceWarmupPending
        if (shouldRetry && attempt < 2) {
          retryTimer = setTimeout(() => void load(attempt + 1), 750 * (attempt + 1))
        }
      } catch {
        if (!cancelled) setTraceRuns([])
      }
    }

    void load()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [projectId, sessionId])

  return traceRuns
}

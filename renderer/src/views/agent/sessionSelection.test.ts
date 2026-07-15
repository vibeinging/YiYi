import { describe, expect, it } from 'vitest'
import { INITIAL_SESSION_ID, shouldSyncSessionSelection } from './sessionSelection'

describe('session selection', () => {
  it('loads a history session selected before the conversation view mounts', () => {
    expect(INITIAL_SESSION_ID).toBeNull()
    expect(shouldSyncSessionSelection('history-session', INITIAL_SESSION_ID, false)).toBe(true)
  })

  it('does not reload a session that the current view already owns', () => {
    expect(shouldSyncSessionSelection('current-session', 'current-session', false)).toBe(false)
  })

  it('reloads the same session id after switching workspaces', () => {
    expect(shouldSyncSessionSelection('same-id', 'same-id', true)).toBe(true)
  })
})

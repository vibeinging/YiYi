export const INITIAL_SESSION_ID: string | null = null

export function shouldSyncSessionSelection(
  selectedId: string | null,
  sessionId: string | null,
  projectChanged: boolean
) {
  return selectedId !== sessionId || projectChanged
}

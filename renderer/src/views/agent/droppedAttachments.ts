export interface DroppedAttachment {
  path: string
  name: string
  isDir?: boolean
}

interface DroppedFileApi {
  getPathForFile?: (file: File) => string
}

export function hasDroppedFiles(types: readonly string[] | DOMStringList) {
  return Array.from(types || []).includes('Files')
}

export function attachmentsFromDroppedFiles(files: FileList | readonly File[], api: DroppedFileApi | undefined) {
  return Array.from(files || []).flatMap((file): DroppedAttachment[] => {
    let path = ''
    try {
      path = String(api?.getPathForFile?.(file) || '').trim()
    } catch {
      return []
    }
    if (!path) return []
    return [{ path, name: file.name || path.split(/[\\/]/).filter(Boolean).pop() || path, isDir: false }]
  })
}

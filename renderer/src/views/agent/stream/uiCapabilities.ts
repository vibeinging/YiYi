import type { ArtifactKind } from '@/layout/workstation/Workstation'

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'] as const
export const CODE_EXTENSIONS = ['.py', '.js', '.ts', '.sql', '.sh', '.json'] as const
export const TABLE_EXTENSIONS = ['.csv', '.xls', '.xlsx', '.parquet'] as const

export const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

function hasKnownExtension(path: string, extensions: readonly string[]) {
  const clean = path.split(/[?#]/)[0]?.toLowerCase() || ''
  return extensions.some((ext) => clean.endsWith(ext))
}

export function artifactKindForPath(path: string): ArtifactKind {
  if (hasKnownExtension(path, CODE_EXTENSIONS)) return 'code'
  if (hasKnownExtension(path, TABLE_EXTENSIONS)) return 'table'
  if (hasKnownExtension(path, IMAGE_EXTENSIONS)) return 'image'
  return 'file'
}

function base64UrlEncode(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function imageSrcFromPath(raw: string) {
  const value = raw.trim()
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value
  const path = value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
  if (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) return `yiw-file://local/${base64UrlEncode(path)}`
  return value
}

export function isRenderableImageSrc(src: string) {
  return (
    src.startsWith('yiw-file://') ||
    /^https?:\/\//i.test(src) ||
    /^data:image\//i.test(src) ||
    hasKnownExtension(src, IMAGE_EXTENSIONS)
  )
}

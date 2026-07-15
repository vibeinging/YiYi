const UTF8_FILENAME_PATTERN = /filename\*\s*=\s*UTF-8''([^;]+)/i
const FILENAME_PATTERN = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i

export const getDownloadFilename = (response: any, fallback = 'document') => {
  const disposition = response?.headers?.['content-disposition'] || response?.headers?.['Content-Disposition']

  if (typeof disposition === 'string' && disposition) {
    const utf8Match = disposition.match(UTF8_FILENAME_PATTERN)
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]).trim() || fallback
      } catch {
        return utf8Match[1].trim() || fallback
      }
    }

    const filenameMatch = disposition.match(FILENAME_PATTERN)
    const rawFilename = filenameMatch?.[1] || filenameMatch?.[2]
    if (rawFilename) {
      return rawFilename.trim() || fallback
    }
  }

  return fallback
}

const MISSING_FILE_PATTERNS = [
  '文档文件不存在',
  '原始文件已不存在',
  'file does not exist',
  'file not found',
  'document file does not exist'
]

const parseBlobMessage = async (blob: any) => {
  if (!(blob instanceof Blob)) return ''

  try {
    const text = (await blob.text())?.trim()
    if (!text) return ''

    try {
      const parsed = JSON.parse(text)
      return parsed?.message || parsed?.msg || text
    } catch {
      return text
    }
  } catch {
    return ''
  }
}

export const extractDownloadErrorMessage = async (error: any) => {
  const responseData = error?.response?.data

  if (responseData instanceof Blob) {
    return parseBlobMessage(responseData)
  }

  if (typeof responseData === 'string') {
    return responseData
  }

  return responseData?.message || responseData?.msg || error?.message || ''
}

export const resolveDownloadErrorMessage = async (error: any, fallbackMessage: any, missingFileMessage: any) => {
  const status = error?.response?.status
  const serverMessage = await extractDownloadErrorMessage(error)
  const normalizedMessage = (serverMessage || '').toLowerCase()

  const isMissingFile =
    status === 404 &&
    (!serverMessage ||
      MISSING_FILE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern.toLowerCase())))

  if (isMissingFile) {
    return missingFileMessage || serverMessage || fallbackMessage
  }

  return serverMessage || fallbackMessage
}

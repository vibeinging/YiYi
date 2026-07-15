import { describe, expect, it, vi } from 'vitest'
import { attachmentsFromDroppedFiles, hasDroppedFiles } from './droppedAttachments'

describe('dropped attachments', () => {
  it('recognizes an OS file drag', () => {
    expect(hasDroppedFiles(['text/plain', 'Files'])).toBe(true)
    expect(hasDroppedFiles(['text/plain'])).toBe(false)
  })

  it('turns dragged files and folders into local attachments', () => {
    const files = [{ name: 'report.csv' }, { name: '资料' }] as File[]
    const getPathForFile = vi
      .fn()
      .mockReturnValueOnce('/tmp/report.csv')
      .mockReturnValueOnce('/tmp/资料')

    expect(attachmentsFromDroppedFiles(files, { getPathForFile })).toEqual([
      { path: '/tmp/report.csv', name: 'report.csv', isDir: false },
      { path: '/tmp/资料', name: '资料', isDir: false }
    ])
  })

  it('ignores browser files that have no safe local path', () => {
    const files = [{ name: 'unknown.txt' }] as File[]
    expect(attachmentsFromDroppedFiles(files, undefined)).toEqual([])
  })
})

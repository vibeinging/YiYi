// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import marked, { sanitizeMarkdownHtml } from './markdownConfig'

describe('shared Markdown sanitizer', () => {
  it('removes executable HTML, event handlers, and script URLs', () => {
    const html = marked.parse([
      '<img src="x" onerror="window.electronAPI.apiRequest({ url: `/api/models` })">',
      '<script>window.electronAPI.saveNetworkSettings({})</script>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '[danger](javascript:alert(1))',
    ].join('\n\n')) as string

    expect(html).not.toMatch(/<script|<iframe|onerror\s*=|javascript:/i)
    expect(html).not.toContain('saveNetworkSettings')
  })

  it('keeps safe Markdown and the local read-only image protocol', () => {
    const html = marked.parse('**安全文本**\n\n![图](yiw-file://workspace/chart.png)') as string

    expect(html).toContain('<strong>安全文本</strong>')
    expect(html).toContain('yiw-file://workspace/chart.png')
  })

  it('sanitizes fallback HTML through the same boundary', () => {
    expect(sanitizeMarkdownHtml('<div onclick="alert(1)">ok</div>')).toBe('<div>ok</div>')
  })
})

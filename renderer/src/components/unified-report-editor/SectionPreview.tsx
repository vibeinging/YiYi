import { useMemo } from 'react'
import { Badge } from '@mantine/core'
import styles from './SectionPreview.module.scss'

interface SectionPreviewProps {
  section?: any
  payload?: any
}

// {{a.b.c}} 形式的精确绑定解析:命中 payload 路径则取真实值,否则原样返回
const resolveBindingWith = (value: any, payload: any) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  const exact = trimmed.match(/^\{\{([\w.]+)\}\}$/)
  if (!exact) return value
  const parts = exact[1].split('.')
  let current: any = payload
  for (const part of parts) {
    if (current && typeof current === 'object') current = current[part]
    else return value
  }
  return current == null ? value : current
}

const isUnresolvedBinding = (value: any) =>
  typeof value === 'string' && /^\{\{[\w.]+\}\}$/.test(value.trim())

export default function SectionPreview({ section = null, payload = {} }: SectionPreviewProps) {
  // computed → useMemo;原 resolveBinding/resolvedText 闭包依赖 props.payload
  const resolveBinding = useMemo(
    () => (value: any) => resolveBindingWith(value, payload),
    [payload],
  )

  const resolvedText = useMemo(
    () => (value: any) => {
      const resolved = resolveBindingWith(value, payload)
      if (Array.isArray(resolved) || typeof resolved === 'object') return JSON.stringify(resolved)
      return resolved ?? ''
    },
    [payload],
  )

  const isVisible = useMemo(() => {
    const visibleWhen = section?.visible_when
    if (visibleWhen == null || visibleWhen === '') return true
    const resolved = resolveBinding(visibleWhen)
    if (resolved == null) return false
    if (resolved === false) return false
    if (Array.isArray(resolved)) return resolved.length > 0
    if (typeof resolved === 'object') return Object.keys(resolved).length > 0
    if (typeof resolved === 'number') return resolved !== 0
    if (typeof resolved === 'string') {
      const normalized = resolved.trim().toLowerCase()
      if (!normalized) return false
      if (['0', 'false', 'null', 'none', 'no', 'off', '[]', '{}'].includes(normalized)) return false
      if (/\{\{.*?\}\}/.test(resolved)) return false
    }
    return true
  }, [section, resolveBinding])

  const previewNotice = useMemo<{ type: string; text: string } | null>(() => {
    if (!section) return null
    if (!isVisible) {
      return { type: 'muted', text: '当前 section 被 visible_when 条件隐藏。' }
    }

    if (section.type === 'metric_cards') {
      if (Array.isArray(resolveBinding(section.props?.items)) && resolveBinding(section.props?.items).length) {
        return { type: 'success', text: '当前预览使用 payload.metrics 的真实数据。' }
      }
      if (Array.isArray(section.props?.preview_items) && section.props.preview_items.length) {
        return { type: 'warning', text: '当前没有命中 payload 绑定，已回退到示例指标数据。' }
      }
      if (isUnresolvedBinding(section.props?.items)) {
        return { type: 'warning', text: '当前没有命中 payload 绑定，且也没有配置示例指标数据。' }
      }
    }

    if (section.type === 'data_table') {
      const columnsBound = resolveBinding(section.props?.columns)
      const rowsBound = resolveBinding(section.props?.rows)
      if (Array.isArray(columnsBound) && columnsBound.length && Array.isArray(rowsBound) && rowsBound.length) {
        return { type: 'success', text: '当前预览使用 payload.tables 中的真实表格数据。' }
      }
      if ((section.props?.preview_columns || []).length || (section.props?.preview_rows || []).length) {
        return { type: 'warning', text: '当前表格绑定未命中完整数据，已回退到示例列或示例行。' }
      }
      return { type: 'warning', text: '当前表格绑定未命中数据。请检查 payload 或补充示例数据。' }
    }

    if (section.type === 'chart') {
      const bound = resolveBinding(section.props?.data)
      if (bound && typeof bound === 'object' && (Array.isArray(bound.x) || Array.isArray(bound.series))) {
        return { type: 'success', text: '当前预览使用 payload.charts 中的真实图表数据。' }
      }
      if (section.props?.preview_chart?.series?.length || section.props?.preview_chart?.x?.length) {
        return { type: 'warning', text: '当前图表绑定未命中数据，已回退到示例图表数据。' }
      }
      return { type: 'warning', text: '当前图表绑定未命中数据。请检查 payload 或补充示例图表。' }
    }

    if (section.type === 'insight_list' || section.type === 'recommendations') {
      const items = resolveBinding(section.props?.items)
      if (Array.isArray(items) && items.length) {
        return { type: 'success', text: '当前预览使用 payload 中的真实列表数据。' }
      }
      if ((section.props?.preview_items || []).length) {
        return { type: 'warning', text: '当前列表绑定未命中数据，已回退到示例条目。' }
      }
      return { type: 'warning', text: '当前列表绑定未命中数据。请检查 payload 或补充示例条目。' }
    }

    if (section.type === 'heading' || section.type === 'hero_summary' || section.type === 'markdown' || section.type === 'html') {
      const bindingFields = [section.props?.text, section.props?.title, section.props?.content].filter(Boolean)
      if (bindingFields.some((field) => isUnresolvedBinding(field) && resolveBinding(field) === field)) {
        return { type: 'warning', text: '当前部分文本绑定未命中 payload，将按原始模板内容显示。' }
      }
    }

    return null
  }, [section, isVisible, resolveBinding])

  const headingLevel = useMemo(() => {
    const level = Number(section?.props?.level || 1)
    return Math.max(1, Math.min(6, level))
  }, [section])

  const metricItems = useMemo(() => {
    const bound = resolveBinding(section?.props?.items)
    if (Array.isArray(bound) && bound.length) return bound
    return section?.props?.preview_items || []
  }, [section, resolveBinding])

  const tableColumns = useMemo(() => {
    const bound = resolveBinding(section?.props?.columns)
    if (Array.isArray(bound) && bound.length) return bound
    return section?.props?.preview_columns || []
  }, [section, resolveBinding])

  const tableRows = useMemo(() => {
    const bound = resolveBinding(section?.props?.rows)
    if (Array.isArray(bound) && bound.length) return bound
    return section?.props?.preview_rows || []
  }, [section, resolveBinding])

  const chartPreview = useMemo<{ x: any[]; series: any[] }>(() => {
    const bound = resolveBinding(section?.props?.data)
    if (bound && typeof bound === 'object' && (Array.isArray(bound.x) || Array.isArray(bound.series))) {
      return {
        x: bound.x || [],
        series: bound.series || [],
      }
    }
    return section?.props?.preview_chart || { x: [], series: [] }
  }, [section, resolveBinding])

  const listItems = useMemo(() => {
    const bound = resolveBinding(section?.props?.items)
    if (Array.isArray(bound) && bound.length) return bound
    return section?.props?.preview_items || []
  }, [section, resolveBinding])

  // v-else:无 section 时显示空态
  if (!section) {
    return <div className={styles['empty-preview']}>选择 section 后显示局部预览</div>
  }

  // <component :is="`h${headingLevel}`"> → 动态标题标签
  const HeadingTag = `h${headingLevel}` as any
  const chartType = section.props?.chart_type || 'line'

  return (
    <div className={styles['section-preview']}>
      <div className={styles['preview-header']}>
        <span className={styles['preview-title']}>Section 预览</span>
        <Badge size="sm" variant="light" color="gray">{section.type}</Badge>
      </div>

      {previewNotice && (
        <div className={`${styles['preview-notice']} ${styles[previewNotice.type] || ''}`}>
          {previewNotice.text}
        </div>
      )}

      {isVisible ? (
        <div className={styles['preview-body']}>
          {section.type === 'heading' && (
            <HeadingTag className={styles['heading-preview']}>{resolvedText(section.props?.text)}</HeadingTag>
          )}

          {section.type === 'hero_summary' && (
            <div className={styles['hero-preview']}>
              <div className={styles['hero-title']}>{resolvedText(section.props?.title)}</div>
              <div className={styles['hero-content']}>{resolvedText(section.props?.content)}</div>
            </div>
          )}

          {section.type === 'markdown' && (
            <div className={styles['markdown-preview']}>{resolvedText(section.props?.content)}</div>
          )}

          {section.type === 'html' && (
            <div
              className={styles['html-preview']}
              dangerouslySetInnerHTML={{ __html: resolvedText(section.props?.content) }}
            />
          )}

          {section.type === 'metric_cards' && (
            <>
              <div className={styles['section-block-title']}>{resolvedText(section.props?.title)}</div>
              <div className={styles['metric-grid']}>
                {metricItems.map((item: any, idx: number) => (
                  <div key={idx} className={styles['metric-card']}>
                    <div className={styles['metric-label']}>{item.label}</div>
                    <div className={styles['metric-value']}>{item.value}</div>
                    <div className={styles['metric-trend']}>{item.trend}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {section.type === 'data_table' && (
            <>
              <div className={styles['section-block-title']}>{resolvedText(section.props?.title)}</div>
              <div className={styles['table-wrap']}>
                <table className={styles['preview-table']}>
                  <thead>
                    <tr>
                      {tableColumns.map((col: any) => (
                        <th key={col.key}>{col.title}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row: any, idx: number) => (
                      <tr key={idx}>
                        {tableColumns.map((col: any) => (
                          <td key={col.key}>{row[col.key] ?? '-'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {section.type === 'chart' && (
            <>
              <div className={styles['section-block-title']}>{resolvedText(section.props?.title)}</div>
              <div className={styles['chart-summary']}>
                <div>类型：{section.props?.chart_type || 'line'}</div>
                {chartType === 'pie' ? (
                  <>
                    <div>分类：{chartPreview.x.join(' / ') || '-'}</div>
                    <div>数值项：{chartPreview.series?.[0]?.name || '-'}</div>
                    <div>分类数：{chartPreview.x.length || 0}</div>
                  </>
                ) : (
                  <>
                    <div>X 轴：{chartPreview.x.join(' / ') || '-'}</div>
                    <div>系列：{chartPreview.series.map((item: any) => item.name).filter(Boolean).join(', ') || '-'}</div>
                    <div>数据点数：{chartPreview.series?.[0]?.data?.length || 0}</div>
                  </>
                )}
              </div>
            </>
          )}

          {(section.type === 'insight_list' || section.type === 'recommendations') && (
            <>
              <div className={styles['section-block-title']}>{resolvedText(section.props?.title)}</div>
              <ul className={styles['preview-list']}>
                {listItems.map((item: any, idx: number) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </>
          )}

          {section.type === 'divider' && <hr className={styles['divider-preview']} />}
        </div>
      ) : (
        <div className={styles['hidden-preview']}>
          当前 section 被 `visible_when` 条件隐藏。调整 payload 或条件表达式后会重新显示。
        </div>
      )}
    </div>
  )
}

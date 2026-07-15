import { useMemo, useState, useEffect } from 'react'
import { ActionIcon, Box, LoadingOverlay, Menu, Pagination, Table, Tooltip } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import marked, { sanitizeMarkdownHtml } from '@/utils/markdownConfig'
import ReactECharts from 'echarts-for-react'
import ElSvgIcon from '@/components/ElSvgIcon'
import { isChartDisplayType, buildChartOption } from '@/utils/chartRegistry'
import styles from './PanelCard.module.scss'

const renderMarkdown = (content: string) => {
  if (!content) return ''
  try {
    return marked.parse(content) as string
  } catch (error) {
    console.error('Markdown 渲染失败:', error)
    return sanitizeMarkdownHtml(content.replace(/\n/g, '<br>'))
  }
}

export interface PanelCardProps {
  panel?: any
  isEditing?: boolean
  loading?: boolean
  // 内容区高度（用于计算表格高度）
  contentHeight?: number
  // 是否显示头部
  showHeader?: boolean
  // defineEmits(['action'])
  onAction?: (payload: { action: string; id: any }) => void
}

const pageSize = 10

export default function PanelCard({
  panel = null,
  isEditing = false,
  loading = false,
  contentHeight = 250,
  showHeader = true,
  onAction,
}: PanelCardProps) {
  const { t } = useTranslation()

  const enableRefreshPanel = !!panel?.execute

  // 控制图表延迟渲染
  const [chartReady, setChartReady] = useState(false)

  useEffect(() => {
    // 延迟渲染图表，确保 DOM 已经有尺寸
    const timer = setTimeout(() => {
      setChartReady(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // 分页
  const [currentPage, setCurrentPage] = useState(1)

  // 提取表格数据
  const tableData = useMemo<any[]>(() => {
    if (!panel?.content || panel?.content_type !== 'json') {
      return []
    }

    try {
      let parsed = panel.content
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed)
      }

      // 从 data 字段提取
      if (parsed.data && Array.isArray(parsed.data)) {
        return parsed.data
      }
      // 数组格式
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch (e) {
      console.error('解析JSON内容失败:', e)
    }

    return []
  }, [panel])

  // 提取表格字段
  const tableFields = useMemo<any[]>(() => {
    // 优先使用 display_config 中的字段
    if (panel?.display_config?.fields) {
      return panel.display_config.fields
    }

    // 从 content 中提取字段
    if (panel?.content && panel?.content_type === 'json') {
      try {
        let parsed = panel.content
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed)
        }

        // 从 fields 字段提取
        if (parsed.fields && Array.isArray(parsed.fields)) {
          return parsed.fields
        }

        // 从 data 第一行提取
        const data = parsed.data || (Array.isArray(parsed) ? parsed : null)
        if (data && data.length > 0) {
          return Object.keys(data[0]).map((key) => ({
            expression: key,
            alias: key,
          }))
        }
      } catch (e) {
        console.error('解析JSON内容失败:', e)
      }
    }

    return []
  }, [panel])

  const paginatedData = useMemo<any[]>(() => {
    const data = tableData
    if (!data || data.length === 0) return []
    const start = (currentPage - 1) * pageSize
    return data.slice(start, start + pageSize)
  }, [tableData, currentPage])

  // 提取面板内容
  const panelContent = useMemo<string>(() => {
    if (!panel?.content) return ''

    // 如果是JSON类型但显示为文本，格式化输出
    if (panel.content_type === 'json' && panel.display_type === 'text') {
      try {
        let parsed = panel.content
        // content 可能已经是对象，也可能是字符串
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed)
        }
        return JSON.stringify(parsed, null, 2)
      } catch (e) {
        return panel.content
      }
    }

    return panel.content
  }, [panel])

  // 判断是否为Markdown内容
  const isMarkdownContent = panel?.content_type === 'markdown'

  // 图表配置 - 委托给 chartRegistry
  const chartOptionData = useMemo<any>(() => {
    const displayType = panel?.display_type
    if (!isChartDisplayType(displayType)) return null

    const displayConfig = panel?.display_config || {}
    const xAxisField = displayConfig.x_axis_field
    const yAxisFields = displayConfig.y_axis_fields || []

    if (panel?.content && panel?.content_type === 'json') {
      try {
        let parsed = panel.content
        if (typeof parsed === 'string') parsed = JSON.parse(parsed)

        if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
          let effectiveX = xAxisField || parsed.x_axis_field
          let effectiveY = yAxisFields.length > 0 ? yAxisFields : parsed.y_axis_fields || []
          const groupField = displayConfig.group_field || parsed.group_field || null
          if (!effectiveY.length) {
            const row = parsed.data[0]
            effectiveY = Object.keys(row).filter((k) => k !== effectiveX && typeof row[k] === 'number')
          }

          let chartInput: any = {
            data: parsed.data,
            x_axis_field: effectiveX,
            y_axis_fields: effectiveY,
            group_field: groupField,
          }

          // 无有效 x 轴：自动 pivot
          const needsPivot = !effectiveX || !parsed.data[0]?.[effectiveX]
          if (needsPivot && effectiveY.length > 0) {
            const pivoted: any[] = []
            for (const row of parsed.data) {
              for (const yf of effectiveY) {
                if (row[yf] != null) pivoted.push({ _category: yf, _value: row[yf] })
              }
            }
            if (pivoted.length > 0) {
              chartInput = {
                data: pivoted,
                x_axis_field: '_category',
                y_axis_fields: ['_value'],
                group_field: null,
              }
            }
          }

          if (chartInput.x_axis_field && chartInput.y_axis_fields.length > 0) {
            return buildChartOption(displayType, chartInput, panel?.id)
          }
        }
      } catch (e) {
        console.error('解析图表配置失败:', e)
      }
    }

    return null
  }, [panel])

  // 处理操作
  const handleAction = (command: string) => {
    onAction?.({ action: command, id: panel?.id })
  }

  const renderContent = () => {
    // 表格类型
    if (panel?.display_type === 'table') {
      return (
        <div className={styles.tableContent}>
          <div className={styles.tableScroll} style={{ maxHeight: contentHeight }}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  {tableFields.map((field: any) => (
                    <Table.Th
                      key={field.expression}
                      style={{ minWidth: field.width || 100 }}
                    >
                      {field.alias}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedData.map((row: any, ri: number) => (
                  <Table.Tr key={ri}>
                    {tableFields.map((field: any) => (
                      <Table.Td key={field.expression}>
                        <Tooltip
                          label={String(row[field.expression] ?? '')}
                          multiline
                          withinPortal
                          openDelay={300}
                        >
                          <span
                            style={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {String(row[field.expression] ?? '')}
                          </span>
                        </Tooltip>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          {tableData && tableData.length > pageSize && (
            <div className={styles.tablePagination}>
              <Pagination
                value={currentPage}
                onChange={setCurrentPage}
                total={Math.ceil(tableData.length / pageSize)}
                size="sm"
              />
            </div>
          )}
        </div>
      )
    }

    // 图表类型
    if (isChartDisplayType(panel?.display_type)) {
      return (
        <div className={styles.chartContent}>
          {chartReady && chartOptionData && (
            <ReactECharts
              option={chartOptionData}
              notMerge
              lazyUpdate
              style={{ width: '100%', height: '100%' }}
              opts={{ renderer: 'canvas' }}
            />
          )}
        </div>
      )
    }

    // 文本类型
    if (panel?.display_type === 'text') {
      return (
        <div className={styles.textContent}>
          {/* Markdown 渲染 */}
          {isMarkdownContent ? (
            <div
              className={styles.markdownContent}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(panelContent) }}
            />
          ) : (
            // 普通文本
            <div className={styles.plainTextContent}>{panelContent}</div>
          )}
        </div>
      )
    }

    // HTML类型
    if (panel?.display_type === 'html') {
      return (
        <div
          className={styles.htmlContent}
          dangerouslySetInnerHTML={{ __html: panelContent }}
        />
      )
    }

    // 无数据
    return (
      <div className={styles.noData}>
        <ElSvgIcon name="Warning" size={32} color="#c0c4cc" />
        <p>{t('dashboardMgmt.noData')}</p>
      </div>
    )
  }

  return (
    <div className={styles.panelCard}>
      {/* 面板头部 */}
      {showHeader && (
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            {isEditing && (
              <span className={styles.dragHandle}>
                <ElSvgIcon name="Rank" size={16} />
              </span>
            )}
            <span className={styles.titleText}>
              {panel?.title || t('dashboardMgmt.unnamedPanel')}
            </span>
          </div>
          <div className={styles.panelActions}>
            <Menu trigger="click" position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm">
                  <ElSvgIcon name="MoreFilled" size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  disabled={!enableRefreshPanel}
                  leftSection={<ElSvgIcon name="Refresh" size={14} />}
                  onClick={() => handleAction('refresh')}
                >
                  {t('dashboardMgmt.refresh')}
                </Menu.Item>
                <Menu.Item
                  leftSection={<ElSvgIcon name="Edit" size={14} />}
                  onClick={() => handleAction('edit')}
                >
                  {t('common.edit')}
                </Menu.Item>
                <Menu.Item
                  leftSection={<ElSvgIcon name="Download" size={14} />}
                  onClick={() => handleAction('export')}
                >
                  {t('dashboardMgmt.exportData')}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  leftSection={<ElSvgIcon name="Delete" size={14} />}
                  onClick={() => handleAction('delete')}
                >
                  {t('common.delete')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        </div>
      )}

      {/* 面板内容 */}
      <Box className={styles.panelContent} pos="relative">
        <LoadingOverlay visible={loading} zIndex={5} />
        {renderContent()}
      </Box>
    </div>
  )
}

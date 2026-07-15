import { useEffect, useMemo, useRef, useState } from 'react'
import { Accordion, Checkbox, Group, Select, Stack, TextInput } from '@mantine/core'
import styles from './ChartSectionProperty.module.scss'

// 对应 defineProps({ section })
interface ChartSectionPropertyProps {
  section: any
  // 对应 defineEmits(['update'])
  onUpdate?: () => void
}

// 把逗号分隔字符串转成 trim 后的非空列表
const toStringList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean)

export default function ChartSectionProperty({ section, onUpdate }: ChartSectionPropertyProps) {
  // computed(() => props.section) —— 直接复用传入的 section 引用，原地修改（与 Vue 行为一致）
  // 父组件持有该 section 的可变克隆，子组件改 section.props.* 后通过 onUpdate 通知父组件重新克隆

  // 确保 section.props / options / chart_type 默认值
  const ensureSectionDefaults = () => {
    if (!section.props) section.props = {}
    if (!section.props.options) section.props.options = {}
    if (!section.props.chart_type) section.props.chart_type = 'line'
  }

  ensureSectionDefaults()

  // reactive(options) → useState
  const [options, setOptions] = useState<{ show_legend: boolean; smooth: boolean }>({
    show_legend: section.props.options.show_legend ?? true,
    smooth: section.props.options.smooth ?? false
  })

  // 从 section.props.preview_chart 读取示例图表的展示态
  const getPreviewChartState = () => {
    const previewChart = section.props.preview_chart || {}
    return {
      xAxis: Array.isArray(previewChart.x) ? previewChart.x.join(',') : '',
      seriesName: previewChart.series?.[0]?.name || '',
      seriesData: Array.isArray(previewChart.series?.[0]?.data) ? previewChart.series[0].data.join(',') : ''
    }
  }

  const initialPreviewState = getPreviewChartState()
  const [previewXAxis, setPreviewXAxis] = useState<string>(initialPreviewState.xAxis)
  const [previewSeriesName, setPreviewSeriesName] = useState<string>(initialPreviewState.seriesName)
  const [previewSeriesData, setPreviewSeriesData] = useState<string>(initialPreviewState.seriesData)
  const [fallbackChartKeysText, setFallbackChartKeysText] = useState<string>(
    Array.isArray(section.props.fallback_chart_keys) ? section.props.fallback_chart_keys.join(', ') : ''
  )

  // 当前 chart_type（驱动 v-if 切换与 placeholder）
  const chartType: string = section.props.chart_type

  // computed(goalPlaceholder)
  const goalPlaceholder = useMemo(() => {
    if (chartType === 'pie') return '例如：渠道占比分析'
    if (chartType === 'bar') return '例如：渠道对比分析'
    return '例如：销售趋势分析'
  }, [chartType])

  // watch(() => props.section, ..., { immediate: true, deep: true })
  // section 引用变化时（父组件切换/克隆出新 section），重新同步全部本地状态
  useEffect(() => {
    ensureSectionDefaults()
    setOptions({
      show_legend: section.props.options.show_legend ?? true,
      smooth: section.props.options.smooth ?? false
    })
    setFallbackChartKeysText(
      Array.isArray(section.props.fallback_chart_keys) ? section.props.fallback_chart_keys.join(', ') : ''
    )
    const nextPreviewState = getPreviewChartState()
    setPreviewXAxis(nextPreviewState.xAxis)
    setPreviewSeriesName(nextPreviewState.seriesName)
    setPreviewSeriesData(nextPreviewState.seriesData)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  // watch(() => section.value.props.chart_type, ...)
  // 切换图表类型时，重新同步示例图表展示态
  const prevChartTypeRef = useRef<string>(chartType)
  useEffect(() => {
    if (prevChartTypeRef.current === chartType) return
    prevChartTypeRef.current = chartType
    const nextPreviewState = getPreviewChartState()
    setPreviewXAxis(nextPreviewState.xAxis)
    setPreviewSeriesName(nextPreviewState.seriesName)
    setPreviewSeriesData(nextPreviewState.seriesData)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType])

  // 触发父组件 update（对应 emit('update')）
  const emitUpdate = () => onUpdate?.()

  const syncFallbackChartKeys = (value: string) => {
    setFallbackChartKeysText(value)
    section.props.fallback_chart_keys = toStringList(value)
    emitUpdate()
  }

  // 将本地 options 写回 section.props.options
  const syncOptions = (nextOptions: { show_legend: boolean; smooth: boolean }) => {
    section.props.options = { ...nextOptions }
    emitUpdate()
  }

  // 将示例图表输入写回 section.props.preview_chart
  const syncPreview = (next?: { xAxis?: string; seriesName?: string; seriesData?: string }) => {
    const xAxis = next?.xAxis ?? previewXAxis
    const seriesName = next?.seriesName ?? previewSeriesName
    const seriesData = next?.seriesData ?? previewSeriesData
    if (section.props.chart_type === 'pie') {
      section.props.preview_chart = {
        x: xAxis.split(',').map((item) => item.trim()).filter(Boolean),
        series: [
          {
            name: seriesName.trim() || '占比',
            data: seriesData.split(',').map((item) => item.trim()).filter(Boolean)
          }
        ]
      }
      emitUpdate()
      return
    }
    section.props.preview_chart = {
      x: xAxis.split(',').map((item) => item.trim()).filter(Boolean),
      series: [
        {
          name: seriesName.trim(),
          data: seriesData.split(',').map((item) => item.trim()).filter(Boolean)
        }
      ]
    }
    emitUpdate()
  }

  // @change（el-select）切换图表类型
  const handleChartTypeChange = (value: string | null) => {
    if (!value) return
    section.props.chart_type = value
    let nextOptions = options
    if (value !== 'line') {
      nextOptions = { ...options, smooth: false }
      setOptions(nextOptions)
    }
    section.props.options = { ...nextOptions }
    // 注意：syncPreview 内部读取 section.props.chart_type，已被更新为最新值
    syncPreview()
    emitUpdate()
  }

  return (
    <>
      {/* el-form-item label="图表类型" */}
      <Select
        label="图表类型"
        value={chartType}
        onChange={handleChartTypeChange}
        data={[
          { value: 'line', label: '折线图' },
          { value: 'bar', label: '柱状图' },
          { value: 'pie', label: '饼图' }
        ]}
        comboboxProps={{ withinPortal: true }}
      />

      {/* el-collapse.advanced-panel */}
      <Accordion className={styles['advanced-panel']} multiple>
        <Accordion.Item value="advanced">
          <Accordion.Control>高级配置</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              {/* chart_goal */}
              <TextInput
                label="chart_goal"
                placeholder={goalPlaceholder}
                value={section.props.chart_goal ?? ''}
                onChange={(e) => {
                  section.props.chart_goal = e.currentTarget.value
                  // 触发重渲染：placeholder 等依赖 section 的派生值
                  setOptions((o) => ({ ...o }))
                  emitUpdate()
                }}
              />

              {/* fallback_chart_keys，仅非饼图 */}
              {chartType !== 'pie' && (
                <div>
                  <TextInput
                    label="fallback_chart_keys"
                    placeholder="例如：paid_order_trend, order_count_trend"
                    value={fallbackChartKeysText}
                    onChange={(e) => syncFallbackChartKeys(e.currentTarget.value)}
                  />
                  <div className={styles['field-hint']}>主图无法构造时按顺序降级使用这些图表 key。</div>
                </div>
              )}

              {/* 饼图：示例分类 / 示例数值 */}
              {chartType === 'pie' ? (
                <>
                  <TextInput
                    label="示例分类"
                    placeholder="例如：官网,销售转化,内容投放"
                    value={previewXAxis}
                    onChange={(e) => {
                      const v = e.currentTarget.value
                      setPreviewXAxis(v)
                      syncPreview({ xAxis: v })
                    }}
                  />
                  <TextInput
                    label="示例数值"
                    placeholder="例如：40,30,20"
                    value={previewSeriesData}
                    onChange={(e) => {
                      const v = e.currentTarget.value
                      setPreviewSeriesData(v)
                      syncPreview({ seriesData: v })
                    }}
                  />
                </>
              ) : (
                <>
                  {/* 非饼图：示例 X 轴 / 示例系列名称 / 示例系列值 */}
                  <TextInput
                    label="示例 X 轴"
                    placeholder="例如：1月,2月,3月"
                    value={previewXAxis}
                    onChange={(e) => {
                      const v = e.currentTarget.value
                      setPreviewXAxis(v)
                      syncPreview({ xAxis: v })
                    }}
                  />
                  <TextInput
                    label="示例系列名称"
                    placeholder="例如：销售额"
                    value={previewSeriesName}
                    onChange={(e) => {
                      const v = e.currentTarget.value
                      setPreviewSeriesName(v)
                      syncPreview({ seriesName: v })
                    }}
                  />
                  <TextInput
                    label="示例系列值"
                    placeholder="例如：100,120,150"
                    value={previewSeriesData}
                    onChange={(e) => {
                      const v = e.currentTarget.value
                      setPreviewSeriesData(v)
                      syncPreview({ seriesData: v })
                    }}
                  />
                </>
              )}

              {/* 展示选项 */}
              {chartType === 'line' ? (
                <Group gap="md">
                  <Checkbox
                    label="显示图例"
                    checked={options.show_legend}
                    onChange={(e) => {
                      const next = { ...options, show_legend: e.currentTarget.checked }
                      setOptions(next)
                      syncOptions(next)
                    }}
                  />
                  <Checkbox
                    label="平滑曲线"
                    checked={options.smooth}
                    onChange={(e) => {
                      const next = { ...options, smooth: e.currentTarget.checked }
                      setOptions(next)
                      syncOptions(next)
                    }}
                  />
                </Group>
              ) : chartType === 'bar' ? (
                <Group gap="md">
                  <Checkbox
                    label="显示图例"
                    checked={options.show_legend}
                    onChange={(e) => {
                      const next = { ...options, show_legend: e.currentTarget.checked }
                      setOptions(next)
                      syncOptions(next)
                    }}
                  />
                </Group>
              ) : null}

              <div className={styles['field-hint']}>
                示例图表数据用于编辑器说明，正式渲染仍按 payload 绑定结果生成。
              </div>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </>
  )
}

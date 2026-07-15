// LLM 成本统计页(从 views/admin/llm_cost/index.vue 迁移)
// 图表用 echarts-for-react;时间范围 Element Plus datetimerange → 两个 Mantine DateTimePicker
import { useEffect, useMemo, useState } from 'react'
import { apiStreamFetch } from '@/utils/api-stream'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Group,
  Select,
  TextInput,
  Table,
  Pagination,
  Center,
  Text,
  Box,
  LoadingOverlay,
} from '@mantine/core'
import { DateTimePicker } from '@mantine/dates'
import { notifications } from '@mantine/notifications'
import ReactECharts from 'echarts-for-react'

import { getLLMCostReq, buildLLMCostCSVURL } from '@/api/admin_llm_cost'
import { llmModelsReq } from '@/api/models'
import { getAllProjectsReq } from '@/api/project'
import { createAPIURL } from '@/utils/url-helper'
import { useBasicStore } from '@/store/basic'
import ElSvgIcon from '@/components/ElSvgIcon'

import styles from './index.module.scss'

interface PresetItem {
  key: string
}

interface SummaryState {
  total_tokens: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_cached_tokens: number
  call_count: number
}

interface SortConfig {
  prop: string
  order: '' | 'ascending' | 'descending'
}

// ============ 预设 ============
const presets: PresetItem[] = [
  { key: 'today' },
  { key: '7d' },
  { key: '30d' },
]

const PIE_COLORS = [
  '#f97316', // orange   — 暖，主色醒目
  '#17483e', // yiw   — 冷绿
  '#10b981', // emerald  — 绿
  '#f43f5e', // rose     — 玫红
  '#06b6d4', // cyan     — 天蓝
  '#eab308', // yellow   — 暖黄
  '#2f6f60', // yiw   — 深绿
  '#22c55e', // green    — 草绿
]

// 产品决定只统计 token，CSV 也同步去掉 cost/currency 列（后端如有依然下发，前端在客户端裁掉）
const DROP_CSV_COLUMNS = new Set([
  'total_cost', 'avg_cost', 'avg_cost_per_call', 'currency',
  'input_cost', 'output_cost', 'cost',
])

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtDateTime = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`

// 'YYYY-MM-DD HH:mm:ss' 字符串 → Date(本地)
const strToDate = (s: string | null): Date | null => {
  if (!s) return null
  const d = new Date(String(s).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

const formatNumber = (n: any) => {
  if (n === null || n === undefined) return '-'
  const num = Number(n)
  if (!Number.isFinite(num)) return '-'
  return num.toLocaleString('en-US')
}

// 简易 CSV 解析：支持 ""/逗号转义/CRLF，足够处理后端 RFC4180 风格输出
const parseCSV = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else { inQuote = false }
      } else {
        cell += ch
      }
    } else {
      if (ch === '"') {
        inQuote = true
      } else if (ch === ',') {
        row.push(cell); cell = ''
      } else if (ch === '\n') {
        row.push(cell); rows.push(row); row = []; cell = ''
      } else if (ch === '\r') {
        // 忽略，等下一个 \n
      } else {
        cell += ch
      }
    }
  }
  // tail
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const stringifyCSV = (rows: string[][]): string => {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v)
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n')
}

const filterCSVColumns = (text: string): string => {
  const rows = parseCSV(text)
  if (rows.length === 0) return text
  const header = rows[0]
  const keepIdx = header.map((h, i) => (DROP_CSV_COLUMNS.has(String(h).trim()) ? -1 : i)).filter((i) => i >= 0)
  const filtered = rows.map((r) => keepIdx.map((i) => r[i] ?? ''))
  return stringifyCSV(filtered)
}

export default function Index() {
  const { t } = useTranslation()
  const token = useBasicStore((s) => s.token)

  // ============ 状态 ============
  const [loading, setLoading] = useState(false)
  const [timeRange, setTimeRange] = useState<[string, string] | null>(null) // [start, end] string YYYY-MM-DD HH:mm:ss
  const [activePreset, setActivePreset] = useState('7d')

  const [filters, setFilters] = useState({
    project_id: '',
    model_id: '',
    call_site: '',
  })

  const [groupBy, setGroupBy] = useState('call_site')

  const [summary, setSummary] = useState<SummaryState>({
    total_tokens: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_cached_tokens: 0,
    call_count: 0,
  })
  const [groups, setGroups] = useState<any[]>([])
  const [trend, setTrend] = useState<any[]>([])
  const [modelGroups, setModelGroups] = useState<any[]>([])

  // 分页 / 排序
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortConfig, setSortConfig] = useState<SortConfig>({ prop: 'total_tokens', order: 'descending' })

  // 维度数据
  const [projectOptions, setProjectOptions] = useState<any[]>([])
  const [modelOptions, setModelOptions] = useState<any[]>([])

  // ============ 计算 / 格式化 ============
  const promptRatio = useMemo(() => {
    if (!summary.total_tokens) return 0
    return Math.round(summary.total_prompt_tokens / summary.total_tokens * 100)
  }, [summary])
  const completionRatio = useMemo(() => {
    if (!summary.total_tokens) return 0
    return 100 - promptRatio
  }, [summary, promptRatio])
  const avgTokensPerCall = useMemo(() => {
    if (!summary.call_count) return 0
    return Math.round(summary.total_tokens / summary.call_count)
  }, [summary])
  // 缓存命中率 = 命中 token / prompt token（cached 是 prompt 的子集）
  const cacheHitRatio = useMemo(() => {
    if (!summary.total_prompt_tokens) return 0
    return Math.round(summary.total_cached_tokens / summary.total_prompt_tokens * 100)
  }, [summary])

  const hasTrend = useMemo(() => !!(trend && trend.length > 0), [trend])

  const trendOption = useMemo(() => {
    const dates = trend.map((p) => p.date)
    const tokens = trend.map((p) => p.total_tokens || 0)
    const fmtVal = (v: number) => {
      if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
      return String(v)
    }
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#17483e', width: 1, type: 'dashed' } },
        backgroundColor: '#fff',
        borderColor: '#e5e7eb',
        borderWidth: 1,
        textStyle: { color: '#374151', fontSize: 13 },
        formatter: (params: any) => {
          const p = params[0]
          return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;margin-right:6px"></span>
            Token: <b>${p.value?.toLocaleString('en-US') ?? '-'}</b>`
        },
      },
      legend: {
        data: [t('admin.llmCost.legendTokens')],
        top: 4,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: '#64748b', fontSize: 12 },
      },
      grid: { left: 60, right: 30, top: 40, bottom: 40 },
      xAxis: [{
        type: 'category',
        boundaryGap: false,
        data: dates,
        axisLine: { lineStyle: { color: '#e5e7eb' } },
        axisTick: { show: false },
        axisLabel: { color: '#94a3b8', fontSize: 12 },
      }],
      yAxis: [{
        type: 'value',
        name: t('admin.llmCost.legendTokens'),
        position: 'left',
        nameTextStyle: { color: '#94a3b8', fontSize: 12 },
        splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#94a3b8', fontSize: 12, formatter: fmtVal },
      }],
      series: [{
        name: t('admin.llmCost.legendTokens'),
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        data: tokens,
        itemStyle: { color: '#10b981' },
        lineStyle: { color: '#10b981', width: 2.5 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(16,185,129,0.20)' },
              { offset: 1, color: 'rgba(16,185,129,0.02)' },
            ],
          },
        },
      }],
    }
  }, [trend, t])

  const hasPie = useMemo(() => !!(modelGroups && modelGroups.length > 0), [modelGroups])

  const pieOption = useMemo(() => {
    const fmtNum = (n: any) => (n || 0).toLocaleString('en-US')
    const data = modelGroups.map((g, i) => ({
      name: g.model_name || g.model_id || 'unknown',
      value: g.total_tokens || 0,
      callCount: g.call_count || 0,
      itemStyle: {
        color: PIE_COLORS[i % PIE_COLORS.length],
        borderRadius: 8,
        borderColor: '#fff',
        borderWidth: 3,
      },
    }))
    return {
      tooltip: {
        trigger: 'item',
        backgroundColor: '#fff',
        borderColor: '#e5e7eb',
        borderWidth: 1,
        extraCssText: 'box-shadow:0 4px 16px rgba(0,0,0,0.10);border-radius:8px;',
        textStyle: { color: '#374151', fontSize: 13 },
        formatter: (p: any) =>
          `<div style="font-weight:600;margin-bottom:6px;color:#1e293b">${p.name}</div>
           <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>
           Token <b>${fmtNum(p.value)}</b> &nbsp;<span style="color:#94a3b8">${p.percent}%</span><br/>
           <span style="margin-left:14px;color:#64748b">调用 ${fmtNum(p.data.callCount)} 次</span>`,
      },
      legend: {
        orient: 'horizontal',
        bottom: 4,
        type: 'scroll',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: '#64748b', fontSize: 12 },
      },
      series: [{
        type: 'pie',
        radius: ['42%', '70%'],
        center: ['50%', '44%'],
        data,
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scaleSize: 5,
          itemStyle: { shadowBlur: 16, shadowColor: 'rgba(0,0,0,0.15)' },
        },
      }],
    }
  }, [modelGroups])

  const sortedGroups = useMemo(() => {
    const arr = Array.isArray(groups) ? [...groups] : []
    const { prop, order } = sortConfig
    if (!prop || !order) return arr
    const dir = order === 'ascending' ? 1 : -1
    return arr.sort((a, b) => {
      const va = a?.[prop]
      const vb = b?.[prop]
      // null 始终放最后
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
  }, [groups, sortConfig])

  const paginatedGroups = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return sortedGroups.slice(start, start + pageSize)
  }, [sortedGroups, currentPage, pageSize])

  const projectNameById = (id: any) => {
    if (!id) return ''
    const hit = projectOptions.find((p) => p.id === id)
    return hit?.name || ''
  }

  // ============ 请求 ============
  const buildParams = () => {
    if (!timeRange || timeRange.length !== 2) {
      return null
    }
    // 浏览器本地时区 'YYYY-MM-DD HH:mm:ss' → ISO UTC（toISOString 带 Z）：
    // 后端 _parse_iso_datetime 把 naive 当 UTC，直接发本地裸字符串会错位时区
    // （北京 +08 选『今天』会被后端按 UTC 同名时间查，缺前 8 小时数据）
    const localToISO = (s: string) => new Date(String(s).replace(' ', 'T')).toISOString()
    const params: any = {
      start: localToISO(timeRange[0]),
      end: localToISO(timeRange[1]),
      group_by: groupBy,
    }
    if (filters.project_id) params.project_id = filters.project_id
    if (filters.model_id) params.model_id = filters.model_id
    if (filters.call_site) params.call_site = filters.call_site
    return params
  }

  // 传入显式覆盖项，避免 setState 异步带来的“拿旧值”问题(替代 Vue 的同步响应式)
  const loadAll = async (overrides?: { timeRange?: [string, string] | null; groupBy?: string; filters?: typeof filters }) => {
    const effTimeRange = overrides?.timeRange !== undefined ? overrides.timeRange : timeRange
    const effGroupBy = overrides?.groupBy !== undefined ? overrides.groupBy : groupBy
    const effFilters = overrides?.filters !== undefined ? overrides.filters : filters

    if (!effTimeRange || effTimeRange.length !== 2) {
      notifications.show({ color: 'yellow', message: t('admin.llmCost.needTimeRange') })
      return
    }
    const localToISO = (s: string) => new Date(String(s).replace(' ', 'T')).toISOString()
    const params: any = {
      start: localToISO(effTimeRange[0]),
      end: localToISO(effTimeRange[1]),
      group_by: effGroupBy,
    }
    if (effFilters.project_id) params.project_id = effFilters.project_id
    if (effFilters.model_id) params.model_id = effFilters.model_id
    if (effFilters.call_site) params.call_site = effFilters.call_site

    setLoading(true)
    try {
      const [res, modelRes] = await Promise.all([
        getLLMCostReq(params) as any,
        getLLMCostReq({ ...params, group_by: 'model' }) as any,
      ])
      if (res && res.success) {
        const data = res.data || res
        const s = data.summary || {}
        setSummary({
          total_tokens: s.total_tokens || 0,
          total_prompt_tokens: s.total_prompt_tokens || 0,
          total_completion_tokens: s.total_completion_tokens || 0,
          total_cached_tokens: s.total_cached_tokens || 0,
          call_count: s.call_count || 0,
        })
        setGroups(data.groups || [])
        setTrend(data.trend || [])
        setCurrentPage(1)
      } else if (res && !res.success) {
        notifications.show({ color: 'red', message: res.message || t('admin.llmCost.loadFailed') })
      }
      if (modelRes && modelRes.success) {
        const mdata = modelRes.data || modelRes
        setModelGroups((mdata.groups || []).sort((a: any, b: any) => (b.total_tokens || 0) - (a.total_tokens || 0)))
      }
    } catch (e) {
      // 拦截器已显示报错信息，避免重复提示
    } finally {
      setLoading(false)
    }
  }

  const applyPreset = (key: string) => {
    const now = new Date()
    const end = new Date(now)
    let start: Date
    if (key === 'today') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
    } else if (key === '7d') {
      start = new Date(now)
      start.setDate(start.getDate() - 7)
    } else {
      // 30d 默认
      start = new Date(now)
      start.setDate(start.getDate() - 30)
    }
    const nextRange: [string, string] = [fmtDateTime(start), fmtDateTime(end)]
    setActivePreset(key)
    setTimeRange(nextRange)
    setCurrentPage(1)
    loadAll({ timeRange: nextRange })
  }

  const onTimeRangeChange = (next: [string, string] | null) => {
    setActivePreset('')
    setCurrentPage(1)
    loadAll({ timeRange: next })
  }

  const handleSearch = (overrides?: { groupBy?: string; filters?: typeof filters }) => {
    setCurrentPage(1)
    loadAll(overrides)
  }

  const handleReset = () => {
    const resetFilters = { project_id: '', model_id: '', call_site: '' }
    setFilters(resetFilters)
    setGroupBy('call_site')
    setSortConfig({ prop: 'total_tokens', order: 'descending' })
    // applyPreset('7d') 内部会带上重置后的 filters/groupBy
    const now = new Date()
    const start = new Date(now)
    start.setDate(start.getDate() - 7)
    const nextRange: [string, string] = [fmtDateTime(start), fmtDateTime(now)]
    setActivePreset('7d')
    setTimeRange(nextRange)
    setCurrentPage(1)
    loadAll({ timeRange: nextRange, groupBy: 'call_site', filters: resetFilters })
  }

  const onPageChange = (page: number) => {
    setCurrentPage(page)
  }

  const onSizeChange = (size: number) => {
    setPageSize(size)
    setCurrentPage(1)
  }

  // 表头点击排序(对齐 el-table sortable="custom" 的三态切换：升 → 降 → 无)
  const onSortChange = (prop: string) => {
    setSortConfig((prev) => {
      let order: SortConfig['order']
      if (prev.prop !== prop) {
        order = 'ascending'
      } else if (prev.order === 'ascending') {
        order = 'descending'
      } else if (prev.order === 'descending') {
        order = ''
      } else {
        order = 'ascending'
      }
      return { prop: order ? prop : '', order }
    })
    setCurrentPage(1)
  }

  const sortIndicator = (prop: string) => {
    if (sortConfig.prop !== prop || !sortConfig.order) return ''
    return sortConfig.order === 'ascending' ? ' ▲' : ' ▼'
  }

  // ============ 维度选项 ============
  const loadProjectOptions = async () => {
    try {
      const res: any = await getAllProjectsReq({})
      if (res && res.success) {
        const data = res.data
        const list = Array.isArray(data) ? data : (data?.items || data?.list || data?.projects || [])
        setProjectOptions(list.map((p: any) => ({
          id: p.id || p.project_id,
          name: p.name || p.project_name || p.id,
        })).filter((p: any) => p.id))
      }
    } catch (e) {
      // 静默
    }
  }

  const loadModelOptions = async () => {
    try {
      const res: any = await llmModelsReq({})
      if (res && res.success) {
        const data = res.data
        const list = Array.isArray(data) ? data : (data?.items || data?.list || data?.models || [])
        setModelOptions(list.map((m: any) => ({
          id: m.id || m.model_id,
          name: m.name,
          display_name: m.display_name,
          model_name: m.model_name,
        })).filter((m: any) => m.id))
      }
    } catch (e) {
      // 静默
    }
  }

  // ============ CSV 导出 ============
  const handleExport = async () => {
    const params = buildParams()
    if (!params) {
      notifications.show({ color: 'yellow', message: t('admin.llmCost.needTimeRange') })
      return
    }
    const path = buildLLMCostCSVURL(params)
    const url = createAPIURL(path)
    try {
      const res = await apiStreamFetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const rawText = await res.text()
      const filteredText = filterCSVColumns(rawText)
      // 加 UTF-8 BOM，Excel 打开不乱码
      const blob = new Blob(['﻿' + filteredText], { type: 'text/csv;charset=utf-8;' })
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      const start = (params.start || '').slice(0, 10)
      const end = (params.end || '').slice(0, 10)
      link.download = `llm-tokens-${start}_${end}.csv`
      link.click()
      URL.revokeObjectURL(blobUrl)
      notifications.show({ color: 'green', message: t('admin.llmCost.exportSuccess') })
    } catch (e) {
      notifications.show({ color: 'red', message: t('admin.llmCost.exportFailed') })
    }
  }

  // ============ 初始化 ============
  useEffect(() => {
    loadProjectOptions()
    loadModelOptions()
    applyPreset('7d')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 维度筛选选项
  const projectSelectData = projectOptions.map((p) => ({ value: String(p.id), label: p.name }))
  const modelSelectData = modelOptions.map((m) => ({
    value: String(m.id),
    label: m.display_name || m.name || m.model_name || m.id,
  }))

  const startDate = timeRange ? strToDate(timeRange[0]) : null
  const endDate = timeRange ? strToDate(timeRange[1]) : null

  return (
    <div className={styles['admin-llm-cost']}>
      {/* 页面头部 */}
      <div className={styles['page-header']}>
        <div className={styles['header-left']}>
          <h1>{t('admin.llmCost.title')}</h1>
          <p>{t('admin.llmCost.subtitle')}</p>
        </div>
        <div className={styles['header-right']}>
          <Button
            variant="default"
            leftSection={<ElSvgIcon name="Download" size={16} />}
            onClick={handleExport}
          >
            {t('admin.llmCost.exportCSV')}
          </Button>
          <Button
            color="blue"
            loading={loading}
            leftSection={<ElSvgIcon name="Refresh" size={16} />}
            onClick={() => loadAll()}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {/* 时间范围选择器 */}
      <div className={styles['filter-bar']}>
        <Button.Group className={styles['preset-group']}>
          {presets.map((p) => (
            <Button
              key={p.key}
              variant={activePreset === p.key ? 'filled' : 'default'}
              color={activePreset === p.key ? 'blue' : undefined}
              onClick={() => applyPreset(p.key)}
            >
              {t(`admin.llmCost.preset.${p.key}`)}
            </Button>
          ))}
        </Button.Group>

        <Group gap={6} wrap="nowrap" align="center">
          <DateTimePicker
            value={startDate}
            withSeconds
            valueFormat="YYYY-MM-DD HH:mm:ss"
            placeholder={t('admin.llmCost.startTime')}
            style={{ width: 175 }}
            onChange={(d: any) => {
              const startStr = d ? fmtDateTime(d as Date) : ''
              const endStr = timeRange?.[1] || ''
              const next = startStr && endStr ? ([startStr, endStr] as [string, string]) : null
              setTimeRange(next)
              onTimeRangeChange(next)
            }}
          />
          <Text size="sm" c="dimmed">{t('admin.llmCost.to')}</Text>
          <DateTimePicker
            value={endDate}
            withSeconds
            valueFormat="YYYY-MM-DD HH:mm:ss"
            placeholder={t('admin.llmCost.endTime')}
            style={{ width: 175 }}
            onChange={(d: any) => {
              const startStr = timeRange?.[0] || ''
              const endStr = d ? fmtDateTime(d as Date) : ''
              const next = startStr && endStr ? ([startStr, endStr] as [string, string]) : null
              setTimeRange(next)
              onTimeRangeChange(next)
            }}
          />
        </Group>

        {/* 维度筛选 */}
        <Select
          value={filters.project_id || null}
          data={projectSelectData}
          placeholder={t('admin.llmCost.filterProject')}
          clearable
          searchable
          style={{ width: 180 }}
          onChange={(v) => {
            const next = { ...filters, project_id: v || '' }
            setFilters(next)
            handleSearch({ filters: next })
          }}
        />
        <Select
          value={filters.model_id || null}
          data={modelSelectData}
          placeholder={t('admin.llmCost.filterModel')}
          clearable
          searchable
          style={{ width: 200 }}
          onChange={(v) => {
            const next = { ...filters, model_id: v || '' }
            setFilters(next)
            handleSearch({ filters: next })
          }}
        />
        <TextInput
          value={filters.call_site}
          placeholder={t('admin.llmCost.filterCallSite')}
          style={{ width: 200 }}
          leftSection={<ElSvgIcon name="Search" size={16} />}
          onChange={(e) => setFilters({ ...filters, call_site: e.currentTarget.value })}
          onKeyUp={(e) => { if (e.key === 'Enter') handleSearch() }}
        />

        <Button color="blue" onClick={() => handleSearch()}>{t('common.search')}</Button>
        <Button variant="default" onClick={handleReset}>{t('common.reset')}</Button>
      </div>

      {/* 统计卡片 */}
      <Box pos="relative" className={styles['stat-cards']}>
        <LoadingOverlay visible={loading} zIndex={5} />
        <div className={`${styles['stat-card']} ${styles['stat-card--total']}`}>
          <div className={styles['stat-card-body']}>
            <div className={styles['stat-label']}>{t('admin.llmCost.totalTokens')}</div>
            <div className={styles['stat-value']}>
              <span className={styles.value}>{formatNumber(summary.total_tokens)}</span>
            </div>
            {summary.total_tokens > 0 ? (
              <div className={styles['stat-extra']}>
                <div className={styles['token-split']}>
                  <div className={styles['split-bar']}>
                    <div className={styles['split-prompt']} style={{ width: promptRatio + '%' }}></div>
                    <div className={styles['split-completion']} style={{ width: completionRatio + '%' }}></div>
                  </div>
                  <span>Prompt {promptRatio}% · Completion {completionRatio}%</span>
                </div>
              </div>
            ) : (
              <div className={styles['stat-extra']}>&nbsp;</div>
            )}
          </div>
          <div className={`${styles['stat-icon-wrap']} ${styles['stat-icon--total']}`}>
            <ElSvgIcon name="DataAnalysis" size={20} />
          </div>
        </div>

        <div className={`${styles['stat-card']} ${styles['stat-card--prompt']}`}>
          <div className={styles['stat-card-body']}>
            <div className={styles['stat-label']}>{t('admin.llmCost.totalPromptTokens')}</div>
            <div className={styles['stat-value']}>
              <span className={styles.value}>{formatNumber(summary.total_prompt_tokens)}</span>
            </div>
            {summary.total_tokens > 0 ? (
              <div className={styles['stat-extra']}>
                <span>{t('admin.llmCost.cacheHit')} {formatNumber(summary.total_cached_tokens)} · {t('admin.llmCost.cacheHitRate')} {cacheHitRatio}%</span>
              </div>
            ) : (
              <div className={styles['stat-extra']}>&nbsp;</div>
            )}
          </div>
          <div className={`${styles['stat-icon-wrap']} ${styles['stat-icon--prompt']}`}>
            <ElSvgIcon name="Document" size={20} />
          </div>
        </div>

        <div className={`${styles['stat-card']} ${styles['stat-card--completion']}`}>
          <div className={styles['stat-card-body']}>
            <div className={styles['stat-label']}>{t('admin.llmCost.totalCompletionTokens')}</div>
            <div className={styles['stat-value']}>
              <span className={styles.value}>{formatNumber(summary.total_completion_tokens)}</span>
            </div>
            {summary.total_tokens > 0 ? (
              <div className={styles['stat-extra']}>
                <span>占总量 {completionRatio}%</span>
              </div>
            ) : (
              <div className={styles['stat-extra']}>&nbsp;</div>
            )}
          </div>
          <div className={`${styles['stat-icon-wrap']} ${styles['stat-icon--completion']}`}>
            <ElSvgIcon name="TrendCharts" size={20} />
          </div>
        </div>

        <div className={`${styles['stat-card']} ${styles['stat-card--calls']}`}>
          <div className={styles['stat-card-body']}>
            <div className={styles['stat-label']}>{t('admin.llmCost.callCount')}</div>
            <div className={styles['stat-value']}>
              <span className={styles.value}>{formatNumber(summary.call_count)}</span>
            </div>
            {summary.call_count > 0 ? (
              <div className={styles['stat-extra']}>
                <span>均 {formatNumber(avgTokensPerCall)} tokens/次</span>
              </div>
            ) : (
              <div className={styles['stat-extra']}>&nbsp;</div>
            )}
          </div>
          <div className={`${styles['stat-icon-wrap']} ${styles['stat-icon--calls']}`}>
            <ElSvgIcon name="Connection" size={20} />
          </div>
        </div>
      </Box>

      {/* 趋势图 + 模型饼图 */}
      <div className={styles['charts-row']}>
        <div className={styles['trend-card']}>
          <div className={styles['card-header']}>
            <span className={styles['card-title']}>{t('admin.llmCost.trendTitle')}</span>
          </div>
          <Box pos="relative" className={styles['chart-wrapper']}>
            <LoadingOverlay visible={loading} zIndex={5} />
            {hasTrend ? (
              <ReactECharts
                option={trendOption}
                notMerge
                style={{ width: '100%', height: 300 }}
                opts={{ renderer: 'canvas' }}
              />
            ) : (
              <Center style={{ flexDirection: 'column', gap: 8 }}>
                <Text size="sm" c="dimmed">{t('admin.llmCost.noData')}</Text>
              </Center>
            )}
          </Box>
        </div>

        <div className={styles['pie-card']}>
          <div className={styles['card-header']}>
            <span className={styles['card-title']}>模型分布</span>
            <span className={styles['card-subtitle']}>按 Token 用量</span>
          </div>
          <Box pos="relative" className={styles['chart-wrapper']}>
            <LoadingOverlay visible={loading} zIndex={5} />
            {hasPie ? (
              <ReactECharts
                option={pieOption}
                notMerge
                style={{ width: '100%', height: 300 }}
                opts={{ renderer: 'canvas' }}
              />
            ) : (
              <Center style={{ flexDirection: 'column', gap: 8 }}>
                <Text size="sm" c="dimmed">{t('admin.llmCost.noData')}</Text>
              </Center>
            )}
          </Box>
        </div>
      </div>

      {/* 分组表格 */}
      <div className={styles['group-card']}>
        <div className={`${styles['card-header']} ${styles['group-header']}`}>
          <span className={styles['card-title']}>{t('admin.llmCost.groupTitle')}</span>
          <div className={styles['group-by-switcher']}>
            <span className={styles.label}>{t('admin.llmCost.groupBy')}:</span>
            <Button.Group>
              {([
                ['call_site', t('admin.llmCost.groupCallSite')],
                ['model', t('admin.llmCost.groupModel')],
                ['project', t('admin.llmCost.groupProject')],
                ['call_site,model', t('admin.llmCost.groupCallSiteModel')],
                ['project,model', t('admin.llmCost.groupProjectModel')],
              ] as [string, string][]).map(([val, label]) => (
                <Button
                  key={val}
                  size="sm"
                  variant={groupBy === val ? 'filled' : 'default'}
                  color={groupBy === val ? 'blue' : undefined}
                  onClick={() => {
                    setGroupBy(val)
                    handleSearch({ groupBy: val })
                  }}
                >
                  {label}
                </Button>
              ))}
            </Button.Group>
          </div>
        </div>

        <Box pos="relative">
          <LoadingOverlay visible={loading} zIndex={5} />
          <Table striped style={{ width: '100%' }}>
            <Table.Thead>
              <Table.Tr>
                {groupBy.includes('call_site') && (
                  <Table.Th
                    style={{ minWidth: 180, cursor: 'pointer' }}
                    onClick={() => onSortChange('call_site')}
                  >
                    {t('admin.llmCost.colCallSite')}{sortIndicator('call_site')}
                  </Table.Th>
                )}
                {groupBy.includes('model') && (
                  <Table.Th
                    style={{ minWidth: 180, cursor: 'pointer' }}
                    onClick={() => onSortChange('model_name')}
                  >
                    {t('admin.llmCost.colModel')}{sortIndicator('model_name')}
                  </Table.Th>
                )}
                {groupBy.includes('project') && (
                  <Table.Th
                    style={{ minWidth: 160, cursor: 'pointer' }}
                    onClick={() => onSortChange('project_id')}
                  >
                    {t('admin.llmCost.colProject')}{sortIndicator('project_id')}
                  </Table.Th>
                )}
                <Table.Th
                  style={{ width: 140, textAlign: 'right', cursor: 'pointer' }}
                  onClick={() => onSortChange('total_tokens')}
                >
                  {t('admin.llmCost.colTotalTokens')}{sortIndicator('total_tokens')}
                </Table.Th>
                <Table.Th
                  style={{ width: 140, textAlign: 'right', cursor: 'pointer' }}
                  onClick={() => onSortChange('prompt_tokens')}
                >
                  {t('admin.llmCost.colPromptTokens')}{sortIndicator('prompt_tokens')}
                </Table.Th>
                <Table.Th
                  style={{ width: 160, textAlign: 'right', cursor: 'pointer' }}
                  onClick={() => onSortChange('completion_tokens')}
                >
                  {t('admin.llmCost.colCompletionTokens')}{sortIndicator('completion_tokens')}
                </Table.Th>
                <Table.Th
                  style={{ width: 150, textAlign: 'right', cursor: 'pointer' }}
                  onClick={() => onSortChange('cached_tokens')}
                >
                  {t('admin.llmCost.colCachedTokens')}{sortIndicator('cached_tokens')}
                </Table.Th>
                <Table.Th
                  style={{ width: 120, textAlign: 'right', cursor: 'pointer' }}
                  onClick={() => onSortChange('call_count')}
                >
                  {t('admin.llmCost.colCallCount')}{sortIndicator('call_count')}
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {paginatedGroups.map((row, idx) => (
                <Table.Tr key={idx}>
                  {groupBy.includes('call_site') && (
                    <Table.Td style={{ minWidth: 180 }}>
                      <span title={row.call_site || '-'}>{row.call_site || '-'}</span>
                    </Table.Td>
                  )}
                  {groupBy.includes('model') && (
                    <Table.Td style={{ minWidth: 180 }}>
                      <span title={row.model_name || row.model_id || '-'}>{row.model_name || row.model_id || '-'}</span>
                    </Table.Td>
                  )}
                  {groupBy.includes('project') && (
                    <Table.Td style={{ minWidth: 160 }}>
                      <span title={projectNameById(row.project_id) || row.project_id || '-'}>
                        {projectNameById(row.project_id) || row.project_id || '-'}
                      </span>
                    </Table.Td>
                  )}
                  <Table.Td style={{ textAlign: 'right' }}>{formatNumber(row.total_tokens)}</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>{formatNumber(row.prompt_tokens)}</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>{formatNumber(row.completion_tokens)}</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>
                    <span>{formatNumber(row.cached_tokens)}</span>
                    {row.prompt_tokens > 0 && (
                      <span className={styles['cache-rate']}>
                        {Math.round((row.cached_tokens || 0) / row.prompt_tokens * 100)}%
                      </span>
                    )}
                  </Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>{formatNumber(row.call_count)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>

        {sortedGroups.length > 0 && (
          <div className={styles['pagination-wrapper']}>
            <Group gap={12} align="center">
              <Text size="sm" c="dimmed">共 {sortedGroups.length} 条</Text>
              <Select
                value={String(pageSize)}
                data={['20', '50', '100', '200'].map((n) => ({ value: n, label: `${n} 条/页` }))}
                style={{ width: 110 }}
                onChange={(v) => onSizeChange(Number(v) || 50)}
              />
              <Pagination
                value={currentPage}
                total={Math.max(1, Math.ceil(sortedGroups.length / pageSize))}
                onChange={onPageChange}
              />
            </Group>
          </div>
        )}
      </div>
    </div>
  )
}

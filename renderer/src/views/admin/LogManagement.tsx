// 日志管理 admin 视图:Element Plus datetimerange → 两个 Mantine DateTimePicker;
// el-tabs/el-pagination/el-scrollbar → Mantine Tabs/Pagination/ScrollArea;v-loading → LoadingOverlay。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  TextInput,
  Select,
  Tooltip,
  Pagination,
  ScrollArea,
  Group,
  Text,
  LoadingOverlay,
  Box,
} from '@mantine/core'
import { DateTimePicker } from '@mantine/dates'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { getLogFilesReq, getLogContentReq } from '@/api/logs'
import { useBasicStore } from '@/store/basic'
import AlertSettingsDialog from './components/AlertSettingsDialog'
import styles from './LogManagement.module.scss'

// 日志条目/数据结构(源里无类型,用 any 即可)
interface LogEntry {
  timestamp?: string
  level?: string
  module?: string
  message?: string
}
interface LogData {
  file_size?: string
  total?: number
  total_pages?: number
  page?: number
  entries?: LogEntry[]
}
interface LogFile {
  log_type: string
  file_size: string
}

// dayjs Date → 'YYYY-MM-DD HH:mm:ss'(对齐 EP value-format)
const fmtDateTime = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}
// 'YYYY-MM-DD HH:mm:ss' → Date(供 DateTimePicker 回显)
const parseDateTime = (s?: string): Date | null => {
  if (!s) return null
  const d = new Date(s.replace(' ', 'T'))
  return isNaN(d.getTime()) ? null : d
}

export default function LogManagement() {
  const { t } = useTranslation()
  const userInfo = useBasicStore((s) => s.userInfo)
  const isAdmin = useMemo(() => !!userInfo?.is_admin, [userInfo])

  const [alertDialogVisible, setAlertDialogVisible] = useState(false)

  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('errors')
  const [logFiles, setLogFiles] = useState<LogFile[]>([])
  const [logData, setLogData] = useState<LogData | null>(null)
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  // timeRange: [startStr, endStr] 或 null(对齐 EP datetimerange)
  const [timeRange, setTimeRange] = useState<[string, string] | null>(null)
  const [includeHistory, setIncludeHistory] = useState(false)

  const [filters, setFilters] = useState({
    keyword: '',
    level: '',
    module: '',
  })

  // 用 ref 保存最新的 filters/分页/时间等,避免 fetch 闭包陷阱并便于同步触发
  const stateRef = useRef({
    activeTab,
    currentPage,
    pageSize,
    filters,
    timeRange,
    includeHistory,
  })
  stateRef.current = { activeTab, currentPage, pageSize, filters, timeRange, includeHistory }

  const logTypeLabels = useMemo<Record<string, string>>(
    () => ({
      errors: t('admin.logs.typeError'),
      info: t('admin.logs.typeInfo'),
      llm: t('admin.logs.typeLLM'),
      worker: t('admin.logs.typeWorker'),
    }),
    [t],
  )

  const hasLevel = ['errors', 'llm'].includes(activeTab)
  const hasTimestamp = ['errors', 'llm'].includes(activeTab)

  const getTabLabel = (file: LogFile) => {
    const label = logTypeLabels[file.log_type] || file.log_type
    return `${label} (${file.file_size})`
  }

  const levelClass = (level?: string) => {
    if (!level) return ''
    return styles['entry-' + level.toLowerCase()] || ''
  }

  const formatTimestamp = (ts?: string) => {
    if (!ts) return ''
    return ts.replace('T', ' ')
  }

  const highlightKeyword = (text?: string): string => {
    if (!text) return ''
    // 转义 HTML
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    const keyword = stateRef.current.filters.keyword
    if (!keyword) return escaped
    const keywords = keyword.trim().split(/\s+/)
    for (const kw of keywords) {
      if (!kw) continue
      const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(${escapedKw})`, 'gi')
      escaped = escaped.replace(re, '<mark>$1</mark>')
    }
    return escaped
  }

  const fetchLogFiles = async () => {
    try {
      const res: any = await getLogFilesReq()
      if (res.success) {
        setLogFiles(res.data)
      }
    } catch (e) {
      notifications.show({ color: 'red', message: t('admin.logs.loadFilesFailed') })
    }
  }

  const fetchLogContent = async () => {
    setLoading(true)
    const s = stateRef.current
    try {
      const params = {
        page: s.currentPage,
        pageSize: s.pageSize,
        keyword: s.filters.keyword,
        level: s.filters.level,
        module: s.filters.module,
        startTime: s.timeRange?.[0] || '',
        endTime: s.timeRange?.[1] || '',
        includeHistory: s.includeHistory,
      }
      const res: any = await getLogContentReq(s.activeTab, params)
      if (res.success) {
        setLogData(res.data)
        // nextTick → 滚动到顶部
        requestAnimationFrame(() => {
          if (scrollViewportRef.current) {
            scrollViewportRef.current.scrollTop = 0
          }
        })
      }
    } catch (e) {
      notifications.show({ color: 'red', message: t('admin.logs.loadContentFailed') })
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    stateRef.current.currentPage = 1
    setCurrentPage(1)
    fetchLogContent()
  }

  const toggleHistory = () => {
    const next = !stateRef.current.includeHistory
    stateRef.current.includeHistory = next
    stateRef.current.currentPage = 1
    setIncludeHistory(next)
    setCurrentPage(1)
    fetchLogContent()
  }

  const resetFilters = () => {
    const emptyFilters = { keyword: '', level: '', module: '' }
    stateRef.current.filters = emptyFilters
    stateRef.current.timeRange = null
    stateRef.current.includeHistory = false
    stateRef.current.currentPage = 1
    setFilters(emptyFilters)
    setTimeRange(null)
    setIncludeHistory(false)
    setCurrentPage(1)
  }

  const handleReset = () => {
    resetFilters()
    fetchLogContent()
  }

  const handleTabChange = (tab: string | null) => {
    if (!tab) return
    stateRef.current.activeTab = tab
    setActiveTab(tab)
    resetFilters()
    fetchLogContent()
  }

  const handlePageChange = (page: number) => {
    stateRef.current.currentPage = page
    setCurrentPage(page)
    fetchLogContent()
  }

  // toggleExpand:预留折叠展开,当前不做
  const toggleExpand = (_idx: number) => {
    // 预留折叠展开，当前不做
  }

  // onMounted:加载文件列表 + 内容
  useEffect(() => {
    ;(async () => {
      await fetchLogFiles()
      await fetchLogContent()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalPages = logData?.total_pages || 0

  return (
    <div className={styles['admin-log-management']}>
      {/* 页面头部 */}
      <div className={styles['page-header']}>
        <div className={styles['header-left']}>
          <h1>{t('admin.logs.title')}</h1>
          <p>{t('admin.logs.subtitle')}</p>
        </div>
        <div className={styles['header-right']}>
          {isAdmin && (
            <Button
              variant="default"
              leftSection={<ElSvgIcon name="Bell" size={16} />}
              onClick={() => setAlertDialogVisible(true)}
            >
              {t('admin.logs.alertSettings.button')}
            </Button>
          )}
          <Button
            color="blue"
            leftSection={<ElSvgIcon name="Refresh" size={16} />}
            loading={loading}
            onClick={handleSearch}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {/* 日志标签页 */}
      <div className={styles['log-tabs-wrapper']}>
        <Group gap={4} className={styles['log-tabs']}>
          {logFiles.map((file) => (
            <button
              key={file.log_type}
              type="button"
              className={`${styles['log-tab']} ${
                activeTab === file.log_type ? styles['log-tab-active'] : ''
              }`}
              onClick={() => handleTabChange(file.log_type)}
            >
              {getTabLabel(file)}
            </button>
          ))}
        </Group>
      </div>

      {/* 搜索栏 */}
      <div className={styles['search-bar']}>
        <TextInput
          value={filters.keyword}
          placeholder={t('admin.logs.keywordSearch')}
          style={{ width: 260 }}
          leftSection={<ElSvgIcon name="Search" size={16} />}
          onChange={(e) => setFilters((f) => ({ ...f, keyword: e.currentTarget.value }))}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
        />
        {hasLevel && (
          <Select
            value={filters.level || null}
            placeholder={t('admin.logs.logLevel')}
            clearable
            style={{ width: 130 }}
            data={[
              { value: 'ERROR', label: 'ERROR' },
              { value: 'WARNING', label: 'WARNING' },
              { value: 'INFO', label: 'INFO' },
            ]}
            onChange={(v) => setFilters((f) => ({ ...f, level: v || '' }))}
          />
        )}
        {activeTab === 'errors' && (
          <TextInput
            value={filters.module}
            placeholder={t('admin.logs.moduleName')}
            style={{ width: 150 }}
            onChange={(e) => setFilters((f) => ({ ...f, module: e.currentTarget.value }))}
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleSearch()
            }}
          />
        )}
        {hasTimestamp && (
          <Group gap={6} wrap="nowrap" align="center">
            <DateTimePicker
              value={parseDateTime(timeRange?.[0])}
              withSeconds
              clearable
              valueFormat="YYYY-MM-DD HH:mm:ss"
              placeholder={t('admin.logs.startTime')}
              style={{ width: 175 }}
              onChange={(d: any) => {
                const startStr = d ? fmtDateTime(d as Date) : ''
                const endStr = timeRange?.[1] || ''
                const next =
                  startStr && endStr ? ([startStr, endStr] as [string, string]) : null
                setTimeRange(next)
              }}
            />
            <Text size="sm" c="dimmed">
              {t('admin.logs.to')}
            </Text>
            <DateTimePicker
              value={parseDateTime(timeRange?.[1])}
              withSeconds
              clearable
              valueFormat="YYYY-MM-DD HH:mm:ss"
              placeholder={t('admin.logs.endTime')}
              style={{ width: 175 }}
              onChange={(d: any) => {
                const startStr = timeRange?.[0] || ''
                const endStr = d ? fmtDateTime(d as Date) : ''
                const next =
                  startStr && endStr ? ([startStr, endStr] as [string, string]) : null
                setTimeRange(next)
              }}
            />
          </Group>
        )}
        <Button color="blue" onClick={handleSearch}>
          {t('common.search')}
        </Button>
        <Button variant="default" onClick={handleReset}>
          {t('common.reset')}
        </Button>
        <div className={styles['search-bar-divider']} />
        <Tooltip
          position="bottom"
          label={
            includeHistory
              ? t('admin.logs.historyTooltipOn')
              : t('admin.logs.historyTooltipOff')
          }
        >
          <Button
            color={includeHistory ? 'yellow' : 'gray'}
            variant={includeHistory ? 'filled' : 'outline'}
            leftSection={
              <ElSvgIcon name={includeHistory ? 'FolderOpened' : 'Document'} size={16} />
            }
            onClick={toggleHistory}
          >
            {includeHistory ? t('admin.logs.allFiles') : t('admin.logs.currentFile')}
          </Button>
        </Tooltip>
      </div>

      {/* 日志内容区域 */}
      <div className={styles['log-content-wrapper']}>
        {logData && (
          <div className={styles['log-info']}>
            <span>
              {t('admin.logs.fileSize')}: {logData.file_size}
            </span>
            <span className={styles.separator}>|</span>
            <span>
              {t('admin.logs.totalEntries')}: {logData.total}
            </span>
            <span className={styles.separator}>|</span>
            <span>
              {t('admin.logs.pageInfo', { current: logData.page, total: logData.total_pages })}
            </span>
          </div>
        )}
        <ScrollArea className={styles['log-scrollbar']} viewportRef={scrollViewportRef}>
          <Box className={styles['log-entries']} pos="relative">
            <LoadingOverlay visible={loading} />
            {!logData?.entries?.length && !loading && (
              <div className={styles['log-empty']}>{t('admin.logs.noLogs')}</div>
            )}
            {(logData?.entries || []).map((entry, idx) => (
              <div key={idx} className={`${styles['log-entry']} ${levelClass(entry.level)}`}>
                {(entry.timestamp || entry.level) && (
                  <div className={styles['entry-header']}>
                    {entry.timestamp && (
                      <span className={styles['entry-time']}>
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    )}
                    {entry.level && (
                      <span
                        className={`${styles['entry-level']} ${
                          styles['level-' + entry.level.toLowerCase()] || ''
                        }`}
                      >
                        {entry.level}
                      </span>
                    )}
                    {entry.module && (
                      <span className={styles['entry-module']}>[{entry.module}]</span>
                    )}
                  </div>
                )}
                <div className={styles['entry-message']} onClick={() => toggleExpand(idx)}>
                  <span dangerouslySetInnerHTML={{ __html: highlightKeyword(entry.message) }} />
                </div>
              </div>
            ))}
          </Box>
        </ScrollArea>
        {/* 分页 */}
        {logData && totalPages > 1 && (
          <div className={styles['log-pagination']}>
            <Group gap="sm" align="center" wrap="wrap" justify="center">
              <Text size="xs" c="dimmed">
                {t('admin.logs.totalEntries')}: {logData.total}
              </Text>
              <Select
                size="xs"
                style={{ width: 110 }}
                value={String(pageSize)}
                data={[
                  { value: '50', label: '50' },
                  { value: '100', label: '100' },
                  { value: '200', label: '200' },
                  { value: '500', label: '500' },
                ]}
                onChange={(v) => {
                  if (!v) return
                  const size = Number(v)
                  stateRef.current.pageSize = size
                  stateRef.current.currentPage = 1
                  setPageSize(size)
                  setCurrentPage(1)
                  fetchLogContent()
                }}
              />
              <Pagination
                value={currentPage}
                total={totalPages}
                onChange={handlePageChange}
              />
            </Group>
          </div>
        )}
      </div>

      {isAdmin && (
        <AlertSettingsDialog
          opened={alertDialogVisible}
          onClose={() => setAlertDialogVisible(false)}
        />
      )}
    </div>
  )
}

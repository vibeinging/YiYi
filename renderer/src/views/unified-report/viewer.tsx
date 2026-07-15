import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, Center, Skeleton, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { getUnifiedReport } from '@/api/unifiedReport'
import { useConfigStore } from '@/store/config'
import styles from './viewer.module.scss'

interface ViewerProps {
  embedded?: boolean
  reportId?: string
}

export default function Viewer({ embedded = false, reportId = '' }: ViewerProps) {
  const params = useParams()
  const language = useConfigStore((s) => s.language)

  const [report, setReport] = useState<any>(null)
  const [htmlContent, setHtmlContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const currentReportId = useMemo(
    () => reportId || params.id || '',
    [reportId, params.id]
  )

  const reportCreatedAt = useMemo(() => {
    const value = report?.created_at
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }, [report, language])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadFailed(false)
      try {
        const res: any = await getUnifiedReport(currentReportId)
        if (cancelled) return
        setReport(res.data)
        setHtmlContent(res.data?.html || '')
      } catch (error: any) {
        if (cancelled) return
        setLoadFailed(true)
        notifications.show({ color: 'red', message: error?.message || '报告加载失败' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [currentReportId])

  return (
    <div className={styles.viewerPage}>
      <div className={styles.viewerToolbar}>
        <div className={styles.viewerMeta}>
          <span className={styles.metaLabel}>生成时间</span>
          <span className={styles.metaValue}>{reportCreatedAt}</span>
        </div>
      </div>

      {loading ? (
        <div className={styles.viewerState}>
          <Stack gap="sm">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} height={16} radius="sm" animate />
            ))}
          </Stack>
        </div>
      ) : loadFailed ? (
        <Center mih={200}>
          <Text c="dimmed">报告加载失败，请稍后重试。</Text>
        </Center>
      ) : (
        <Card withBorder={false} shadow="none" padding={0} className={styles.viewerCard}>
          {htmlContent ? (
            <iframe srcDoc={htmlContent} className={styles.viewerIframe} />
          ) : (
            <Center mih={200}>
              <Text c="dimmed">暂无 HTML 报告内容</Text>
            </Center>
          )}
        </Card>
      )}
    </div>
  )
}

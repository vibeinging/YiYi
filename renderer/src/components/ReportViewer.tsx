import { useEffect, useRef, useState } from 'react'
import { apiStreamFetch } from '@/utils/api-stream'
import { useTranslation } from 'react-i18next'
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Group,
  LoadingOverlay,
  Modal,
  Text,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { createAPIURL } from '@/utils/url-helper'
import { useBasicStore } from '@/store/basic'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './ReportViewer.module.scss'

interface ReportMetadata {
  section_count?: number
  paper_count?: number
  size_kb?: number
}

interface ReportViewerProps {
  /** 是否可见（对应 v-model:modelValue） */
  modelValue?: boolean
  /** 任务 ID */
  taskId?: string
  /** 项目 ID，用于权限校验（与任务/项目权限对齐） */
  projectId?: string
  /** 关闭/可见性变更回调（对应 emit('update:modelValue')） */
  onUpdateModelValue?: (val: boolean) => void
}

export default function ReportViewer(props: ReportViewerProps) {
  const { modelValue = false, taskId = '', projectId = '', onUpdateModelValue } = props
  const { t } = useTranslation()

  const [reportHtml, setReportHtml] = useState('')
  const [loading, setLoading] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [metadata, setMetadata] = useState<ReportMetadata>({
    section_count: 0,
    paper_count: 0,
    size_kb: 0,
  })
  const reportFrame = useRef<HTMLIFrameElement>(null)

  const visible = modelValue

  const loadReport = async () => {
    if (!taskId) return
    if (!projectId) {
      notifications.show({ color: 'yellow', message: t('common.missingProjectContext') })
      return
    }

    const token = useBasicStore.getState().token || ''
    const url = createAPIURL(`/api/projects/${projectId}/reports/${taskId}`)

    setLoading(true)
    try {
      const response = await apiStreamFetch(url, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        if (response.status === 404) {
          notifications.show({ color: 'red', message: t('common.reportNotFoundOrNoAccess') })
        } else {
          throw new Error(t('common.loadReportFailed'))
        }
        return
      }

      const data = await response.json()
      setReportHtml(data.html)
      setMetadata(data.metadata || {})

      console.log('✅ 报告加载成功:', {
        size: data.html?.length,
        size_kb: data.metadata?.size_kb,
      })
    } catch (error) {
      console.error('❌ 加载报告失败:', error)
      notifications.show({ color: 'red', message: t('common.loadReportFailed') })
    } finally {
      setLoading(false)
    }
  }

  const exportPDF = async () => {
    if (!reportHtml || !reportFrame.current) {
      notifications.show({ color: 'yellow', message: t('common.pleaseLoadReportFirst') })
      return
    }

    setPdfLoading(true)
    try {
      const iframe = reportFrame.current
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document

      if (!iframeDoc) {
        throw new Error('Cannot access iframe content')
      }

      // 使用html2pdf.js
      const html2pdf = (await import('html2pdf.js')).default

      const element = iframeDoc.querySelector('.report') || iframeDoc.body

      const opt = {
        margin: [10, 10, 10, 10],
        filename: `${t('common.deepResearchReport')}_${taskId}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'landscape',
        },
      }

      await (html2pdf as any)().set(opt).from(element).save()
      notifications.show({ color: 'green', message: t('common.pdfExportSuccess') })
    } catch (error) {
      console.error('❌ PDF导出失败:', error)
      notifications.show({ color: 'red', message: t('common.pdfExportFailed') })
    } finally {
      setPdfLoading(false)
    }
  }

  const shareLink = async () => {
    // 分享链接为项目内报告地址（需登录且具备项目权限）
    const base = window.location.origin
    const path = taskId ? `/unified-report/reports/${taskId}` : '/agent'
    const url = `${base}${path}`
    try {
      await navigator.clipboard.writeText(url)
      notifications.show({ color: 'green', message: t('common.linkCopied') })
    } catch {
      notifications.show({ color: 'red', message: t('common.copyFailed') })
    }
  }

  const toggleFullscreen = () => {
    if (reportFrame.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        reportFrame.current.requestFullscreen().catch((err) => {
          console.error('Fullscreen failed:', err)
          notifications.show({ color: 'yellow', message: t('common.fullscreenNotSupported') })
        })
      }
    }
  }

  const handleClose = () => {
    onUpdateModelValue?.(false)
  }

  // 对应 watch(() => props.modelValue)：打开时加载，关闭时清空
  useEffect(() => {
    if (visible && taskId && projectId) {
      loadReport()
    } else if (!visible) {
      // 关闭时清空
      setReportHtml('')
      setMetadata({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  return (
    <Modal
      opened={visible}
      onClose={handleClose}
      size="90%"
      closeOnClickOutside={false}
      withCloseButton={false}
      classNames={{ content: 'report-viewer-dialog' }}
      title={
        <div className={styles.reportHeader}>
          <div className={styles.headerLeft}>
            <span className={styles.reportIcon}>📄</span>
            <span className={styles.headerTitle}>{t('common.deepResearchReport')}</span>
          </div>
          <div className={styles.headerActions}>
            <Tooltip label={t('common.downloadPDF')}>
              <ActionIcon
                variant="default"
                radius="xl"
                size="lg"
                loading={pdfLoading}
                onClick={exportPDF}
              >
                <ElSvgIcon name="Download" />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('common.shareLink')}>
              <ActionIcon variant="default" radius="xl" size="lg" onClick={shareLink}>
                <ElSvgIcon name="Share" />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('common.fullscreen')}>
              <ActionIcon variant="default" radius="xl" size="lg" onClick={toggleFullscreen}>
                <ElSvgIcon name="FullScreen" />
              </ActionIcon>
            </Tooltip>
          </div>
        </div>
      }
    >
      {/* 加载状态 */}
      <Box className={styles.reportContainer}>
        <LoadingOverlay
          visible={loading}
          loaderProps={{ children: t('common.loadingReport') }}
        />
        {/* 报告iframe */}
        {reportHtml && !loading && (
          <iframe
            ref={reportFrame}
            srcDoc={reportHtml}
            className={styles.reportIframe}
            sandbox="allow-same-origin allow-scripts"
          />
        )}

        {/* 空状态 */}
        {!loading && !reportHtml && (
          <Center h="100%">
            <Text c="dimmed">{t('common.noReportContent')}</Text>
          </Center>
        )}
      </Box>

      <div className={styles.reportFooter}>
        <div className={styles.footerStats}>
          {!!metadata.section_count && (
            <span>
              {metadata.section_count} {t('common.sections')}
            </span>
          )}
          {!!metadata.paper_count && (
            <span>
              {metadata.paper_count} {t('common.papers')}
            </span>
          )}
          {!!metadata.size_kb && (
            <span>
              ~{metadata.size_kb}k {t('common.chars')}
            </span>
          )}
        </div>
        <Group justify="flex-end">
          <Button onClick={handleClose}>{t('common.close')}</Button>
        </Group>
      </div>
    </Modal>
  )
}

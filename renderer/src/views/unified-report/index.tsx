import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Modal, Table, Tabs, TextInput, Select, Badge, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useNavigate } from 'react-router-dom'
import { resolveDownloadErrorMessage } from '@/utils/download-error'
import { projectPath } from '@/utils/project-route'
import {
  downloadUnifiedReport,
  getUnifiedReportTemplateUsageBusinesses,
  listUnifiedReportTemplates,
  listUnifiedReports,
  setDefaultUnifiedReportTemplate,
  toggleUnifiedReportTemplateStatus
} from '@/api/unifiedReport'
import styles from './index.module.scss'

interface UnifiedReportProps {
  embedded?: boolean
  onNavigate?: (payload: { mode: string; id?: any }) => void
}

export default function UnifiedReport({ embedded = false, onNavigate }: UnifiedReportProps) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<string>('templates')
  const [templates, setTemplates] = useState<any[]>([])
  const [reports, setReports] = useState<any[]>([])
  const [keyword, setKeyword] = useState('')
  const [reportType, setReportType] = useState('')
  const [usageDialogVisible, setUsageDialogVisible] = useState(false)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageItems, setUsageItems] = useState<any[]>([])
  const [currentUsageTemplate, setCurrentUsageTemplate] = useState<any>(null)

  const usageDialogTitle = useMemo(() => {
    const name = currentUsageTemplate?.name || ''
    return name ? `使用记录 - ${name}` : '使用记录'
  }, [currentUsageTemplate])

  const loadTemplates = async () => {
    const res: any = await listUnifiedReportTemplates({ keyword, report_type: reportType, page_size: 100 })
    setTemplates(res.data?.items || [])
  }

  const loadReports = async () => {
    const res: any = await listUnifiedReports({ page_size: 20 })
    setReports(res.data?.items || [])
  }

  const loadUsageBusinesses = async (templateId: any) => {
    setUsageLoading(true)
    try {
      const usageRes: any = await getUnifiedReportTemplateUsageBusinesses(templateId)
      setUsageItems((usageRes.data?.items || []).map((item: any) => ({
        ...item,
        business_name: item.business_name || '-',
        business_description: item.business_description || '',
        latest_used_at: item.latest_used_at || '-'
      })))
    } finally {
      setUsageLoading(false)
    }
  }

  const goCreate = () => {
    if (embedded) {
      onNavigate?.({ mode: 'create' })
      return
    }
    navigate(`${projectPath('settings')}#reportTemplates:create`)
  }

  const goEdit = (id: any) => {
    if (embedded) {
      onNavigate?.({ mode: 'edit', id })
      return
    }
    navigate(`${projectPath('settings')}#reportTemplates:edit:${id}`)
  }

  const goViewer = (id: any) => {
    if (embedded) {
      onNavigate?.({ mode: 'view', id })
      return
    }
    navigate(`/unified-report/reports/${id}`)
  }

  const downloadReport = async (row: any) => {
    try {
      const response: any = await downloadUnifiedReport(row.id)
      const blob = new Blob([response.data], {
        type: response.headers['content-type'] || 'text/html;charset=utf-8'
      })
      const link = document.createElement('a')
      const objectUrl = window.URL.createObjectURL(blob)
      link.href = objectUrl
      link.download = row.title ? `${row.title}.html` : 'report.html'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(objectUrl)
    } catch (error) {
      const message = await resolveDownloadErrorMessage(error, '下载报告失败', '报告文件不存在')
      notifications.show({ color: 'red', message })
    }
  }

  const setDefault = async (row: any) => {
    await setDefaultUnifiedReportTemplate(row.id)
    notifications.show({ color: 'green', message: '已设为默认模板' })
    await loadTemplates()
  }

  const toggleStatus = async (row: any) => {
    const nextStatus = row.status === 'active' ? 'disabled' : 'active'
    await toggleUnifiedReportTemplateStatus(row.id, nextStatus)
    notifications.show({ color: 'green', message: '模板状态已更新' })
    await loadTemplates()
  }

  const openUsageDialog = async (row: any) => {
    setCurrentUsageTemplate(row)
    setUsageDialogVisible(true)
    await loadUsageBusinesses(row.id)
  }

  // onMounted：首次加载模板与报告列表
  useEffect(() => {
    Promise.all([loadTemplates(), loadReports()])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.reportPage}>
      <div className={styles.pageHeader}>
        <div>
          <h2>统一报告模板</h2>
          <p>定义报告结构、预览渲染效果，并基于标准 payload 生成正式报告。</p>
        </div>
        <div className={styles.pageHeaderActions}>
          <Button onClick={goCreate}>新建模板</Button>
        </div>
      </div>

      <Card className={styles.listCard} withBorder shadow="none">
        <Tabs value={activeTab} onChange={(v) => setActiveTab(v || 'templates')} className={styles.reportTabs}>
          <Tabs.List>
            <Tabs.Tab value="templates">报告模板</Tabs.Tab>
            <Tabs.Tab value="reports">报告列表</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="templates" pt="md">
            <div className={styles.cardHeader}>
              <div className={styles.filters}>
                <TextInput
                  value={keyword}
                  placeholder="搜索模板名称"
                  style={{ width: 220 }}
                  onChange={(e) => setKeyword(e.currentTarget.value)}
                  onBlur={loadTemplates}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadTemplates() }}
                />
                <Select
                  value={reportType || null}
                  clearable
                  placeholder="报告类型"
                  style={{ width: 180 }}
                  data={[{ value: 'general_analysis', label: 'general_analysis' }]}
                  onChange={(v) => { setReportType(v || ''); loadTemplates() }}
                />
              </div>
            </div>

            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ minWidth: 180 }}>模板名称</Table.Th>
                  <Table.Th style={{ width: 160 }}>报告类型</Table.Th>
                  <Table.Th style={{ width: 110 }}>状态</Table.Th>
                  <Table.Th style={{ width: 90 }}>默认</Table.Th>
                  <Table.Th style={{ width: 90 }}>版本</Table.Th>
                  <Table.Th style={{ width: 260 }}>操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {templates.map((row) => (
                  <Table.Tr key={row.id}>
                    <Table.Td>{row.name}</Table.Td>
                    <Table.Td>{row.report_type}</Table.Td>
                    <Table.Td>{row.status}</Table.Td>
                    <Table.Td>
                      {row.is_default ? <Badge color="green">默认</Badge> : <span>-</span>}
                    </Table.Td>
                    <Table.Td>{row.version}</Table.Td>
                    <Table.Td>
                      <Button variant="subtle" size="compact-sm" onClick={() => goEdit(row.id)}>编辑</Button>
                      <Button variant="subtle" size="compact-sm" onClick={() => openUsageDialog(row)}>使用记录</Button>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        disabled={row.is_default || row.status !== 'active'}
                        onClick={() => setDefault(row)}
                      >
                        设为默认
                      </Button>
                      <Button variant="subtle" color="gray" size="compact-sm" onClick={() => toggleStatus(row)}>
                        {row.status === 'active' ? '停用' : '启用'}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Tabs.Panel>

          <Tabs.Panel value="reports" pt="md">
            <div className={styles.cardHeader}>
            </div>

            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ minWidth: 220 }}>标题</Table.Th>
                  <Table.Th style={{ minWidth: 260 }}>摘要</Table.Th>
                  <Table.Th style={{ width: 160 }}>报告类型</Table.Th>
                  <Table.Th style={{ minWidth: 220 }}>来源模板</Table.Th>
                  <Table.Th style={{ width: 100 }}>区块数</Table.Th>
                  <Table.Th style={{ width: 110 }}>状态</Table.Th>
                  <Table.Th style={{ minWidth: 180 }}>生成时间</Table.Th>
                  <Table.Th style={{ width: 160 }}>操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {reports.map((row) => (
                  <Table.Tr key={row.id}>
                    <Table.Td>{row.title}</Table.Td>
                    <Table.Td>
                      <span className={styles.summaryCell}>{row.summary || '-'}</span>
                    </Table.Td>
                    <Table.Td>{row.report_type}</Table.Td>
                    <Table.Td>
                      <div className={styles.templateCell}>
                        <div>{row.metadata?.template_name || '-'}</div>
                      </div>
                    </Table.Td>
                    <Table.Td>{row.metadata?.section_count ?? '-'}</Table.Td>
                    <Table.Td>{row.status}</Table.Td>
                    <Table.Td>{row.created_at}</Table.Td>
                    <Table.Td>
                      <Button variant="subtle" size="compact-sm" onClick={() => goViewer(row.id)}>查看</Button>
                      <Button variant="subtle" size="compact-sm" onClick={() => downloadReport(row)}>下载</Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Tabs.Panel>
        </Tabs>
      </Card>

      <Modal
        opened={usageDialogVisible}
        onClose={() => setUsageDialogVisible(false)}
        size={760}
        title={usageDialogTitle}
      >
        <div className={styles.bindingDialogTip}>
          这里展示的是这个模板实际生成过报告的业务记录，不再展示或写入业务绑定配置。
        </div>
        {usageItems.length > 0 ? (
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={usageLoading} />
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ minWidth: 180 }}>业务名称</Table.Th>
                  <Table.Th style={{ minWidth: 220 }}>业务说明</Table.Th>
                  <Table.Th style={{ width: 120 }}>使用次数</Table.Th>
                  <Table.Th style={{ minWidth: 180 }}>最近使用时间</Table.Th>
                  <Table.Th style={{ minWidth: 140 }}>最近报告</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {usageItems.map((row, idx) => (
                  <Table.Tr key={row.business_id ?? idx}>
                    <Table.Td>{row.business_name}</Table.Td>
                    <Table.Td>
                      <span className={styles.summaryCell}>{row.business_description || '-'}</span>
                    </Table.Td>
                    <Table.Td>{row.usage_count}</Table.Td>
                    <Table.Td>
                      <span className={styles.summaryCell}>{row.latest_used_at || '-'}</span>
                    </Table.Td>
                    <Table.Td>
                      {row.latest_report_id ? (
                        <Button variant="subtle" size="compact-sm" onClick={() => goViewer(row.latest_report_id)}>
                          查看
                        </Button>
                      ) : (
                        <span>-</span>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ) : (
          !usageLoading && (
            <div className={styles.bindingEmpty}>
              这个模板暂时还没有使用记录。
            </div>
          )
        )}
      </Modal>
    </div>
  )
}

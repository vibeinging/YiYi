import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  Badge,
  Button,
  Drawer,
  Group,
  LoadingOverlay,
  Modal,
  Pagination,
  Select,
  Table,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import SemanticEmptyState from './SemanticEmptyState'
import {
  listWorkflowsReq,
  updateWorkflowReq,
  deleteWorkflowReq,
  triggerWorkflowRunReq,
  listWorkflowRunsReq,
  getWorkflowRunReq,
} from '@/api/superagent-workflow'
import { getSessionList } from '@/api/session'
import {
  filterAndSortWorkflows,
  statusTagType,
  statusLabel,
  isStatusSuccess,
  isStatusFailed,
  isStatusSkipped,
  isStatusPaused,
  formatTime,
  decorateNodeRuns,
} from './workflowListHelpers'
import styles from './WorkflowList.module.scss'

interface WorkflowListProps {
  projectId: string
  businessId: string
  businessName?: string
}

// EP tag type → Mantine Badge color（statusTagType 返回 success/danger/warning/info）
function tagColor(type: string): string {
  if (type === 'success') return 'green'
  if (type === 'danger') return 'red'
  if (type === 'warning') return 'yellow'
  return 'gray'
}

export default function WorkflowList({ projectId, businessId, businessName = '' }: WorkflowListProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [workflows, setWorkflows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(false)

  // ===== 列表 UI 状态:搜索 / 状态过滤 / 排序方向(纯客户端,不重发请求)=====
  const [searchKeyword, setSearchKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState('all') // all | enabled | disabled
  const [sortDesc, setSortDesc] = useState(true) // true=最新在前

  const displayedWorkflows = useMemo(
    () =>
      filterAndSortWorkflows(workflows, {
        keyword: searchKeyword,
        status: filterStatus as any,
        sortDesc,
      }),
    [workflows, searchKeyword, filterStatus, sortDesc]
  )

  const [runDialogVisible, setRunDialogVisible] = useState(false)
  const [runTarget, setRunTarget] = useState<any>(null)
  const [runForm, setRunForm] = useState<{ origin_session_id: string; query: string }>({
    origin_session_id: '',
    query: '',
  })
  const [runSubmitting, setRunSubmitting] = useState(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const [runListVisible, setRunListVisible] = useState(false)
  const [runs, setRuns] = useState<any[]>([])
  const [currentWorkflowId, setCurrentWorkflowId] = useState('')

  // run 详情
  const [runDetailVisible, setRunDetailVisible] = useState(false)
  const [runDetailLoading, setRunDetailLoading] = useState(false)
  const [runDetail, setRunDetail] = useState<any>(null)

  // node_runs 装饰:prefer 后端新字段 + fallback graph_snapshot(老 run 兼容)
  // 详见 workflowListHelpers.decorateNodeRuns
  const nodeRunsDecorated = useMemo(() => decorateNodeRuns(runDetail), [runDetail])

  // onMounted + watch([projectId, businessId])
  useEffect(() => {
    if (projectId && businessId) loadWorkflows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, businessId])

  // page 变化时重新加载(对应 el-pagination 的 @current-change="loadWorkflows")
  async function loadWorkflows() {
    setLoading(true)
    try {
      const res = await listWorkflowsReq(projectId, page, pageSize)
      setWorkflows(res.data?.items || [])
      setTotal(res.data?.total || 0)
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('workflow.list.msgLoadFailed') + (e.message || e) })
    } finally {
      setLoading(false)
    }
  }

  function goCreateNew() {
    navigate({
      pathname: `/agent/project/${projectId}/workflow-editor`,
      search: businessName ? `?businessName=${encodeURIComponent(businessName)}` : '',
    })
  }

  function goEdit(id: any) {
    navigate({
      pathname: `/agent/project/${projectId}/workflow-editor/${id}`,
      search: businessName ? `?businessName=${encodeURIComponent(businessName)}` : '',
    })
  }

  function handleDelete(id: any) {
    modals.openConfirmModal({
      title: t('workflow.list.deleteConfirm'),
      labels: { confirm: t('workflow.list.delete'), cancel: t('workflow.list.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteWorkflowReq(projectId, id)
          notifications.show({ color: 'green', message: t('workflow.list.msgDeleteSuccess') })
          loadWorkflows()
        } catch (e: any) {
          notifications.show({ color: 'red', message: t('workflow.list.msgDeleteFailed') + (e.message || e) })
        }
      },
    })
  }

  async function handleToggleEnabled(row: any) {
    const next = !row.is_enabled
    try {
      await updateWorkflowReq(projectId, row.id, { is_enabled: next })
      // 同步本地列表(原 Vue 直接 mutate row.is_enabled)
      setWorkflows((prev) => prev.map((w) => (w.id === row.id ? { ...w, is_enabled: next } : w)))
      notifications.show({
        color: 'green',
        message: next ? t('workflow.list.msgEnabled') : t('workflow.list.msgDisabled'),
      })
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: (next ? t('workflow.list.msgEnableFailed') : t('workflow.list.msgDisableFailed')) + (e.message || e),
      })
    }
  }

  function openRunDialog(row: any) {
    setRunTarget(row)
    setRunForm({ origin_session_id: '', query: '' })
    setRunDialogVisible(true)
    loadSessionsForRun()
  }

  async function loadSessionsForRun() {
    setSessionsLoading(true)
    try {
      const res = await getSessionList(projectId, {
        business_id: businessId,
        page: 1,
        per_page: 50,
        order_by: 'updated_at',
        order_desc: true,
      })
      setSessions(res.data?.items || [])
    } catch (e: any) {
      notifications.show({ color: 'yellow', message: t('workflow.list.msgLoadSessionFailed') + (e.message || e) })
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }

  async function handleTriggerRun() {
    if (!runForm.origin_session_id || !runForm.query) {
      notifications.show({ color: 'yellow', message: t('workflow.list.msgFillAll') })
      return
    }
    setRunSubmitting(true)
    try {
      // 后端 trigger_run 直接返完整 run.to_dict()(含 graph_snapshot / node_runs / input / output / error)
      // → 免调一次 getWorkflowRunReq,直接灌进明细 drawer
      const res = await triggerWorkflowRunReq(projectId, runTarget.id, runForm)
      const run = res.data || null
      setRunDialogVisible(false)
      if (!run) {
        notifications.show({ color: 'red', message: t('workflow.list.msgTriggerEmpty') })
        return
      }
      const shortId = (run.id || '').slice(0, 8)
      if (isStatusSuccess(run.status)) {
        notifications.show({ color: 'green', message: t('workflow.list.msgRunSuccess', { id: shortId }) })
      } else if (isStatusFailed(run.status)) {
        notifications.show({ color: 'red', message: t('workflow.list.msgRunFailed', { id: shortId }) })
      } else {
        notifications.show({
          color: 'blue',
          message: t('workflow.list.msgRunStatus', { status: statusLabel(run.status), id: shortId }),
        })
      }
      // 直接挂明细 drawer(用 trigger 返回的完整 run 对象)
      setRunDetail(run)
      setRunDetailVisible(true)
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('workflow.list.msgTriggerFailed') + (e.response?.data?.message || e.message || e),
      })
    } finally {
      setRunSubmitting(false)
    }
  }

  async function openRunList(workflowId: any) {
    try {
      const res = await listWorkflowRunsReq(projectId, workflowId, 1, 50)
      setRuns(res.data?.items || [])
      setCurrentWorkflowId(workflowId)
      setRunListVisible(true)
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('workflow.list.msgLoadRunsFailed') + (e.message || e) })
    }
  }

  async function handleResume(row: any) {
    // 失败 run 续跑:复用同 session + 同 query,backend 通过 resumed_from 跳过已成功节点
    const workflowId = row.workflow_id || currentWorkflowId
    if (!workflowId) {
      notifications.show({ color: 'red', message: t('workflow.list.msgNoWorkflowId') })
      return
    }
    try {
      // 先拉完整 run,确保拿到 input.query 和 origin_session_id(list 接口可能精简)
      const detailRes = await getWorkflowRunReq(row.id)
      const fullRun = detailRes.data
      if (!fullRun) {
        notifications.show({ color: 'red', message: t('workflow.list.msgNoOrigRun') })
        return
      }
      const query = fullRun.input?.query
      const originSessionId = fullRun.origin_session_id
      if (!query || !originSessionId) {
        notifications.show({ color: 'red', message: t('workflow.list.msgResumeMissing') })
        return
      }
      const res = await triggerWorkflowRunReq(projectId, workflowId, {
        origin_session_id: originSessionId,
        query,
        resumed_from: row.id,
      })
      if (isStatusSuccess(res.data?.status)) {
        notifications.show({ color: 'green', message: t('workflow.list.msgResumeSuccess', { id: res.data.id }) })
      } else {
        notifications.show({
          color: 'red',
          message: t('workflow.list.msgResumeFailed', {
            error: res.data?.error || t('workflow.list.unknownError'),
          }),
        })
      }
      await openRunList(workflowId)
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('workflow.list.msgResumeFailed', { error: e.response?.data?.message || e.message || e }),
      })
    }
  }

  function confirmResume(row: any) {
    modals.openConfirmModal({
      title: t('workflow.list.resumeConfirm'),
      labels: { confirm: t('workflow.list.resume'), cancel: t('workflow.list.cancel') },
      confirmProps: { color: 'yellow' },
      onConfirm: () => handleResume(row),
    })
  }

  async function openRunDetail(runId: any) {
    setRunDetail(null)
    setRunDetailLoading(true)
    setRunDetailVisible(true)
    try {
      const res = await getWorkflowRunReq(runId)
      setRunDetail(res.data || null)
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('workflow.list.msgLoadDetailFailed') + (e.response?.data?.message || e.message || e),
      })
      setRunDetailVisible(false)
    } finally {
      setRunDetailLoading(false)
    }
  }

  function onCloseDetail() {
    setRunDetail(null)
    setRunDetailVisible(false)
  }

  function formatOutputPreview(preview: any): string {
    if (preview === null || preview === undefined) return ''
    if (typeof preview === 'string') return preview
    try {
      return JSON.stringify(preview, null, 2)
    } catch {
      return String(preview)
    }
  }

  // 完全没有 workflow 时(非过滤导致),隐藏头部工具行,仅居中展示空状态(与指标/Skill 等页面保持一致)
  const isListEmpty = !loading && workflows.length === 0

  return (
    <div className={styles.workflowListTab}>
      {!isListEmpty && (
      <div className={styles.header}>
        <span className={styles.hint}>{t('workflow.list.title')}</span>
        <div className={styles.headerActions}>
          <TextInput
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.currentTarget.value)}
            placeholder={t('workflow.list.searchPlaceholder')}
            className={styles.searchInput}
            leftSection={<ElSvgIcon name="Search" size={16} />}
          />
          <Select
            value={filterStatus}
            onChange={(v) => setFilterStatus(v || 'all')}
            className={styles.statusFilter}
            allowDeselect={false}
            data={[
              { value: 'all', label: t('workflow.list.statusAll') },
              { value: 'enabled', label: t('workflow.list.statusEnabled') },
              { value: 'disabled', label: t('workflow.list.statusDisabled') },
            ]}
          />
          <Tooltip
            label={sortDesc ? t('workflow.list.sortDescTip') : t('workflow.list.sortAscTip')}
            position="top"
          >
            <Button variant="default" onClick={() => setSortDesc((v) => !v)} leftSection={<ElSvgIcon name="Sort" size={16} />}>
              {sortDesc ? '↓' : '↑'}
            </Button>
          </Tooltip>
          <Button onClick={goCreateNew} leftSection={<ElSvgIcon name="Plus" size={16} />}>
            {t('workflow.list.create')}
          </Button>
        </div>
      </div>
      )}

      {!isListEmpty && (
      <div style={{ position: 'relative' }}>
        <LoadingOverlay visible={loading} />
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ minWidth: 180 }}>{t('workflow.list.colName')}</Table.Th>
              <Table.Th style={{ minWidth: 280 }}>{t('workflow.list.colTrigger')}</Table.Th>
              <Table.Th style={{ width: 80, textAlign: 'center' }}>{t('workflow.list.colRevision')}</Table.Th>
              <Table.Th style={{ width: 90, textAlign: 'center' }}>{t('workflow.list.colStatus')}</Table.Th>
              <Table.Th style={{ width: 170 }}>{t('workflow.list.colUpdated')}</Table.Th>
              <Table.Th style={{ width: 380 }}>{t('workflow.list.colActions')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {displayedWorkflows.map((row: any) => (
              <Table.Tr key={row.id}>
                <Table.Td>{row.name}</Table.Td>
                <Table.Td>
                  {row.trigger && row.trigger.summary ? (
                    <div>
                      <div>{row.trigger.summary}</div>
                      {Array.isArray(row.trigger.examples) && row.trigger.examples.length ? (
                        <div style={{ color: '#909399', fontSize: 12, marginTop: 2 }}>
                          {t('workflow.list.exampleCount', { count: row.trigger.examples.length })}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span style={{ color: '#c0c4cc' }}>{t('workflow.list.triggerUnset')}</span>
                  )}
                </Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>{row.revision}</Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>
                  <Badge size="sm" color={row.is_enabled ? 'green' : 'gray'} variant="light">
                    {row.is_enabled ? t('workflow.list.enabled') : t('workflow.list.disabled')}
                  </Badge>
                </Table.Td>
                <Table.Td>{formatTime(row.updated_at)}</Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Button size="xs" variant="default" onClick={() => goEdit(row.id)}>
                      {t('workflow.list.edit')}
                    </Button>
                    <Button
                      size="xs"
                      color={row.is_enabled ? 'yellow' : 'green'}
                      onClick={() => handleToggleEnabled(row)}
                    >
                      {row.is_enabled ? t('workflow.list.disable') : t('workflow.list.enable')}
                    </Button>
                    <Button size="xs" variant="default" onClick={() => openRunDialog(row)}>
                      {t('workflow.list.triggerRun')}
                    </Button>
                    <Button size="xs" variant="default" onClick={() => openRunList(row.id)}>
                      {t('workflow.list.runHistory')}
                    </Button>
                    <Button size="xs" color="red" onClick={() => handleDelete(row.id)}>
                      {t('workflow.list.delete')}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      )}

      {isListEmpty ? (
        <SemanticEmptyState
          icon={<ElSvgIcon name="Connection" size={26} color="#fff" />}
          satellites={[
            <ElSvgIcon key="a" name="MagicStick" size={20} />,
            <ElSvgIcon key="b" name="SetUp" size={20} />,
          ]}
          title={t('workflow.list.workflowEmpty.title')}
          description={t('workflow.list.workflowEmpty.description')}
          features={[
            { icon: <ElSvgIcon name="MagicStick" size={16} />, label: t('workflow.list.workflowEmpty.feature1') },
            { icon: <ElSvgIcon name="SetUp" size={16} />, label: t('workflow.list.workflowEmpty.feature2') },
            { icon: <ElSvgIcon name="Connection" size={16} />, label: t('workflow.list.workflowEmpty.feature3') },
          ]}
          actions={
            <Button leftSection={<ElSvgIcon name="Plus" size={16} />} onClick={goCreateNew}>
              {t('workflow.list.create')}
            </Button>
          }
        />
      ) : (
        !loading &&
        !displayedWorkflows.length && (
          <div className={styles.emptyHint}>
            <span>{t('workflow.list.emptyFiltered')}</span>
          </div>
        )
      )}

      {!isListEmpty && (
      <Pagination
        value={page}
        onChange={(p) => {
          setPage(p)
          loadWorkflows()
        }}
        total={Math.max(1, Math.ceil(total / pageSize))}
        className={styles.pagination}
      />
      )}

      {/* 触发 run dialog */}
      <Modal
        opened={runDialogVisible}
        onClose={() => setRunDialogVisible(false)}
        title={t('workflow.list.runDialogTitle')}
        size={520}
      >
        <div className={styles.runFormItem}>
          <label className={styles.runFormLabel}>Workflow</label>
          <TextInput value={runTarget?.name || ''} disabled />
        </div>
        <div className={styles.runFormItem}>
          <label className={styles.runFormLabel}>
            {t('workflow.list.originSession')} <span style={{ color: '#f56c6c' }}>*</span>
          </label>
          <Select
            value={runForm.origin_session_id || null}
            onChange={(v) => setRunForm((f) => ({ ...f, origin_session_id: v || '' }))}
            searchable
            placeholder={
              sessions.length
                ? t('workflow.list.sessionPlaceholder')
                : t('workflow.list.sessionEmptyPlaceholder')
            }
            nothingFoundMessage={t('workflow.list.sessionNoData')}
            disabled={sessionsLoading}
            style={{ width: '100%' }}
            data={sessions.map((s: any) => ({
              value: s.id,
              label: `${s.title}　${formatTime(s.updated_at)}`,
            }))}
          />
        </div>
        <div className={styles.runFormItem}>
          <label className={styles.runFormLabel}>
            Query <span style={{ color: '#f56c6c' }}>*</span>
          </label>
          <Textarea
            value={runForm.query}
            onChange={(e) => setRunForm((f) => ({ ...f, query: e.currentTarget.value }))}
            rows={3}
            autosize
            minRows={3}
          />
        </div>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRunDialogVisible(false)}>
            {t('workflow.list.cancel')}
          </Button>
          <Button loading={runSubmitting} onClick={handleTriggerRun}>
            {t('workflow.list.trigger')}
          </Button>
        </Group>
      </Modal>

      {/* run 历史 drawer */}
      <Drawer
        opened={runListVisible}
        onClose={() => setRunListVisible(false)}
        title={t('workflow.list.runHistoryTitle')}
        position="right"
        size={900}
      >
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 240 }}>{t('workflow.list.colRunId')}</Table.Th>
              <Table.Th style={{ width: 100 }}>{t('workflow.list.colStatus')}</Table.Th>
              <Table.Th style={{ width: 80, textAlign: 'center' }}>{t('workflow.list.colRevision')}</Table.Th>
              <Table.Th style={{ width: 160 }}>{t('workflow.list.colCreatedAt')}</Table.Th>
              <Table.Th style={{ minWidth: 180 }}>{t('workflow.list.colError')}</Table.Th>
              <Table.Th style={{ width: 180 }}>{t('workflow.list.colActions')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {runs.map((row: any) => (
              <Table.Tr key={row.id}>
                <Table.Td>
                  <span title={row.id} className={styles.ellipsis}>
                    {row.id}
                  </span>
                </Table.Td>
                <Table.Td>
                  <Badge color={tagColor(statusTagType(row.status))} variant="light">
                    {statusLabel(row.status)}
                  </Badge>
                </Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>{row.workflow_revision}</Table.Td>
                <Table.Td>{formatTime(row.created_at)}</Table.Td>
                <Table.Td>
                  <span title={row.error} className={styles.ellipsis}>
                    {row.error}
                  </span>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Button size="xs" variant="subtle" onClick={() => openRunDetail(row.id)}>
                      {t('workflow.list.viewDetail')}
                    </Button>
                    {isStatusFailed(row.status) && (
                      <Button size="xs" variant="subtle" color="yellow" onClick={() => confirmResume(row)}>
                        {t('workflow.list.resume')}
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Drawer>

      {/* run 详情 drawer:每节点 span 明细 */}
      <Drawer
        opened={runDetailVisible}
        onClose={onCloseDetail}
        title={t('workflow.list.runDetailTitle')}
        position="right"
        size={720}
      >
        {runDetailLoading ? (
          <div style={{ height: '80vh', position: 'relative' }}>
            <LoadingOverlay visible />
          </div>
        ) : !runDetail ? (
          <div className={styles.runDetailEmpty}>{t('workflow.list.runDetailEmpty')}</div>
        ) : (
          <div className={styles.runDetail}>
            <div className={styles.runMeta}>
              <div>
                <b>{t('workflow.list.metaRunId')}</b> <code>{runDetail.id}</code>
              </div>
              <div>
                <b>{t('workflow.list.metaStatus')}</b>{' '}
                <Badge size="sm" color={tagColor(statusTagType(runDetail.status))} variant="light">
                  {statusLabel(runDetail.status)}
                </Badge>
              </div>
              <div>
                <b>{t('workflow.list.metaRevision')}</b> rev.{runDetail.workflow_revision}
              </div>
              <div>
                <b>{t('workflow.list.metaSession')}</b> <code>{runDetail.origin_session_id}</code>
              </div>
              <div>
                <b>{t('workflow.list.metaStart')}</b> {formatTime(runDetail.created_at)}
              </div>
              {runDetail.finished_at && (
                <div>
                  <b>{t('workflow.list.metaEnd')}</b> {formatTime(runDetail.finished_at)}
                </div>
              )}
            </div>

            {runDetail.input && (
              <div className={styles.runSection}>
                <div className={styles.runSectionTitle}>{t('workflow.list.sectionInput')}</div>
                <pre className={styles.runJson}>{JSON.stringify(runDetail.input, null, 2)}</pre>
              </div>
            )}

            {runDetail.error && (
              <div className={styles.runSection}>
                <div className={`${styles.runSectionTitle} ${styles.runSectionError}`}>
                  {t('workflow.list.sectionRunError')}
                </div>
                <pre className={`${styles.runJson} ${styles.runError}`}>{runDetail.error}</pre>
              </div>
            )}

            <div className={styles.runSection}>
              <div className={styles.runSectionTitle}>
                🔁 {t('workflow.runDetail.nodeRunsTitle', '节点执行明细')}({nodeRunsDecorated.length})
              </div>
              {nodeRunsDecorated.length ? (
                <Accordion variant="contained" multiple>
                  {nodeRunsDecorated.map((nr: any) => {
                    const skipped = isStatusSkipped(nr.status)
                    const paused = isStatusPaused(nr.status)
                    return (
                      <Accordion.Item
                        key={nr.node_id}
                        value={nr.node_id}
                        className={
                          skipped
                            ? styles.nodeRunSkipped
                            : paused
                            ? styles.nodeRunPaused
                            : undefined
                        }
                      >
                        <Accordion.Control>
                          <div className={styles.nodeRunTitle}>
                            {skipped && nr.meta?.skip_reason ? (
                              <Tooltip label={nr.meta.skip_reason} position="top">
                                <Badge size="sm" color={tagColor(statusTagType(nr.status))} variant="light">
                                  {statusLabel(nr.status)}
                                </Badge>
                              </Tooltip>
                            ) : (
                              <Badge size="sm" color={tagColor(statusTagType(nr.status))} variant="light">
                                {statusLabel(nr.status)}
                              </Badge>
                            )}
                            <span className={styles.nodeRunId}>{nr.node_id}</span>
                            <span className={styles.nodeRunType}>{nr.type || '?'}</span>
                            {nr.tool_name && <span className={styles.nodeRunTool}>{nr.tool_name}</span>}
                            {nr.error && <span className={styles.nodeRunErrorFlag}>⚠</span>}
                            {nr.route_directive && <span className={styles.nodeRunDirectiveFlag}>↳</span>}
                          </div>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <div className={styles.nodeRunBody}>
                            {nr.error && (
                              <div className={styles.nodeRunError}>
                                <b>{t('workflow.list.nodeError')}</b> <code>{nr.error}</code>
                              </div>
                            )}

                            {/* envelope: route_directive(2026-05-28 加) — 短路下游高亮 */}
                            {nr.route_directive && (
                              <div className={styles.nodeRunDirective}>
                                <b>↳ {t('workflow.runDetail.routeDirective', '路由指令')}:</b>{' '}
                                <code>{nr.route_directive.type}</code>
                                {nr.route_directive.target?.length ? (
                                  <span> → [{nr.route_directive.target.join(', ')}]</span>
                                ) : null}
                                {nr.route_directive.reason && (
                                  <div className={styles.nodeRunDirectiveReason}>
                                    {nr.route_directive.reason}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* envelope: meta(2026-05-28 加) — skipped 的 skip_reason / 调试信息 */}
                            {nr.meta && Object.keys(nr.meta).length ? (
                              <div className={styles.nodeRunMeta}>
                                <b>📝 {t('workflow.runDetail.meta', 'Meta')}:</b>
                                <pre className={styles.runJson}>{JSON.stringify(nr.meta, null, 2)}</pre>
                              </div>
                            ) : null}

                            {nr.output_preview !== undefined && (
                              <div className={styles.nodeRunOutput}>
                                <b>{t('workflow.runDetail.outputPreview', '输出预览')}:</b>
                                <pre className={styles.runJson}>{formatOutputPreview(nr.output_preview)}</pre>
                              </div>
                            )}
                            {!nr.error &&
                              nr.output_preview === undefined &&
                              !nr.route_directive &&
                              !(nr.meta && Object.keys(nr.meta).length) && (
                                <div className={styles.nodeRunEmpty}>{t('workflow.list.noOutputSnapshot')}</div>
                              )}
                          </div>
                        </Accordion.Panel>
                      </Accordion.Item>
                    )
                  })}
                </Accordion>
              ) : (
                <div className={styles.runDetailEmpty}>{t('workflow.list.noNodeSpans')}</div>
              )}
            </div>

            {runDetail.output && (
              <div className={styles.runSection}>
                <div className={styles.runSectionTitle}>{t('workflow.list.sectionFinalOutput')}</div>
                <pre className={styles.runJson}>{JSON.stringify(runDetail.output, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}

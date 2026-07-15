import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActionIcon,
  Badge,
  Button,
  Modal,
  SegmentedControl,
  Skeleton,
  Switch,
  TextInput,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import marked, { sanitizeMarkdownHtml } from '@/utils/markdownConfig'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useProjectStore } from '@/store/project'
import SkillEditor, { type SkillEditorHandle } from './components/SkillEditor'
import SemanticEmptyState from '../business/components/SemanticEmptyState'
import {
  aiGenerateAppSkillReq,
  aiGenerateSkillReq,
  createAppSkillReq,
  listSkillsReq,
  getSkillDetailReq,
  toggleSkillReq,
  createSkillReq,
  updateSkillReq,
  deleteSkillReq,
  getAvailableToolsReq,
  deleteAppSkillReq,
  getAppAvailableToolsReq,
  getAppSkillDetailReq,
  listAppSkillsReq,
  toggleAppSkillReq,
  updateAppSkillReq
} from '@/api/skills'
import styles from './index.module.scss'

interface SkillItem {
  name: string
  description?: string
  category?: string | null
  tags?: string[]
  allowed_tools?: string[]
  is_enabled?: boolean
  default_enabled?: boolean
  effective_enabled?: boolean
  enabled_override?: boolean | null
  builtin?: boolean
  runtime?: string
  type?: string
  availability?: string
  availability_reason?: string
  requires_project?: boolean
  _toggling?: boolean
  [k: string]: any
}

interface SkillsProps {
  scope?: 'project' | 'app'
}

type StatusFilter = 'all' | 'enabled' | 'disabled'

const isEnabled = (skill: SkillItem | null | undefined) => {
  if (!skill) return false
  return !!(skill.effective_enabled ?? skill.is_enabled ?? skill.default_enabled)
}

const isSystemSkill = (skill: SkillItem | null | undefined) => !!skill?.builtin

const sanitizeMarkdown = (source?: string) => {
  if (!source) return ''
  try {
    return marked.parse(source) as string
  } catch {
    return sanitizeMarkdownHtml(source)
  }
}

export default function Skills({ scope = 'project' }: SkillsProps = {}) {
  const { t } = useTranslation()
  const isAppScope = scope === 'app'
  const currentProjectId = useProjectStore((s) => s.currentProject?.id || null)
  const hasScope = isAppScope || !!currentProjectId
  const pageTitle = isAppScope ? 'App 技能库' : '项目技能'
  const pageDesc = isAppScope
    ? '维护全局技能定义、默认启用状态和可调用工具。'
    : '为当前问数项目选择可用技能，并管理项目级启用覆盖。'

  const request = useMemo(
    () => ({
      list: () => (isAppScope ? listAppSkillsReq() : listSkillsReq(currentProjectId)),
      detail: (name: string) => (isAppScope ? getAppSkillDetailReq(name) : getSkillDetailReq(currentProjectId, name)),
      toggle: (name: string, data: any) => (isAppScope ? toggleAppSkillReq(name, data) : toggleSkillReq(currentProjectId, name, data)),
      create: (data: any) => (isAppScope ? createAppSkillReq(data) : createSkillReq(currentProjectId, data)),
      update: (name: string, data: any) => (isAppScope ? updateAppSkillReq(name, data) : updateSkillReq(currentProjectId, name, data)),
      delete: (name: string) => (isAppScope ? deleteAppSkillReq(name) : deleteSkillReq(currentProjectId, name)),
      tools: () => (isAppScope ? getAppAvailableToolsReq() : getAvailableToolsReq(currentProjectId)),
      aiGenerate: (data: { description: string }) =>
        isAppScope ? aiGenerateAppSkillReq(data) : aiGenerateSkillReq(currentProjectId, data)
    }),
    [currentProjectId, isAppScope]
  )

  const [loading, setLoading] = useState(false)
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedSkillName, setSelectedSkillName] = useState('')
  const [skillDetail, setSkillDetail] = useState<SkillItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailToggling, setDetailToggling] = useState(false)

  const [formDialogVisible, setFormDialogVisible] = useState(false)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editingSkillName, setEditingSkillName] = useState('')
  const skillEditorRef = useRef<SkillEditorHandle>(null)

  const [availableTools, setAvailableTools] = useState<any[]>([])
  const [toolsLoading, setToolsLoading] = useState(false)

  const [formData, setFormData] = useState<SkillItem>({
    name: '',
    description: '',
    tags: [],
    allowed_tools: [],
    category: null,
    instructions: '',
    runtime: 'prompt',
    side_effect: 'read',
    requires_project: false
  })

  const normalSkills = skills
  const selectedListSkill = useMemo(
    () => normalSkills.find((skill) => skill.name === selectedSkillName) || null,
    [normalSkills, selectedSkillName]
  )
  const inspectedSkill = skillDetail?.name === selectedSkillName ? skillDetail : selectedListSkill

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return normalSkills.filter((skill) => {
      const enabled = isEnabled(skill)
      if (statusFilter === 'enabled' && !enabled) return false
      if (statusFilter === 'disabled' && enabled) return false
      if (!q) return true

      const haystack = [
        skill.name,
        skill.description,
        skill.category,
        skill.runtime,
        skill.type,
        ...(skill.tags || []),
        ...(skill.allowed_tools || [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [normalSkills, searchQuery, statusFilter])

  const stats = useMemo(() => {
    const enabled = normalSkills.filter(isEnabled).length
    const blocked = normalSkills.filter((skill) => skill.availability === 'blocked').length
    const builtin = normalSkills.filter((skill) => !!skill.builtin).length
    const overrides = normalSkills.filter((skill) => skill.enabled_override !== undefined && skill.enabled_override !== null).length
    return {
      total: normalSkills.length,
      enabled,
      disabled: normalSkills.length - enabled,
      builtin,
      custom: normalSkills.length - builtin,
      overrides,
      blocked
    }
  }, [normalSkills])

  const renderedInstructions = useMemo(
    () => sanitizeMarkdown(inspectedSkill?.instructions),
    [inspectedSkill?.instructions]
  )

  const getCategoryClass = (category?: string | null) => {
    return (
      (
        {
          research: styles.categoryResearch,
          report: styles.categoryReport,
          analysis: styles.categoryAnalysis
        } as Record<string, string>
      )[category as string] || styles.categoryDefault
    )
  }

  const getRuntimeLabel = (skill: SkillItem | null | undefined) => {
    if (!skill) return '-'
    return skill.runtime || skill.type || skill.category || 'prompt'
  }

  const getStatusText = (skill: SkillItem | null | undefined) => {
    if (!skill) return '-'
    if (skill.availability === 'blocked') return '不可用'
    return isEnabled(skill) ? '已启用' : '已关闭'
  }

  const getBindingText = (skill: SkillItem | null | undefined) => {
    if (!skill) return '-'
    if (isAppScope) return isEnabled(skill) ? 'App 默认启用' : 'App 默认关闭'
    if (skill.enabled_override === true) return '项目启用'
    if (skill.enabled_override === false) return '项目关闭'
    return isEnabled(skill) ? '继承启用' : '继承关闭'
  }

  const patchToggleFields = (skill: SkillItem, val: boolean, toggling = skill._toggling) => ({
    ...skill,
    _toggling: toggling,
    is_enabled: val,
    effective_enabled: val,
    default_enabled: isAppScope ? val : skill.default_enabled,
    enabled_override: isAppScope ? skill.enabled_override : val
  })

  const fetchSkills = async (): Promise<SkillItem[]> => {
    if (!hasScope) return []
    setLoading(true)
    try {
      const res: any = await request.list()
      const next = (res.data || []).map((s: SkillItem) => ({ ...s, _toggling: false }))
      setSkills(next)
      return next
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('skills.fetchListFailed') })
      return []
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async (skill: SkillItem, val: boolean) => {
    if (isSystemSkill(skill) && !val) {
      notifications.show({ color: 'yellow', message: '系统内置 Skill 不能关闭' })
      return
    }
    setSkills((prev) =>
      prev.map((s) => (s.name === skill.name ? patchToggleFields(s, val, true) : s))
    )
    if (skillDetail?.name === skill.name) {
      setSkillDetail((prev) => (prev ? patchToggleFields(prev, val, true) : prev))
    }
    try {
      await request.toggle(skill.name, isAppScope ? { default_enabled: val } : { enabled_override: val })
      notifications.show({
        color: 'green',
        message: `${skill.name} ${t(val ? 'skills.enabled' : 'skills.disabled')}`
      })
      setSkills((prev) =>
        prev.map((s) => (s.name === skill.name ? patchToggleFields(s, val, false) : s))
      )
      if (skillDetail?.name === skill.name) {
        setSkillDetail((prev) => (prev ? patchToggleFields(prev, val, false) : prev))
      }
    } catch (error: any) {
      await fetchSkills()
      if (skillDetail?.name === skill.name) {
        try {
          const res: any = await request.detail(skill.name)
          setSkillDetail(res.data)
        } catch {
          setSkillDetail(null)
        }
      }
      notifications.show({ color: 'red', message: error.message || t('skills.operationFailed') })
    }
  }

  const handleToggleFromDetail = async (val: boolean) => {
    if (!inspectedSkill?.name) return
    if (isSystemSkill(inspectedSkill) && !val) {
      notifications.show({ color: 'yellow', message: '系统内置 Skill 不能关闭' })
      return
    }
    setDetailToggling(true)
    try {
      await handleToggle(inspectedSkill, val)
    } finally {
      setDetailToggling(false)
    }
  }

  const handleResetProjectOverride = async () => {
    if (isAppScope || !inspectedSkill?.name) return
    if (isSystemSkill(inspectedSkill)) return
    const skillName = inspectedSkill.name
    setDetailToggling(true)
    setSkills((prev) => prev.map((s) => (s.name === skillName ? { ...s, _toggling: true } : s)))
    try {
      await request.toggle(skillName, { enabled_override: null })
      notifications.show({ color: 'green', message: `${skillName} 已恢复继承 App 默认状态` })
      await fetchSkills()
      const res: any = await request.detail(skillName)
      setSkillDetail(res.data)
    } catch (error: any) {
      await fetchSkills()
      notifications.show({ color: 'red', message: error.message || t('skills.operationFailed') })
    } finally {
      setDetailToggling(false)
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      tags: [],
      allowed_tools: [],
      category: null,
      instructions: '',
      runtime: 'prompt',
      side_effect: 'read',
      requires_project: false
    })
    setIsEditing(false)
    setEditingSkillName('')
  }

  const fetchAvailableTools = async () => {
    if (availableTools.length > 0) return
    setToolsLoading(true)
    try {
      const res: any = await request.tools()
      setAvailableTools(res.data || [])
    } catch (error) {
      console.error(t('skills.fetchToolsFailed'), error)
    } finally {
      setToolsLoading(false)
    }
  }

  const openCreateDialog = () => {
    if (!isAppScope) return
    resetForm()
    setFormDialogVisible(true)
    fetchAvailableTools()
  }

  const openEditDialog = async (skill: SkillItem) => {
    if (!isAppScope || skill.builtin) return
    try {
      const res: any = await request.detail(skill.name)
      const detail = res.data
      setFormData({
        name: detail.name,
        description: detail.description,
        tags: detail.tags || [],
        allowed_tools: detail.allowed_tools || [],
        category: detail.category || null,
        instructions: detail.instructions || '',
        runtime: detail.runtime || 'prompt',
        side_effect: detail.side_effect || 'read',
        requires_project: !!detail.requires_project
      })
      setIsEditing(true)
      setEditingSkillName(skill.name)
      setFormDialogVisible(true)
      fetchAvailableTools()
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('skills.fetchDetailFailed') })
    }
  }

  const handleFormSubmit = async () => {
    const data = skillEditorRef.current?.getFormData()
    if (!data) return

    setFormSubmitting(true)
    let targetSkillName = ''
    try {
      if (isEditing) {
        const res: any = await request.update(editingSkillName, data)
        notifications.show({ color: 'green', message: t('skills.updateSuccess') })
        targetSkillName = res?.data?.name || editingSkillName
      } else {
        const res: any = await request.create(data)
        notifications.show({ color: 'green', message: t('skills.createSuccess') })
        targetSkillName = res?.data?.name || data.name
      }
      setFormDialogVisible(false)
      const nextSkills = await fetchSkills()
      if (targetSkillName && nextSkills?.some((skill) => skill.name === targetSkillName)) {
        setSelectedSkillName(targetSkillName)
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('skills.operationFailed') })
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = (skill: SkillItem) => {
    if (!isAppScope || skill.builtin) return
    modals.openConfirmModal({
      title: t('skills.deleteTitle'),
      children: t('skills.deleteConfirm', { name: skill.name }),
      labels: { confirm: t('skills.confirmDelete'), cancel: t('skills.cancelDelete') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await request.delete(skill.name)
          notifications.show({ color: 'green', message: t('skills.deleted', { name: skill.name }) })
          if (selectedSkillName === skill.name) setSelectedSkillName('')
          await fetchSkills()
        } catch (error: any) {
          notifications.show({ color: 'red', message: error.message || t('skills.deleteFailed') })
        }
      }
    })
  }

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, skill: SkillItem) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setSelectedSkillName(skill.name)
  }

  useEffect(() => {
    if (hasScope) fetchSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasScope, request])

  useEffect(() => {
    if (!normalSkills.length) {
      setSelectedSkillName('')
      return
    }
    if (!selectedSkillName || !normalSkills.some((skill) => skill.name === selectedSkillName)) {
      setSelectedSkillName(normalSkills[0].name)
    }
  }, [normalSkills, selectedSkillName])

  useEffect(() => {
    if (!hasScope || !selectedSkillName) {
      setSkillDetail(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    request
      .detail(selectedSkillName)
      .then((res: any) => {
        if (!cancelled) setSkillDetail(res.data)
      })
      .catch((error: any) => {
        if (!cancelled) {
          setSkillDetail(null)
          notifications.show({ color: 'red', message: error.message || t('skills.fetchDetailFailed') })
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [hasScope, request, selectedSkillName, t])

  if (!hasScope) {
    return (
      <div className={styles.skillManagement}>
        <SemanticEmptyState
          icon={<ElSvgIcon name="MagicStick" size={26} color="#fff" />}
          title="需要先打开项目"
          description="项目技能页依赖当前项目上下文。"
        />
      </div>
    )
  }

  return (
    <div className={styles.skillManagement}>
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.scopeBadge}>
            <ElSvgIcon name={isAppScope ? 'SetUp' : 'MagicStick'} size={14} />
            <span>{isAppScope ? 'App 级定义' : '项目级绑定'}</span>
          </div>
          <h1>{pageTitle}</h1>
          <p>{pageDesc}</p>
        </div>
        <div className={styles.headerActions}>
          {isAppScope && (
            <Button leftSection={<ElSvgIcon name="Plus" size={16} />} onClick={openCreateDialog}>
              {t('skills.createSkill')}
            </Button>
          )}
        </div>
      </div>

      <div className={styles.summaryStrip}>
        <div className={styles.summaryItem}>
          <span>总数</span>
          <strong>{stats.total}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span>启用</span>
          <strong>{stats.enabled}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span>关闭</span>
          <strong>{stats.disabled}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span>{isAppScope ? '内置' : '项目覆盖'}</span>
          <strong>{isAppScope ? stats.builtin : stats.overrides}</strong>
        </div>
        <div className={`${styles.summaryItem} ${stats.blocked > 0 ? styles.hasWarning : ''}`}>
          <span>不可用</span>
          <strong>{stats.blocked}</strong>
        </div>
      </div>

      <div className={styles.skillWorkbench}>
        <section className={styles.listPane}>
          <div className={styles.paneToolbar}>
            <TextInput
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="搜索技能、标签或工具"
              leftSection={<ElSvgIcon name="Search" size={15} />}
              className={styles.searchInput}
            />
            <SegmentedControl
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as StatusFilter)}
              data={[
                { label: '全部', value: 'all' },
                { label: '启用', value: 'enabled' },
                { label: '关闭', value: 'disabled' }
              ]}
              className={styles.statusFilter}
            />
          </div>

          <div className={styles.listMeta}>
            <span>{filteredSkills.length} / {normalSkills.length} 个技能</span>
            {!isAppScope && <span>项目页只管理绑定状态</span>}
          </div>

          <div className={styles.skillsContent}>
            {loading ? (
              <div className={styles.loadingState}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} height={58} radius={6} />
                ))}
              </div>
            ) : normalSkills.length === 0 ? (
              <SemanticEmptyState
                icon={<ElSvgIcon name="MagicStick" size={26} color="#fff" />}
                satellites={[
                  <ElSvgIcon key="a" name="Tools" size={20} />,
                  <ElSvgIcon key="b" name="SetUp" size={20} />
                ]}
                title={t('skills.skillEmpty.title')}
                description={t('skills.skillEmpty.description')}
                features={[
                  { icon: <ElSvgIcon name="MagicStick" size={16} />, label: t('skills.skillEmpty.feature1') },
                  { icon: <ElSvgIcon name="Tools" size={16} />, label: t('skills.skillEmpty.feature2') },
                  { icon: <ElSvgIcon name="SetUp" size={16} />, label: t('skills.skillEmpty.feature3') }
                ]}
                actions={
                  isAppScope ? (
                    <Button leftSection={<ElSvgIcon name="Plus" size={16} />} onClick={openCreateDialog}>
                      {t('skills.createFirst')}
                    </Button>
                  ) : undefined
                }
              />
            ) : filteredSkills.length === 0 ? (
              <div className={styles.emptyFilter}>
                <ElSvgIcon name="Search" size={20} />
                <span>没有匹配的技能</span>
              </div>
            ) : (
              <div className={styles.skillRows}>
                {filteredSkills.map((skill) => {
                  const enabled = isEnabled(skill)
                  const selected = skill.name === selectedSkillName
                  const blocked = skill.availability === 'blocked'
                  return (
                    <div
                      key={skill.name}
                      role="button"
                      tabIndex={0}
                      className={`${styles.skillRow} ${selected ? styles.isSelected : ''} ${enabled ? styles.isEnabled : ''}`}
                      onClick={() => setSelectedSkillName(skill.name)}
                      onKeyDown={(event) => handleRowKeyDown(event, skill)}
                    >
                      <div className={`${styles.rowGlyph} ${getCategoryClass(skill.category)}`}>
                        <ElSvgIcon name="MagicStick" size={17} />
                      </div>
                      <div className={styles.rowMain}>
                        <div className={styles.rowTitleLine}>
                          <span className={styles.rowName}>{skill.name}</span>
                          {skill.builtin ? (
                            <Badge size="xs" variant="light" color="gray" radius={4}>内置</Badge>
                          ) : (
                            <Badge size="xs" variant="light" color="blue" radius={4}>自定义</Badge>
                          )}
                          {skill.requires_project && (
                            <Badge size="xs" variant="light" color="yellow" radius={4}>项目</Badge>
                          )}
                        </div>
                        <div className={styles.rowDescription}>{skill.description || '暂无描述'}</div>
                        <div className={styles.rowMeta}>
                          <span>{getRuntimeLabel(skill)}</span>
                          <span>{skill.allowed_tools?.length || 0} tools</span>
                          <span>{getBindingText(skill)}</span>
                        </div>
                      </div>
                      <div className={styles.rowState} onClick={(event) => event.stopPropagation()}>
                        <span className={`${styles.statusText} ${enabled ? styles.statusOn : styles.statusOff}`}>
                          {getStatusText(skill)}
                        </span>
                        <Switch
                          checked={enabled}
                          disabled={isSystemSkill(skill) || skill._toggling || blocked}
                          onChange={(event) => handleToggle(skill, event.currentTarget.checked)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        <aside className={styles.inspectorPane}>
          {inspectedSkill ? (
            <>
              <div className={styles.inspectorHeader}>
                <div className={styles.inspectorIdentity}>
                  <div className={`${styles.inspectorIcon} ${getCategoryClass(inspectedSkill.category)}`}>
                    <ElSvgIcon name="MagicStick" size={20} />
                  </div>
                  <div className={styles.inspectorTitleBlock}>
                    <div className={styles.inspectorName}>{inspectedSkill.name}</div>
                    <div className={styles.inspectorSubtitle}>{isAppScope ? 'App Skill Definition' : 'Project Effective Skill'}</div>
                  </div>
                </div>
                <div className={styles.inspectorActions}>
                  {isAppScope && !inspectedSkill.builtin && (
                    <>
                      <Tooltip label={t('skills.edit')}>
                        <ActionIcon variant="subtle" color="gray" onClick={() => openEditDialog(inspectedSkill)}>
                          <ElSvgIcon name="Edit" size={15} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('skills.delete')}>
                        <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(inspectedSkill)}>
                          <ElSvgIcon name="Delete" size={15} />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>

              <div className={styles.inspectorStatus}>
                <div>
                  <span>当前状态</span>
                  <strong>{getStatusText(inspectedSkill)}</strong>
                </div>
                <Switch
                  checked={isEnabled(inspectedSkill)}
                  disabled={isSystemSkill(inspectedSkill) || detailToggling || inspectedSkill.availability === 'blocked'}
                  onChange={(event) => handleToggleFromDetail(event.currentTarget.checked)}
                  onLabel="ON"
                  offLabel="OFF"
                />
              </div>

              {!isAppScope && (
                <div className={styles.bindingPanel}>
                  <div>
                    <span>项目绑定</span>
                    <strong>{getBindingText(inspectedSkill)}</strong>
                  </div>
                  {!isSystemSkill(inspectedSkill) && inspectedSkill.enabled_override !== undefined && inspectedSkill.enabled_override !== null && (
                    <Button
                      variant="default"
                      size="compact-sm"
                      loading={detailToggling}
                      onClick={handleResetProjectOverride}
                    >
                      恢复继承
                    </Button>
                  )}
                </div>
              )}

              {inspectedSkill.availability === 'blocked' && (
                <div className={styles.blockedNotice}>
                  <ElSvgIcon name="Warning" size={15} />
                  <span>{inspectedSkill.availability_reason || '该技能当前不可用'}</span>
                </div>
              )}

              <div className={styles.inspectorBody}>
                <div className={styles.descriptionBlock}>{inspectedSkill.description || '暂无描述'}</div>

                <div className={styles.detailGrid}>
                  <div>
                    <span>运行类型</span>
                    <strong>{getRuntimeLabel(inspectedSkill)}</strong>
                  </div>
                  <div>
                    <span>工具数量</span>
                    <strong>{inspectedSkill.allowed_tools?.length || 0}</strong>
                  </div>
                  <div>
                    <span>来源</span>
                    <strong>{inspectedSkill.builtin ? '内置' : '自定义'}</strong>
                  </div>
                  <div>
                    <span>依赖项目</span>
                    <strong>{inspectedSkill.requires_project ? '是' : '否'}</strong>
                  </div>
                </div>

                {inspectedSkill.tags && inspectedSkill.tags.length > 0 && (
                  <div className={styles.detailSection}>
                    <div className={styles.sectionLabel}>{t('skills.tags')}</div>
                    <div className={styles.tagsList}>
                      {inspectedSkill.tags.map((tag) => (
                        <Badge key={tag} size="sm" variant="light" color="gray" radius={4}>
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {inspectedSkill.allowed_tools && inspectedSkill.allowed_tools.length > 0 && (
                  <div className={styles.detailSection}>
                    <div className={styles.sectionLabel}>{t('skills.availableTools')}</div>
                    <div className={styles.toolsList}>
                      {inspectedSkill.allowed_tools.map((tool) => (
                        <div key={tool} className={styles.toolItem}>
                          <span className={styles.toolIcon}>
                            <ElSvgIcon name="Cpu" size={14} />
                          </span>
                          <span>{tool}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className={styles.detailSection}>
                  <div className={styles.sectionLabel}>{t('skills.instructions')}</div>
                  {detailLoading ? (
                    <div className={styles.detailLoading}>
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} height={14} radius={4} />
                      ))}
                    </div>
                  ) : renderedInstructions ? (
                    <div
                      className={styles.instructionsContent}
                      dangerouslySetInnerHTML={{ __html: renderedInstructions }}
                    />
                  ) : (
                    <div className={styles.emptyInstructions}>暂无说明</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className={styles.inspectorEmpty}>
              <ElSvgIcon name="MagicStick" size={22} />
              <span>选择一个技能查看详情</span>
            </div>
          )}
        </aside>
      </div>

      <Modal
        opened={formDialogVisible}
        onClose={() => setFormDialogVisible(false)}
        title={isEditing ? t('skills.editSkill') : t('skills.newSkill')}
        size="80%"
        onExitTransitionEnd={resetForm}
        classNames={{ content: styles.skillDialog }}
      >
        {formDialogVisible && (
          <SkillEditor
            ref={skillEditorRef}
            tools={availableTools}
            skill={isEditing ? formData : null}
            toolsLoading={toolsLoading}
            onAIGenerate={request.aiGenerate}
          />
        )}
        <div className={styles.skillDialogFooter}>
          <Button variant="default" onClick={() => setFormDialogVisible(false)}>
            {t('skills.cancel')}
          </Button>
          <Button loading={formSubmitting} onClick={handleFormSubmit}>
            {isEditing ? t('skills.save') : t('skills.create')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

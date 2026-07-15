import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Modal,
  Button,
  TextInput,
  Textarea,
  Select,
  Badge,
  ColorInput,
  ActionIcon,
  Group,
  Stack,
  Box,
  Text,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { dashboardApi } from '@/api/dashboard'
import { useProjectStore, projectGetters } from '@/store/project'
import {
  getChartTypesByGroup,
  getChartLabel,
  getAxisChartTypeIds,
  getNonAxisChartTypeIds,
  iosColors,
} from '@/utils/chartRegistry'
import FieldEditor from './FieldEditor'
import styles from './PanelEditor.module.scss'

export interface PanelEditorProps {
  visible?: boolean
  card?: any
  // 模式：'panel' 保存到Panel库，'dashboard' 编辑Dashboard中的Panel
  mode?: 'panel' | 'dashboard'
  onUpdateVisible?: (value: boolean) => void
  // panel 模式：emit('save', { data, resolve, reject })；dashboard 模式：emit('save', data)
  onSave?: (payload: any) => void
  onCancel?: () => void
}

const defaultColors = iosColors

export default function PanelEditor({
  visible = false,
  card = {},
  mode = 'panel',
  onUpdateVisible,
  onSave,
}: PanelEditorProps) {
  const { t } = useTranslation()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // 基础表单状态
  const [panelForm, setPanelForm] = useState<any>({})
  const [saving, setSaving] = useState(false)

  // 字段编辑相关（dashboard 模式）
  const [fieldEditorVisible, setFieldEditorVisible] = useState(false)
  const [currentEditingFieldIndex, setCurrentEditingFieldIndex] = useState(-1)
  const [currentEditingField, setCurrentEditingField] = useState<any>({})

  // 自定义图表配置
  const [chartOptionJson, setChartOptionJson] = useState('')

  // 系列配置（用于 bar/line 混合图表）
  const [seriesConfig, setSeriesConfig] = useState<any[]>([])
  const [pieValueField, setPieValueField] = useState('')

  // Dashboard 相关（dashboard 模式）
  const [dashboards, setDashboards] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [dashboardsLoading, setDashboardsLoading] = useState(false)
  const [createDashboardDialogVisible, setCreateDashboardDialogVisible] = useState(false)
  const [newDashboardForm, setNewDashboardForm] = useState<any>({ title: '', description: '' })

  // 表单校验错误
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [newDashboardErrors, setNewDashboardErrors] = useState<Record<string, string>>({})

  const chartGroups = useMemo(() => getChartTypesByGroup(), [])

  // ========== 初始化系列配置 ==========
  const initSeriesConfig = useCallback((card: any) => {
    // 使用 display_type 作为默认系列类型
    const defaultSeriesType = card.display_type || 'bar'

    // 如果已有 series_config，直接使用
    if (card.series_config && Array.isArray(card.series_config) && card.series_config.length > 0) {
      setSeriesConfig(
        card.series_config.map((s: any, index: number) => ({
          field: s.field || '',
          type: s.type || defaultSeriesType,
          color: s.color || defaultColors[index % defaultColors.length],
        })),
      )
      return
    }

    // 否则从 y_axis_fields 初始化
    const yFields = card.y_axis_fields || []
    if (yFields.length > 0) {
      setSeriesConfig(
        yFields.map((field: any, index: number) => ({
          field: field,
          type: defaultSeriesType,
          color: defaultColors[index % defaultColors.length],
        })),
      )
    } else {
      setSeriesConfig([])
    }
  }, [])

  // ========== 初始化表单 ==========
  const initForm = useCallback(
    (card: any) => {
      // 从 display_config 提取配置
      const displayConfig = card.display_config || {}

      const nextForm: any = {
        ...card,
        content_type: card.content_type || 'text',
        content: card.content || '',
        display_type: card.display_type || 'text',
        display_config: displayConfig,
        // 从 display_config 提取字段配置
        fields: displayConfig.fields || card.fields || [],
        x_axis_field: displayConfig.x_axis_field || card.x_axis_field || '',
        y_axis_fields: displayConfig.y_axis_fields || card.y_axis_fields || [],
        tags: [...(card.tags || [])],
        sequence_number: card.sequence_number || 1,
        dashboard_id: card.dashboard_id || '',
        source_type: displayConfig.source_type || card.source_type || '',
        source_id: displayConfig.source_id || card.source_id || '',
        series_config: displayConfig.series_config || card.series_config || null,
      }

      setPanelForm(nextForm)

      // 初始化系列配置
      initSeriesConfig(nextForm)

      // 初始化饼图数值字段
      if (nextForm.display_type === 'pie' && nextForm.y_axis_fields?.length > 0) {
        setPieValueField(nextForm.y_axis_fields[0])
      } else {
        setPieValueField('')
      }

      // 自定义图表配置初始化
      if (nextForm.display_type === 'custom' && displayConfig.chartOption) {
        try {
          setChartOptionJson(JSON.stringify(displayConfig.chartOption, null, 2))
        } catch {
          setChartOptionJson('{}')
        }
      } else {
        setChartOptionJson('{}')
      }
    },
    [initSeriesConfig],
  )

  // ========== Dashboard 相关（dashboard 模式） ==========
  const loadDashboards = useCallback(async () => {
    try {
      setDashboardsLoading(true)
      const response: any = await dashboardApi.getDashboardList(currentProjectId, {})
      if (response.data && Array.isArray(response.data.dashboards)) {
        setDashboards(response.data.dashboards)
      } else {
        setDashboards([])
      }
    } catch (error) {
      console.error('加载Dashboard列表失败:', error)
      notifications.show({ color: 'red', message: t('dashboardMgmt.editor.loadDashboardsFailed') })
      setDashboards([])
    } finally {
      setDashboardsLoading(false)
    }
  }, [currentProjectId, t])

  // 监听 card 变化（对应 watch(card, { immediate: true })）
  useEffect(() => {
    if (card) {
      initForm(card)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card])

  // 监听 visible（对应 watch(visible)）
  useEffect(() => {
    if (visible) {
      if (mode === 'dashboard') {
        loadDashboards()
      }
      if (card) {
        initForm(card)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // 组件挂载（对应 onMounted）
  useEffect(() => {
    if (visible && mode === 'dashboard') {
      loadDashboards()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ========== 计算属性 ==========
  const dialogTitle = useMemo(() => {
    if (mode === 'panel') {
      return t('dashboardMgmt.editor.saveToPanelLib')
    }
    return panelForm.id ? t('dashboardMgmt.editor.editPanel') : t('dashboardMgmt.editor.addToDashboard')
  }, [mode, panelForm.id, t])

  const formTypeLabel = useMemo(() => {
    const staticLabels: Record<string, string> = {
      table: t('dashboardMgmt.editor.displayTable'),
      text: t('dashboardMgmt.editor.displayText'),
      custom: t('dashboardMgmt.editor.displayCustom'),
    }
    return (
      staticLabels[panelForm.display_type] ||
      getChartLabel(panelForm.display_type) ||
      t('dashboardMgmt.panelLib.typeUnknown')
    )
  }, [panelForm.display_type, t])

  const availableFields = useMemo(() => panelForm.fields || [], [panelForm.fields])

  const showAxisConfig = useMemo(
    () => getAxisChartTypeIds().has(panelForm.display_type),
    [panelForm.display_type],
  )

  // ========== 通用方法 ==========
  // 关闭对话框
  const handleClose = () => {
    onUpdateVisible?.(false)
  }

  // ========== 系列配置相关 ==========
  // 添加系列
  const addSeries = () => {
    setSeriesConfig((prev) => {
      const index = prev.length
      return [
        ...prev,
        {
          field: '',
          type: panelForm.form_type || 'bar',
          color: defaultColors[index % defaultColors.length],
        },
      ]
    })
  }

  // 删除系列
  const removeSeries = (index: number) => {
    setSeriesConfig((prev) => {
      const next = prev.filter((_, i) => i !== index)
      // 同步 y_axis_fields
      setPanelForm((form: any) => ({
        ...form,
        y_axis_fields: next.filter((s) => s.field).map((s) => s.field),
      }))
      return next
    })
  }

  // 更新 y_axis_fields（从 seriesConfig 同步）
  const updateYAxisFields = (nextSeries?: any[]) => {
    const list = nextSeries || seriesConfig
    setPanelForm((form: any) => ({
      ...form,
      y_axis_fields: list.filter((s) => s.field).map((s) => s.field),
    }))
  }

  // 更新单个系列字段
  const updateSeriesItem = (index: number, key: string, value: any) => {
    setSeriesConfig((prev) => {
      const next = prev.map((s, i) => (i === index ? { ...s, [key]: value } : s))
      if (key === 'field') {
        // field 变化时同步 y_axis_fields
        setPanelForm((form: any) => ({
          ...form,
          y_axis_fields: next.filter((s) => s.field).map((s) => s.field),
        }))
      }
      return next
    })
  }

  // ========== 字段编辑相关（dashboard 模式） ==========
  const editField = (index: number) => {
    if (mode !== 'dashboard') return
    setCurrentEditingFieldIndex(index)
    setCurrentEditingField({ ...panelForm.fields[index] })
    setFieldEditorVisible(true)
  }

  const saveField = (field: any) => {
    setPanelForm((form: any) => {
      const fields = [...(form.fields || [])]
      if (currentEditingFieldIndex === -1) {
        fields.push(field)
      } else {
        fields[currentEditingFieldIndex] = field
      }
      return { ...form, fields }
    })
    setCurrentEditingFieldIndex(-1)
  }

  const cancelEditField = () => {
    setCurrentEditingFieldIndex(-1)
  }

  // ========== 自定义图表配置（dashboard 模式） ==========
  // 注意：使用一个可变引用以便 validateChartOption 在校验过程中规整化 chartOptionJson
  const validateChartOption = (): boolean => {
    if (!chartOptionJson.trim()) {
      notifications.show({ color: 'yellow', message: t('dashboardMgmt.editor.chartConfigRequired') })
      return false
    }

    try {
      const parsed = JSON.parse(chartOptionJson)
      if (typeof parsed !== 'object' || parsed === null) {
        notifications.show({ color: 'red', message: t('dashboardMgmt.editor.chartConfigMustBeObject') })
        return false
      }
      notifications.show({ color: 'green', message: t('dashboardMgmt.editor.chartConfigValid') })
      return true
    } catch {
      try {
        const jsCode = `(${chartOptionJson})`
        // eslint-disable-next-line no-new-func
        const parsed = new Function(`return ${jsCode}`)()

        if (typeof parsed !== 'object' || parsed === null) {
          notifications.show({ color: 'red', message: t('dashboardMgmt.editor.chartConfigMustBeObject') })
          return false
        }

        setChartOptionJson(JSON.stringify(parsed, null, 2))
        notifications.show({ color: 'green', message: t('dashboardMgmt.editor.chartConfigJsParsed') })
        return true
      } catch (jsError: any) {
        notifications.show({
          color: 'red',
          message: t('dashboardMgmt.editor.chartConfigParseFailed') + jsError.message,
        })
        return false
      }
    }
  }

  const showCreateDashboardDialog = () => {
    setNewDashboardForm({ title: '', description: '' })
    setNewDashboardErrors({})
    setCreateDashboardDialogVisible(true)
  }

  const createNewDashboard = async () => {
    // 校验 title 必填
    if (!newDashboardForm.title || !newDashboardForm.title.trim()) {
      setNewDashboardErrors({ title: t('dashboardMgmt.editor.dashboardNameRequired') })
      return
    }
    setNewDashboardErrors({})
    try {
      const response: any = await dashboardApi.createDashboard(currentProjectId, newDashboardForm)

      if (response.data) {
        const newDashboard = {
          id: response.data.id,
          dashboard_id: response.data.id,
          title: response.data.title,
          description: response.data.description,
          updated_at: response.data.updated_at || new Date().toISOString(),
        }

        setDashboards((prev) => [newDashboard, ...prev])
        setPanelForm((form: any) => ({ ...form, dashboard_id: newDashboard.id }))

        notifications.show({ color: 'green', message: t('dashboardMgmt.editor.dashboardCreated') })
        setCreateDashboardDialogVisible(false)
      }
    } catch (error) {
      console.error('创建Dashboard失败:', error)
      notifications.show({ color: 'red', message: t('dashboardMgmt.editor.dashboardCreateFailed') })
    }
  }

  // ========== 保存 ==========
  // 构建保存数据
  const buildSaveData = () => {
    const data: any = { ...panelForm }

    // 确保必要字段存在
    data.content_type = data.content_type || 'text'
    data.content = data.content || ''
    data.display_type = data.display_type || 'text'

    // 构建 display_config
    const displayConfig: any = {
      fields: data.fields || [],
      x_axis_field: data.x_axis_field || '',
      y_axis_fields: data.y_axis_fields || [],
      source_type: data.source_type,
      source_id: data.source_id,
    }

    // 处理系列配置（有轴的图表类型）
    if (getAxisChartTypeIds().has(data.display_type)) {
      // 过滤有效的系列配置
      const validSeries = seriesConfig.filter((s) => s.field)
      displayConfig.series_config = validSeries
      displayConfig.y_axis_fields = validSeries.map((s) => s.field)
    }

    // 处理饼图及类似图表（无轴图表）
    if (getNonAxisChartTypeIds().has(data.display_type)) {
      displayConfig.y_axis_fields = pieValueField ? [pieValueField] : []
    }

    // 处理自定义图表
    if (data.display_type === 'custom' && chartOptionJson) {
      try {
        displayConfig.chartOption = JSON.parse(chartOptionJson)
      } catch {
        displayConfig.chartOption = {}
      }
    }

    data.display_config = displayConfig

    return data
  }

  // 处理内容类型变化
  const handleContentTypeChange = (value: string | null) => {
    // 根据内容类型自动设置合适的展示类型
    const defaultDisplayTypes: Record<string, string> = {
      sql: 'table',
      json: 'custom',
      text: 'text',
      markdown: 'text',
      html: 'text',
      chat: 'text',
    }

    setPanelForm((form: any) => {
      const next = { ...form, content_type: value }
      if (value && defaultDisplayTypes[value]) {
        next.display_type = defaultDisplayTypes[value]
      }
      // 清空内容，让用户重新输入
      next.content = ''
      return next
    })
  }

  // 处理展示类型变化
  const handleDisplayTypeChange = (value: string | null) => {
    setPanelForm((form: any) => ({ ...form, display_type: value }))
  }

  const handleSave = async () => {
    // panel 模式：SQL 修改后必须校验（SQL编辑功能暂时禁用）
    // if (mode === 'panel' && sqlModified && !sqlValidated) {
    //   notifications.show({ color: 'yellow', message: 'SQL 已修改，请先校验' })
    //   return
    // }

    let chartOption: any = {}
    // 验证自定义图表配置
    if (panelForm.form_type === 'custom') {
      if (!validateChartOption()) {
        return
      }
      try {
        chartOption = JSON.parse(chartOptionJson)
      } catch {
        try {
          const jsCode = `(${chartOptionJson})`
          // eslint-disable-next-line no-new-func
          chartOption = new Function(`return ${jsCode}`)()
        } catch (jsError: any) {
          notifications.show({
            color: 'red',
            message: t('dashboardMgmt.editor.chartConfigParseFailed') + jsError.message,
          })
          return
        }
      }
    } else {
      chartOption = {}
    }

    // 表单校验（对应 panelFormRef.validate()）
    const nextErrors: Record<string, string> = {}
    if (mode === 'dashboard' && !panelForm.dashboard_id) {
      nextErrors.dashboard_id = t('dashboardMgmt.editor.dashboardRequired')
    }
    if (!panelForm.title || !String(panelForm.title).trim()) {
      nextErrors.title = t('dashboardMgmt.editor.nameRequired')
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    try {
      setSaving(true)

      // 将 chartOption 合入表单（对应 panelForm.value.chartOption = ...）
      const formWithOption = { ...panelForm, chartOption }
      setPanelForm(formWithOption)

      const saveData = { ...buildSaveData(), chartOption }

      if (mode === 'panel') {
        // panel 模式：通过 Promise 等待父组件保存完成
        await new Promise((resolve, reject) => {
          onSave?.({
            data: saveData,
            resolve,
            reject,
          })
        })
      } else {
        // dashboard 模式：直接 emit
        onSave?.(saveData)
      }

      onUpdateVisible?.(false)
    } catch (error) {
      console.error('保存失败:', error)
    } finally {
      setSaving(false)
    }
  }

  // ========== 派生：展示类型下拉数据（含分组） ==========
  const displayTypeData = useMemo(() => {
    const data: any[] = [
      { value: 'table', label: t('dashboardMgmt.editor.displayTable') },
      { value: 'text', label: t('dashboardMgmt.editor.displayText') },
    ]
    for (const g of chartGroups) {
      data.push({
        group: g.label,
        items: g.types.map((ct: any) => ({ value: ct.id, label: ct.label })),
      })
    }
    data.push({ value: 'custom', label: t('dashboardMgmt.editor.displayCustom') })
    return data
  }, [chartGroups, t])

  const contentTypeData = useMemo(
    () => [
      { value: 'sql', label: t('dashboardMgmt.editor.contentSql') },
      { value: 'json', label: t('dashboardMgmt.editor.contentJson') },
      { value: 'text', label: t('dashboardMgmt.editor.contentText') },
      { value: 'markdown', label: 'Markdown' },
      { value: 'html', label: 'HTML' },
      { value: 'chat', label: t('dashboardMgmt.editor.contentChat') },
    ],
    [t],
  )

  const fieldOptions = useMemo(
    () =>
      (availableFields || []).map((field: any) => ({
        value: field.expression,
        label: field.alias,
      })),
    [availableFields],
  )

  const dashboardOptions = useMemo(
    () =>
      (dashboards || []).map((dashboard: any) => ({
        value: String(dashboard.id || dashboard.dashboard_id),
        label: dashboard.title,
      })),
    [dashboards],
  )

  const isNonAxisChart =
    getNonAxisChartTypeIds().has(panelForm.display_type) && (mode === 'dashboard' || mode === 'panel')

  return (
    <Modal
      opened={visible}
      onClose={handleClose}
      title={dialogTitle}
      size="80%"
      centered={false}
      styles={{ content: { marginTop: '10vh' } }}
      classNames={{ content: styles.panelDialog }}
    >
      <Stack gap="md">
        {/* Dashboard选择（仅 dashboard 模式） */}
        {mode === 'dashboard' && (
          <Box>
            <Box className={styles.dashboardSelectContainer}>
              <Select
                label="Dashboard"
                withAsterisk
                placeholder={t('dashboardMgmt.editor.dashboardPlaceholder')}
                style={{ width: 300 }}
                disabled={!!panelForm.id}
                data={dashboardOptions}
                value={panelForm.dashboard_id ? String(panelForm.dashboard_id) : null}
                error={errors.dashboard_id}
                onChange={(value) =>
                  setPanelForm((form: any) => ({ ...form, dashboard_id: value }))
                }
              />
              {!panelForm.id && (
                <Button
                  variant="filled"
                  size="xs"
                  onClick={showCreateDashboardDialog}
                  style={{ marginLeft: 10, alignSelf: 'flex-end' }}
                  leftSection={<IconPlus size={14} />}
                >
                  {t('dashboardMgmt.editor.newDashboard')}
                </Button>
              )}
            </Box>
          </Box>
        )}

        {/* Panel名称 */}
        <TextInput
          label={t('dashboardMgmt.editor.name')}
          withAsterisk
          placeholder={t('dashboardMgmt.editor.namePlaceholder')}
          value={panelForm.title || ''}
          error={errors.title}
          onChange={(e) => setPanelForm((form: any) => ({ ...form, title: e.currentTarget.value }))}
        />

        {/* 内容类型（Panel库模式） */}
        {mode === 'panel' && (
          <Select
            label={t('dashboardMgmt.editor.contentType')}
            placeholder={t('dashboardMgmt.editor.contentTypePlaceholder')}
            style={{ width: 200 }}
            data={contentTypeData}
            value={panelForm.content_type || null}
            onChange={handleContentTypeChange}
          />
        )}

        {/* 展示类型 */}
        <Box>
          <Text size="sm" fw={500} mb={4}>
            {t('dashboardMgmt.editor.displayType')}
          </Text>
          {mode === 'dashboard' || mode === 'panel' ? (
            <Select
              placeholder={t('dashboardMgmt.editor.displayTypePlaceholder')}
              style={{ width: 200 }}
              data={displayTypeData}
              value={panelForm.display_type || null}
              onChange={handleDisplayTypeChange}
            />
          ) : (
            <Badge color="gray" size="lg">
              {formTypeLabel}
            </Badge>
          )}
        </Box>

        {/* 内容编辑区（Panel库模式） */}
        {mode === 'panel' && (
          <Box>
            <Text size="sm" fw={500} mb={4}>
              {t('dashboardMgmt.editor.content')}
            </Text>
            {/* SQL编辑器 */}
            {panelForm.content_type === 'sql' && (
              <Box className={styles.sqlEditorContainer}>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={8}
                  placeholder={t('dashboardMgmt.editor.sqlPlaceholder')}
                  styles={{ input: { fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace" } }}
                  value={panelForm.content || ''}
                  onChange={(e) =>
                    setPanelForm((form: any) => ({ ...form, content: e.currentTarget.value }))
                  }
                />
              </Box>
            )}
            {/* 代码编辑器（JSON） */}
            {panelForm.content_type === 'json' && (
              <Box className={styles.codeEditorContainer}>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={8}
                  placeholder={t('dashboardMgmt.editor.jsonPlaceholder')}
                  styles={{ input: { fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace" } }}
                  value={panelForm.content || ''}
                  onChange={(e) =>
                    setPanelForm((form: any) => ({ ...form, content: e.currentTarget.value }))
                  }
                />
              </Box>
            )}
            {/* Markdown编辑器 */}
            {panelForm.content_type === 'markdown' && (
              <Box className={styles.markdownEditorContainer}>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={8}
                  placeholder={t('dashboardMgmt.editor.markdownPlaceholder')}
                  value={panelForm.content || ''}
                  onChange={(e) =>
                    setPanelForm((form: any) => ({ ...form, content: e.currentTarget.value }))
                  }
                />
              </Box>
            )}
            {/* HTML编辑器 */}
            {panelForm.content_type === 'html' && (
              <Box className={styles.htmlEditorContainer}>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={8}
                  placeholder={t('dashboardMgmt.editor.htmlPlaceholder')}
                  value={panelForm.content || ''}
                  onChange={(e) =>
                    setPanelForm((form: any) => ({ ...form, content: e.currentTarget.value }))
                  }
                />
              </Box>
            )}
            {/* 文本编辑器 */}
            {panelForm.content_type === 'text' && (
              <Box className={styles.textEditorContainer}>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={8}
                  placeholder={t('dashboardMgmt.editor.textPlaceholder')}
                  value={panelForm.content || ''}
                  onChange={(e) =>
                    setPanelForm((form: any) => ({ ...form, content: e.currentTarget.value }))
                  }
                />
              </Box>
            )}
            {/* 其他类型 */}
            {!['sql', 'json', 'markdown', 'html', 'text'].includes(panelForm.content_type) && (
              <Box className={styles.textEditorContainer}>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={8}
                  placeholder={t('dashboardMgmt.editor.contentPlaceholder')}
                  value={panelForm.content || ''}
                  onChange={(e) =>
                    setPanelForm((form: any) => ({ ...form, content: e.currentTarget.value }))
                  }
                />
              </Box>
            )}
          </Box>
        )}

        {/* 字段列表 */}
        <Box>
          <Text size="sm" fw={500} mb={4}>
            {t('dashboardMgmt.editor.fields')}
          </Text>
          <Box className={styles.fieldsContainer}>
            {mode === 'dashboard'
              ? (panelForm.fields || []).map((field: any, index: number) => (
                  <Badge
                    key={index}
                    color="gray"
                    variant="filled"
                    className={styles.elCheckTag}
                    style={{ cursor: 'pointer' }}
                    onClick={() => editField(index)}
                  >
                    {field.alias}
                  </Badge>
                ))
              : (panelForm.fields || []).map((field: any, index: number) => (
                  <Badge key={index} color="gray">
                    {field.alias}
                  </Badge>
                ))}
          </Box>
        </Box>

        {/* 横轴/纵轴配置（图表类型时显示） */}
        {showAxisConfig && (
          <>
            <Box>
              <Text size="sm" fw={500} mb={4}>
                {t('dashboardMgmt.editor.xAxis')}
              </Text>
              <Select
                placeholder={t('dashboardMgmt.editor.xAxisPlaceholder')}
                style={{ width: 200 }}
                data={fieldOptions}
                value={panelForm.x_axis_field || null}
                onChange={(value) =>
                  setPanelForm((form: any) => ({ ...form, x_axis_field: value }))
                }
              />
            </Box>

            {/* 纵轴系列配置 */}
            <Box>
              <Text size="sm" fw={500} mb={4}>
                {t('dashboardMgmt.editor.yAxis')}
              </Text>
              <Box className={styles.seriesConfig}>
                {seriesConfig.map((series, index) => (
                  <Box key={index} className={styles.seriesItem}>
                    <Select
                      placeholder={t('dashboardMgmt.editor.selectField')}
                      style={{ width: 150 }}
                      data={fieldOptions}
                      value={series.field || null}
                      onChange={(value) => updateSeriesItem(index, 'field', value)}
                    />
                    <Select
                      placeholder={t('dashboardMgmt.editor.chartType')}
                      style={{ width: 100, marginLeft: 8 }}
                      data={[
                        { value: 'bar', label: t('dashboardMgmt.editor.displayBar') },
                        { value: 'line', label: t('dashboardMgmt.editor.displayLine') },
                      ]}
                      value={series.type || null}
                      onChange={(value) => updateSeriesItem(index, 'type', value)}
                    />
                    <ColorInput
                      size="xs"
                      style={{ width: 120, marginLeft: 8 }}
                      value={series.color || ''}
                      onChange={(value) => updateSeriesItem(index, 'color', value)}
                    />
                    <ActionIcon
                      color="red"
                      variant="filled"
                      radius="xl"
                      size="sm"
                      style={{ marginLeft: 8 }}
                      onClick={() => removeSeries(index)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Box>
                ))}
                <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={addSeries}>
                  {t('dashboardMgmt.editor.addSeries')}
                </Button>
              </Box>
            </Box>
          </>
        )}

        {/* 饼图配置 */}
        {isNonAxisChart && (
          <>
            <Box>
              <Text size="sm" fw={500} mb={4}>
                {t('dashboardMgmt.editor.nameField')}
              </Text>
              <Select
                placeholder={t('dashboardMgmt.editor.nameFieldPlaceholder')}
                style={{ width: 200 }}
                data={fieldOptions}
                value={panelForm.x_axis_field || null}
                onChange={(value) =>
                  setPanelForm((form: any) => ({ ...form, x_axis_field: value }))
                }
              />
            </Box>
            <Box>
              <Text size="sm" fw={500} mb={4}>
                {t('dashboardMgmt.editor.valueField')}
              </Text>
              <Select
                placeholder={t('dashboardMgmt.editor.valueFieldPlaceholder')}
                style={{ width: 200 }}
                data={fieldOptions}
                value={pieValueField || null}
                onChange={(value) => setPieValueField(value || '')}
              />
            </Box>
          </>
        )}

        {/* 自定义图表配置（类型为 custom） */}
        {panelForm.form_type === 'custom' && (
          <Box>
            <Text size="sm" fw={500} mb={4}>
              {t('dashboardMgmt.editor.chartConfig')}
            </Text>
            <Box className={styles.customChartConfig}>
              <Textarea
                autosize
                minRows={8}
                placeholder={t('dashboardMgmt.editor.chartConfigPlaceholder')}
                style={{ width: '100%' }}
                styles={{
                  input: {
                    fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace",
                    fontSize: 12,
                    lineHeight: 1.5,
                  },
                }}
                value={chartOptionJson}
                onChange={(e) => setChartOptionJson(e.currentTarget.value)}
              />
              <span className={styles.configHint}>{t('dashboardMgmt.editor.chartConfigHint')}</span>
              <Box style={{ marginTop: 8 }}>
                <Button variant="filled" size="xs" onClick={validateChartOption}>
                  {t('dashboardMgmt.editor.validateConfig')}
                </Button>
              </Box>
            </Box>
          </Box>
        )}
      </Stack>

      {/* 字段编辑对话框（仅 dashboard 模式） */}
      {mode === 'dashboard' && (
        <FieldEditor
          visible={fieldEditorVisible}
          field={currentEditingField}
          onUpdateVisible={setFieldEditorVisible}
          onSave={saveField}
          onCancel={cancelEditField}
        />
      )}

      {/* 新建Dashboard对话框（仅 dashboard 模式） */}
      {mode === 'dashboard' && (
        <Modal
          opened={createDashboardDialogVisible}
          onClose={() => setCreateDashboardDialogVisible(false)}
          title={t('dashboardMgmt.editor.newDashboardTitle')}
          size={500}
          centered
        >
          <Stack gap="md">
            <TextInput
              label={t('dashboardMgmt.editor.dashboardName')}
              withAsterisk
              placeholder={t('dashboardMgmt.editor.dashboardNamePlaceholder')}
              value={newDashboardForm.title || ''}
              error={newDashboardErrors.title}
              onChange={(e) =>
                setNewDashboardForm((form: any) => ({ ...form, title: e.currentTarget.value }))
              }
            />
            <Textarea
              label={t('dashboardMgmt.description')}
              placeholder={t('dashboardMgmt.descPlaceholder')}
              value={newDashboardForm.description || ''}
              onChange={(e) =>
                setNewDashboardForm((form: any) => ({ ...form, description: e.currentTarget.value }))
              }
            />
          </Stack>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setCreateDashboardDialogVisible(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="filled" onClick={createNewDashboard}>
              {t('common.confirm')}
            </Button>
          </Group>
        </Modal>
      )}

      {/* footer */}
      <Group justify="flex-end" gap={12} mt="md" className={styles.dialogFooter}>
        <Button variant="default" onClick={handleClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="filled" loading={saving} onClick={handleSave}>
          {t('common.save')}
        </Button>
      </Group>
    </Modal>
  )
}

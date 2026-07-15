import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Select,
  Tooltip,
  Menu,
  Modal,
  Collapse,
  LoadingOverlay,
  UnstyledButton
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconRefresh,
  IconPencil,
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconSettings,
  IconHelpCircleFilled,
  IconEdit
} from '@tabler/icons-react'
import { useResponsive } from '@/hooks/use-responsive'
import { getAgentTypesConfig, getAgentConfig, saveAgentConfig } from '@/api/agent'
import { llmModelsReq, getActiveLLMModelReq } from '@/api/models'
import styles from './AgentSettings.module.scss'

// Props
export interface AgentSettingsProps {
  projectId?: string
  businessId?: string
}

// Agent 数据结构（对齐源 reactive agentData）
interface AgentData {
  id: string
  agent_type: string
  model_id: string
  system_prompt: string
  user_prompt_template: string
  rules: string
  // 默认配置（用于重置）
  default_system_prompt: string
  default_user_prompt_template: string
  default_rules: string
}

// 编辑弹窗状态
interface EditorDialogState {
  visible: boolean
  field: keyof AgentData | ''
  title: string
  content: string
}

const initialAgentData: AgentData = {
  id: '',
  agent_type: '',
  model_id: '',
  system_prompt: '',
  user_prompt_template: '',
  rules: '',
  default_system_prompt: '',
  default_user_prompt_template: '',
  default_rules: ''
}

export default function AgentSettings({ projectId = '', businessId = '' }: AgentSettingsProps) {
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // ElMessageBox.confirm → modals.openConfirmModal 包成 Promise，保持原 try/catch 流
  const confirmAsync = (options: {
    title: string
    message: string
    confirmLabel: string
    cancelLabel: string
  }): Promise<void> =>
    new Promise((resolve, reject) => {
      modals.openConfirmModal({
        title: options.title,
        children: options.message,
        labels: { confirm: options.confirmLabel, cancel: options.cancelLabel },
        confirmProps: { color: 'orange' },
        onConfirm: () => resolve(),
        onCancel: () => reject()
      })
    })

  // 组件状态
  const [loading, setLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_configLoading, setConfigLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [currentAgent, setCurrentAgent] = useState<any>(null)
  const [advancedExpanded, setAdvancedExpanded] = useState(false)

  // 编辑弹窗状态
  const editorInputRef = useRef<HTMLTextAreaElement>(null)
  const [editorDialog, setEditorDialog] = useState<EditorDialogState>({
    visible: false,
    field: '',
    title: '',
    content: ''
  })

  // Agent类型配置（从后端获取）
  const [agentTypesConfig, setAgentTypesConfig] = useState<any[]>([])

  // 可用模型
  const [availableModels, setAvailableModels] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_defaultModel, setDefaultModel] = useState<any>(null)

  // Agent数据
  const [agentData, setAgentData] = useState<AgentData>({ ...initialAgentData })

  // 根据 Agent 类型显示不同的业务规则提示（从后端配置读取）
  const getLocalizedAgentText = (agentType: any, field: string, fallback = '') => {
    if (!agentType) return fallback
    const key = `database.agentSettings.types.${agentType}.${field}`
    const translated = t(key)
    return translated === key ? fallback : translated
  }

  const getLocalizedAgentName = (config: any) => {
    return getLocalizedAgentText(config?.agent_type, 'name', config?.name || t('database.agentSettings.agentConfig'))
  }

  const getLocalizedAgentDescription = (config: any) => {
    return getLocalizedAgentText(
      config?.agent_type,
      'description',
      config?.description || t('database.agentSettings.noDescription')
    )
  }

  const getCurrentAgentTitle = () => {
    if (!currentAgent) return t('database.agentSettings.agentConfig')
    return getLocalizedAgentName(currentAgent)
  }

  const getLocalizedModeLabel = (mode: any) => {
    if (!mode?.value) return mode?.label || ''
    const key = `database.agentSettings.modes.${mode.value}.label`
    const translated = t(key)
    return translated === key ? mode?.label || '' : translated
  }

  const getLocalizedModeDescription = (mode: any) => {
    if (!mode?.value) return mode?.description || ''
    const key = `database.agentSettings.modes.${mode.value}.description`
    const translated = t(key)
    return translated === key ? mode?.description || '' : translated
  }

  const rulesEmptyHint = useMemo(() => {
    const localizedHint = getLocalizedAgentText(currentAgent?.agent_type, 'rulesHint', '')
    if (localizedHint) return localizedHint
    return currentAgent?.rules_hint || t('database.agentSettings.defaultRulesHint')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAgent, t])

  // 加载Agent配置
  const loadAgentConfig = async (agentType?: string) => {
    const type = agentType ?? agentData.agent_type
    if (!projectId || !businessId || !type) return

    setConfigLoading(true)
    try {
      const res = await getAgentConfig(projectId, type)
      const data = res.data
      if (data) {
        setAgentData((prev) => ({
          ...prev,
          id: data.id || '',
          agent_type: data.agent_type,
          model_id: data.model_id || '',
          system_prompt: data.system_prompt || '',
          user_prompt_template: data.user_prompt_template || '',
          rules: data.rules || '',
          // 默认配置（用于重置）
          default_system_prompt: data.default_system_prompt || '',
          default_user_prompt_template: data.default_user_prompt_template || '',
          default_rules: data.default_rules || ''
        }))
      }
    } catch (error) {
      console.error('Failed to load agent config:', error)
    } finally {
      setConfigLoading(false)
    }
  }

  // 点击卡片进入编辑模式
  const handleEditAgent = async (config: any) => {
    setCurrentAgent(config)
    setAgentData((prev) => ({ ...prev, agent_type: config.agent_type }))
    setEditMode(true)
    await loadAgentConfig(config.agent_type)
  }

  // 返回列表
  const handleBack = () => {
    setEditMode(false)
    setCurrentAgent(null)
  }

  // 保存当前配置（通用保存方法）
  // 接收最新的 agentData 快照，避免 setState 异步导致的脏读
  const saveCurrentConfig = async (data: AgentData) => {
    // 检查：如果有规则但 system prompt 中没有 {rules} 占位符
    if (data.rules && data.rules.trim() && !data.system_prompt.includes('{rules}')) {
      try {
        await confirmAsync({
          title: t('database.agentSettings.hint'),
          message: t('database.agentSettings.noRulesPlaceholder'),
          confirmLabel: t('database.agentSettings.continueSave'),
          cancelLabel: t('database.action.cancel')
        })
      } catch {
        return // 用户取消
      }
    }

    setSaving(true)
    try {
      await saveAgentConfig(projectId, {
        name: currentAgent?.name || data.agent_type,
        agent_type: data.agent_type,
        business_id: businessId,
        model_id: data.model_id || null,
        system_prompt: data.system_prompt,
        user_prompt_template: data.user_prompt_template,
        rules: data.rules
      })
      notifications.show({ color: 'green', message: t('database.agentSettings.saveSuccess') })
      await loadAgentConfig(data.agent_type)
    } catch (error: any) {
      console.error('Failed to save agent config:', error)
      notifications.show({ color: 'red', message: error?.detail || t('database.agentSettings.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  // 通过下拉选择默认模板替换 System Prompt
  const handleResetWithTemplate = async (templateAgentType: any) => {
    try {
      await confirmAsync({
        title: t('database.agentSettings.resetTemplateTitle'),
        message: t('database.agentSettings.resetTemplateConfirm'),
        confirmLabel: t('database.action.confirm'),
        cancelLabel: t('database.action.cancel')
      })
    } catch {
      return
    }

    try {
      const res = await getAgentConfig(projectId, templateAgentType)
      const templateData = res.data
      if (templateData) {
        const next = {
          ...agentData,
          system_prompt: templateData.default_system_prompt || templateData.system_prompt || ''
        }
        setAgentData(next)
        await saveCurrentConfig(next)
      }
    } catch (error) {
      console.error('Failed to load template:', error)
      notifications.show({ color: 'red', message: t('database.agentSettings.loadTemplateFailed') })
    }
  }

  // 打开编辑弹窗
  const openEditor = (field: keyof AgentData, title: string, content: string) => {
    setEditorDialog({ field, title, content, visible: true })
  }

  // 确认编辑并保存
  const confirmEditor = async () => {
    const field = editorDialog.field
    if (!field) return
    const next = { ...agentData, [field]: editorDialog.content }
    setAgentData(next)
    setEditorDialog((prev) => ({ ...prev, visible: false }))
    await saveCurrentConfig(next)
  }

  // 模型选择变化时自动保存
  const handleModelChange = async (value: string | null) => {
    const next = { ...agentData, model_id: value || '' }
    setAgentData(next)
    await saveCurrentConfig(next)
  }

  // 重置System Prompt到默认值
  const resetSystemPrompt = async () => {
    try {
      await confirmAsync({
        title: t('database.agentSettings.resetSystemPromptTitle'),
        message: t('database.agentSettings.resetSystemPromptConfirm'),
        confirmLabel: t('database.action.confirm'),
        cancelLabel: t('database.action.cancel')
      })
      const next = { ...agentData, system_prompt: agentData.default_system_prompt }
      setAgentData(next)
      await saveCurrentConfig(next)
    } catch {
      // 用户取消
    }
  }

  // 重置Rules到默认值
  const resetRules = async () => {
    try {
      await confirmAsync({
        title: t('database.agentSettings.resetRulesTitle'),
        message: t('database.agentSettings.resetRulesConfirm'),
        confirmLabel: t('database.action.confirm'),
        cancelLabel: t('database.action.cancel')
      })
      const next = { ...agentData, rules: agentData.default_rules }
      setAgentData(next)
      await saveCurrentConfig(next)
    } catch {
      // 用户取消
    }
  }

  // 重置User Prompt到默认值
  const resetUserPrompt = async () => {
    try {
      await confirmAsync({
        title: t('database.agentSettings.resetUserPromptTitle'),
        message: t('database.agentSettings.resetUserPromptConfirm'),
        confirmLabel: t('database.action.confirm'),
        cancelLabel: t('database.action.cancel')
      })
      const next = { ...agentData, user_prompt_template: agentData.default_user_prompt_template }
      setAgentData(next)
      await saveCurrentConfig(next)
    } catch {
      // 用户取消
    }
  }

  // 加载Agent类型配置
  const loadAgentTypesConfig = async () => {
    setLoading(true)
    try {
      const res = await getAgentTypesConfig()
      setAgentTypesConfig(res.data || [])
    } catch (error) {
      console.error('Failed to load agent types config:', error)
    } finally {
      setLoading(false)
    }
  }

  // 加载可用模型
  const loadAvailableModels = async () => {
    try {
      const res = await llmModelsReq({ category: 'PRIMARY' })
      setAvailableModels(res.data?.items || [])
    } catch (error) {
      console.error('Failed to load models:', error)
    }
  }

  // 加载默认激活模型
  const loadDefaultModel = async () => {
    try {
      const res = await getActiveLLMModelReq('PRIMARY')
      setDefaultModel(res.data || null)
    } catch (error) {
      console.error('Failed to load default model:', error)
    }
  }

  // 初始化（onMounted）
  useEffect(() => {
    Promise.all([loadAgentTypesConfig(), loadAvailableModels(), loadDefaultModel()])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听projectId和businessId变化（watch）
  useEffect(() => {
    if (projectId && businessId) {
      // 如果在编辑模式，重新加载配置
      if (editMode && agentData.agent_type) {
        loadAgentConfig()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, businessId])

  // 编辑弹窗打开后聚焦 textarea
  useEffect(() => {
    if (editorDialog.visible) {
      requestAnimationFrame(() => editorInputRef.current?.focus())
    }
  }, [editorDialog.visible])

  return (
    <div className={styles['agent-settings']}>
      {/* 卡片列表视图 */}
      {!editMode ? (
        <div className={styles['agent-card-grid']} style={{ position: 'relative' }}>
          <LoadingOverlay visible={loading} />
          {agentTypesConfig.map((config) => (
            <div
              key={config.agent_type}
              className={styles['agent-card']}
              onClick={() => handleEditAgent(config)}
            >
              <div className={styles['grid-card-header']}>
                <div className={styles['grid-card-title']}>
                  <span className={styles['agent-icon']}>
                    <IconSettings size={18} stroke={1.6} />
                  </span>
                  <span>{getLocalizedAgentName(config)}</span>
                </div>
                <span className={styles['arrow-icon']}>
                  <IconArrowRight size={16} stroke={1.6} />
                </span>
              </div>
              <div className={styles['grid-card-body']}>
                <div className={styles['grid-card-desc']}>{getLocalizedAgentDescription(config)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* 编辑视图 */
        <div className={styles['ad-detail-view']}>
          {/* 顶部返回 + 模型选择 */}
          <div className={styles['ad-detail-header']}>
            <div className={styles['header-left']}>
              <UnstyledButton className={styles['header-back-btn']} onClick={handleBack}>
                <IconArrowLeft size={18} stroke={1.6} />
              </UnstyledButton>
              <span className={styles['header-title']}>{getCurrentAgentTitle()}</span>
            </div>
            <div className={styles['header-right']}>
              <span className={styles['model-label']}>{t('database.agentSettings.useModel')}</span>
              <Select
                value={agentData.model_id || null}
                className={styles['model-select']}
                placeholder={t('database.agentSettings.systemDefault')}
                clearable
                size="sm"
                data={availableModels.map((model) => ({
                  value: model.id,
                  label: model.display_name
                }))}
                onChange={handleModelChange}
              />
            </div>
          </div>

          {/* 配置表单 */}
          <div className={styles['ad-detail-content']}>
            {/* 配置表单 */}
            <div className={styles['config-form']}>
              {/* 业务规则（放在最上面） */}
              <div className={styles['form-item']}>
                {/* label */}
                <div className={styles['prompt-label']}>
                  <div className={styles['label-with-tip']}>
                    <span className={styles['form-item-label']}>{t('database.agentSettings.businessRules')}</span>
                    <Tooltip
                      position="top"
                      multiline
                      w={280}
                      label={t('database.agentSettings.rulesTooltip')}
                    >
                      <span className={styles['tip-icon']}>
                        <IconHelpCircleFilled size={14} />
                      </span>
                    </Tooltip>
                  </div>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    leftSection={<IconRefresh size={14} />}
                    onClick={(e) => {
                      e.stopPropagation()
                      resetRules()
                    }}
                  >
                    {t('database.agentSettings.resetDefault')}
                  </Button>
                </div>
                <div
                  className={`${styles['preview-box']} ${styles['rules-box']}`}
                  onClick={() =>
                    openEditor('rules', t('database.agentSettings.businessRules'), agentData.rules)
                  }
                >
                  {/* 有规则时显示内容 */}
                  {agentData.rules ? (
                    <pre className={styles['preview-content']}>{agentData.rules}</pre>
                  ) : (
                    /* 无规则时显示空状态提示 */
                    <div className={styles['rules-empty']}>
                      <span className={styles['empty-icon']}>
                        <IconEdit size={32} stroke={1.6} />
                      </span>
                      <div className={styles['empty-title']}>{t('database.agentSettings.noRulesConfigured')}</div>
                      <div className={styles['empty-desc']}>{rulesEmptyHint}</div>
                      <div className={styles['empty-action']}>{t('database.agentSettings.clickToAddRules')}</div>
                    </div>
                  )}
                  <div className={styles['edit-overlay']}>
                    <span className={styles['icon']}>
                      <IconPencil size={18} stroke={1.6} />
                    </span>
                    <span>{t('database.agentSettings.clickToEdit')}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 高级设置（折叠） */}
            <div className={styles['advanced-settings']}>
              <UnstyledButton
                onClick={() => setAdvancedExpanded((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, height: 32 }}
              >
                <span className={styles['collapse-title']}>{t('database.agentSettings.advancedSettings')}</span>
                <IconChevronDown
                  size={16}
                  stroke={1.6}
                  style={{
                    transition: 'transform 0.2s',
                    transform: advancedExpanded ? 'rotate(180deg)' : 'none',
                    color: 'var(--el-text-color-secondary)'
                  }}
                />
              </UnstyledButton>
              <Collapse in={advancedExpanded}>
                <div style={{ padding: '16px 0 0 0' }}>
                  {/* System Prompt */}
                  <div className={styles['prompt-section']}>
                    <div className={styles['prompt-label']}>
                      <span>System Prompt</span>
                      <div className={styles['prompt-actions']}>
                        {/* 有 modes 时显示模板选择下拉，否则显示普通恢复默认 */}
                        {currentAgent?.modes?.length ? (
                          <Menu trigger="click" position="bottom-end" width={260}>
                            <Menu.Target>
                              <Button
                                variant="subtle"
                                size="compact-sm"
                                className={styles['reset-dropdown-btn']}
                                leftSection={<IconRefresh size={14} />}
                                rightSection={<IconChevronDown size={14} />}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {t('database.agentSettings.resetDefault')}
                              </Button>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {currentAgent.modes.map((mode: any) => (
                                <Menu.Item
                                  key={mode.value}
                                  onClick={() => handleResetWithTemplate(mode.template_agent_type)}
                                >
                                  <div className={styles['template-option']}>
                                    <span className={styles['template-option-label']}>
                                      {getLocalizedModeLabel(mode)}
                                    </span>
                                    <span className={styles['template-option-desc']}>
                                      {getLocalizedModeDescription(mode)}
                                    </span>
                                  </div>
                                </Menu.Item>
                              ))}
                            </Menu.Dropdown>
                          </Menu>
                        ) : (
                          <Button
                            variant="subtle"
                            size="compact-sm"
                            leftSection={<IconRefresh size={14} />}
                            onClick={(e) => {
                              e.stopPropagation()
                              resetSystemPrompt()
                            }}
                          >
                            {t('database.agentSettings.resetDefault')}
                          </Button>
                        )}
                      </div>
                    </div>
                    <div
                      className={styles['preview-box']}
                      onClick={() => openEditor('system_prompt', 'System Prompt', agentData.system_prompt)}
                    >
                      <pre className={styles['preview-content']}>
                        {agentData.system_prompt || t('database.agentSettings.enterSystemPrompt')}
                      </pre>
                      <div className={styles['edit-overlay']}>
                        <span className={styles['icon']}>
                          <IconPencil size={18} stroke={1.6} />
                        </span>
                        <span>{t('database.agentSettings.clickToEdit')}</span>
                      </div>
                    </div>
                  </div>

                  {/* User Prompt模板 */}
                  <div className={styles['prompt-section']}>
                    <div className={styles['prompt-label']}>
                      <span>{t('database.agentSettings.userPromptTemplate')}</span>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        leftSection={<IconRefresh size={14} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          resetUserPrompt()
                        }}
                      >
                        {t('database.agentSettings.resetDefault')}
                      </Button>
                    </div>
                    <div
                      className={styles['preview-box']}
                      onClick={() =>
                        openEditor(
                          'user_prompt_template',
                          t('database.agentSettings.userPromptTemplate'),
                          agentData.user_prompt_template
                        )
                      }
                    >
                      <pre className={styles['preview-content']}>
                        {agentData.user_prompt_template || t('database.agentSettings.enterUserPrompt')}
                      </pre>
                      <div className={styles['edit-overlay']}>
                        <span className={styles['icon']}>
                          <IconPencil size={18} stroke={1.6} />
                        </span>
                        <span>{t('database.agentSettings.clickToEdit')}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Collapse>
            </div>
          </div>
        </div>
      )}

      {/* 编辑弹窗 */}
      <Modal
        opened={editorDialog.visible}
        onClose={() => setEditorDialog((prev) => ({ ...prev, visible: false }))}
        title={editorDialog.title}
        size={isMobile ? '96%' : '80%'}
        centered={false}
        closeOnClickOutside={false}
      >
        <div className={styles['editor-textarea-wrapper']}>
          <textarea
            ref={editorInputRef}
            value={editorDialog.content}
            onChange={(e) =>
              setEditorDialog((prev) => ({ ...prev, content: e.currentTarget.value }))
            }
            placeholder={t('database.agentSettings.enterContent', { title: editorDialog.title })}
            className={styles['editor-textarea']}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button variant="default" onClick={() => setEditorDialog((prev) => ({ ...prev, visible: false }))}>
            {t('database.action.cancel')}
          </Button>
          <Button onClick={confirmEditor} loading={saving}>
            {t('database.action.save')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

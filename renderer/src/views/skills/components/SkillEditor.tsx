import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import {
  Box,
  Button,
  LoadingOverlay,
  Select,
  Switch,
  TagsInput,
  TextInput,
  Textarea
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { IconCpu, IconSearch, IconWand } from '@tabler/icons-react'
import styles from './SkillEditor.module.scss'

// 工具项
interface ToolItem {
  name: string
  description?: string
  [key: string]: any
}

// 表单数据
interface SkillForm {
  name: string
  description: string
  category: string | null
  tags: string[]
  allowed_tools: string[]
  instructions: string
  runtime: string
  side_effect: string
  requires_project: boolean
}

// defineProps
export interface SkillEditorProps {
  tools?: ToolItem[]
  skill?: any
  projectId?: string
  toolsLoading?: boolean
  onAIGenerate?: (data: { description: string }) => Promise<any>
}

// defineExpose → forwardRef 暴露的实例方法
export interface SkillEditorHandle {
  getFormData: () => SkillForm | null
  setFormData: (data: any) => void
}

const SkillEditor = forwardRef<SkillEditorHandle, SkillEditorProps>(function SkillEditor(
  { tools = [], skill = null, projectId = '', toolsLoading = false, onAIGenerate },
  ref
) {
  const { t } = useTranslation()

  // isEditing = computed(() => !!props.skill)
  const isEditing = !!skill

  // form = ref({...})
  const [form, setForm] = useState<SkillForm>(() =>
    skill
      ? {
          name: skill.name,
          description: skill.description || '',
          category: skill.category || null,
          tags: skill.tags || [],
          allowed_tools: skill.allowed_tools || [],
          instructions: skill.instructions || '',
          runtime: skill.runtime || 'prompt',
          side_effect: skill.side_effect || 'read',
          requires_project: !!skill.requires_project
        }
      : {
          name: '',
          description: '',
          category: null,
          tags: [],
          allowed_tools: [],
          instructions: '',
          runtime: 'prompt',
          side_effect: 'read',
          requires_project: false
        }
  )

  // 用 ref 保存最新 form，供 defineExpose 的同步方法读取
  const formRef = useRef(form)
  formRef.current = form

  useEffect(() => {
    setForm(
      skill
        ? {
            name: skill.name,
            description: skill.description || '',
            category: skill.category || null,
            tags: skill.tags || [],
            allowed_tools: skill.allowed_tools || [],
            instructions: skill.instructions || '',
            runtime: skill.runtime || 'prompt',
            side_effect: skill.side_effect || 'read',
            requires_project: !!skill.requires_project
          }
        : {
            name: '',
            description: '',
            category: null,
            tags: [],
            allowed_tools: [],
            instructions: '',
            runtime: 'prompt',
            side_effect: 'read',
            requires_project: false
          }
    )
  }, [skill])

  // ===== 工具调色板 =====
  const [paletteSearch, setPaletteSearch] = useState('')
  const filteredTools = useMemo(() => {
    const q = paletteSearch.trim().toLowerCase()
    if (!q) return tools
    return tools.filter(
      (tl) =>
        tl.name.toLowerCase().includes(q) ||
        (tl.description || '').toLowerCase().includes(q)
    )
  }, [paletteSearch, tools])

  function getToolDesc(name: string) {
    const tool = tools.find((tl) => tl.name === name)
    return tool?.description || ''
  }

  function toggleTool(tool: ToolItem) {
    setForm((prev) => {
      const idx = prev.allowed_tools.indexOf(tool.name)
      if (idx >= 0) {
        const next = [...prev.allowed_tools]
        next.splice(idx, 1)
        return { ...prev, allowed_tools: next }
      }
      return { ...prev, allowed_tools: [...prev.allowed_tools, tool.name] }
    })
  }

  function removeTool(name: string) {
    setForm((prev) => ({
      ...prev,
      allowed_tools: prev.allowed_tools.filter((n) => n !== name)
    }))
  }

  // ===== 拖放 =====
  const [isDragOver, setIsDragOver] = useState(false)
  const dragDataRef = useRef<ToolItem | null>(null)

  function onDragStart(e: DragEvent<HTMLDivElement>, tool: ToolItem) {
    dragDataRef.current = tool
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', tool.name)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    setIsDragOver(false)
    const name = dragDataRef.current?.name || e?.dataTransfer?.getData('text/plain')
    if (name) {
      setForm((prev) =>
        prev.allowed_tools.includes(name)
          ? prev
          : { ...prev, allowed_tools: [...prev.allowed_tools, name] }
      )
    }
    dragDataRef.current = null
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Only clear when leaving the work-area itself, not when moving over children
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }

  // ===== AI 辅助 =====
  const [aiDescription, setAiDescription] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)

  const aiPlaceholder = useMemo(
    () =>
      form.instructions
        ? '描述修改需求，AI 重新生成指令'
        : '描述 Skill 用途，AI 生成配置和指令',
    [form.instructions]
  )
  const aiButtonText = useMemo(
    () => (form.instructions ? 'AI 优化' : '智能生成'),
    [form.instructions]
  )

  async function handleAIGenerate() {
    if (!aiDescription.trim()) return
    setAiGenerating(true)
    try {
      const res = await onAIGenerate?.({ description: aiDescription })
      const data = (res as any).data
      // 填充表单，保留用户已填的 name（如果有）
      setForm((prev) => {
        const next = { ...prev }
        if (!prev.name && data.name) next.name = data.name
        if (data.description) next.description = data.description
        if (data.category) next.category = data.category
        if (data.tags) next.tags = data.tags
        if (data.allowed_tools) next.allowed_tools = data.allowed_tools
        if (data.instructions) next.instructions = data.instructions
        if (data.runtime) next.runtime = data.runtime
        if (data.side_effect) next.side_effect = data.side_effect
        if (typeof data.requires_project === 'boolean') next.requires_project = data.requires_project
        return next
      })
      setAiDescription('')
      notifications.show({ color: 'green', message: 'AI 生成成功' })
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || 'AI 生成失败' })
    } finally {
      setAiGenerating(false)
    }
  }

  function onAiKeyUp(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAIGenerate()
  }

  // ===== 导出（defineExpose）=====
  useImperativeHandle(ref, () => ({
    getFormData() {
      const cur = formRef.current
      if (!cur.name.trim()) {
        notifications.show({ color: 'yellow', message: t('skills.nameRequired') })
        return null
      }
      if (!cur.description.trim()) {
        notifications.show({ color: 'yellow', message: t('skills.descRequired') })
        return null
      }
      if (!cur.instructions.trim()) {
        notifications.show({ color: 'yellow', message: 'Skill 指令不能为空' })
        return null
      }
      return { ...cur }
    },
    setFormData(data: any) {
      setForm({
        name: data.name || '',
        description: data.description || '',
        category: data.category || null,
        tags: data.tags || [],
        allowed_tools: data.allowed_tools || [],
        instructions: data.instructions || '',
        runtime: data.runtime || 'prompt',
        side_effect: data.side_effect || 'read',
        requires_project: !!data.requires_project
      })
    }
  }))

  return (
    <div className={styles.skillEditor}>
      {/* 顶栏：基本信息 */}
      <div className={styles.editorTop}>
        <div className={styles.topField}>
          <TextInput
            label={t('skills.formName')}
            placeholder={t('skills.formNamePlaceholder')}
            disabled={isEditing}
            value={form.name}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, name: e.currentTarget.value }))
            }
          />
        </div>
        <div className={`${styles.topField} ${styles.topFieldShort}`}>
          <Select
            label={t('skills.formCategory')}
            placeholder={t('skills.formCategoryPlaceholder')}
            clearable
            style={{ width: '100%' }}
            value={form.category}
            onChange={(val) => setForm((prev) => ({ ...prev, category: val }))}
            data={[
              { value: 'analysis', label: t('skills.categoryAnalysis') },
              { value: 'research', label: t('skills.categoryResearch') },
              { value: 'report', label: t('skills.categoryReport') }
            ]}
          />
        </div>
        <div className={`${styles.topField} ${styles.topFieldGrow}`}>
          <TextInput
            label={t('skills.formDesc')}
            placeholder={t('skills.formDescPlaceholder')}
            value={form.description}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, description: e.currentTarget.value }))
            }
          />
        </div>
        <div className={`${styles.topField} ${styles.topFieldGrow}`}>
          <TagsInput
            label={t('skills.formTags')}
            placeholder={t('skills.formTagsPlaceholder')}
            style={{ width: '100%' }}
            value={form.tags}
            onChange={(val) => setForm((prev) => ({ ...prev, tags: val }))}
          />
        </div>
        <div className={`${styles.topField} ${styles.topFieldShort}`}>
          <Select
            label="运行类型"
            value={form.runtime}
            onChange={(val) => setForm((prev) => ({ ...prev, runtime: val || 'prompt' }))}
            data={[
              { value: 'prompt', label: 'Prompt' },
              { value: 'service', label: 'Service' },
              { value: 'workflow', label: 'Workflow' }
            ]}
          />
        </div>
        <div className={`${styles.topField} ${styles.topFieldShort}`}>
          <Select
            label="副作用"
            value={form.side_effect}
            onChange={(val) => setForm((prev) => ({ ...prev, side_effect: val || 'read' }))}
            data={[
              { value: 'read', label: 'Read' },
              { value: 'write', label: 'Write' },
              { value: 'execute', label: 'Execute' }
            ]}
          />
        </div>
        <div className={`${styles.topField} ${styles.topSwitchField}`}>
          <Switch
            label="依赖项目"
            checked={form.requires_project}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, requires_project: e.currentTarget.checked }))
            }
          />
        </div>
      </div>

      {/* 主区域：两栏 */}
      <div className={styles.editorMain}>
        {/* 左：工具调色板 */}
        <div className={styles.toolPalette}>
          <div className={styles.panelTitle}>{t('skills.toolsTitle')}</div>
          <div className={styles.paletteSearch}>
            <TextInput
              placeholder="搜索..."
              leftSection={<IconSearch size={14} />}
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.currentTarget.value)}
            />
          </div>
          <div className={styles.paletteList}>
            <LoadingOverlay visible={toolsLoading} zIndex={5} />
            {filteredTools.map((tool) => (
              <div
                key={tool.name}
                className={`${styles.paletteItem} ${
                  form.allowed_tools.includes(tool.name) ? styles.isSelected : ''
                }`}
                draggable
                onDragStart={(e) => onDragStart(e, tool)}
                onClick={() => toggleTool(tool)}
              >
                <div className={styles.paletteItemName}>
                  <IconCpu className={styles.paletteIco} size={12} />
                  <span>{tool.name}</span>
                </div>
                <div className={styles.paletteItemDesc}>{tool.description}</div>
              </div>
            ))}
            {filteredTools.length === 0 && (
              <div className={styles.paletteEmpty}>无匹配</div>
            )}
          </div>
        </div>

        {/* 右：工作区（已选工具 chips + AI描述 + 指令编辑器） */}
        <div
          className={`${styles.workArea} ${isDragOver ? styles.isDragOver : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* 顶部：已选工具 chips */}
          <div className={styles.selectedChipsBar}>
            <div className={styles.chipsLabel}>
              {t('skills.formTools')}
              {form.allowed_tools.length > 0 && (
                <span className={styles.toolCount}>{form.allowed_tools.length}</span>
              )}
            </div>
            <div className={styles.chipsArea}>
              {form.allowed_tools.length === 0 ? (
                <div className={styles.chipsHint}>
                  从左侧 <b>拖入</b>、<b>点击</b>、或在下方描述需求让 <b>AI 自动挑选</b>
                </div>
              ) : (
                <div className={styles.chipsList}>
                  {form.allowed_tools.map((name) => (
                    <span key={name} className={styles.chip} title={getToolDesc(name)}>
                      <IconCpu className={styles.chipIco} size={12} />
                      <span className={styles.chipName}>{name}</span>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        onClick={() => removeTool(name)}
                        aria-label="remove"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 中间：AI 描述条 */}
          <div className={styles.aiBar}>
            <IconWand className={styles.aiBarIco} size={16} />
            <TextInput
              className={styles.aiBarInput}
              placeholder={aiPlaceholder}
              value={aiDescription}
              onChange={(e) => setAiDescription(e.currentTarget.value)}
              onKeyUp={onAiKeyUp}
            />
            <Button
              loading={aiGenerating}
              disabled={!aiDescription.trim() || !onAIGenerate}
              onClick={handleAIGenerate}
              leftSection={!aiGenerating ? <IconWand size={16} /> : undefined}
            >
              {aiGenerating ? '生成中...' : aiButtonText}
            </Button>
          </div>

          {/* 底部：指令编辑器（最大占位） */}
          <div className={styles.promptArea}>
            <div className={styles.promptAreaLabel}>{t('skills.sectionInstructions')}</div>
            <Textarea
              className={styles.promptEditor}
              placeholder={t('skills.formInstructionsPlaceholder')}
              value={form.instructions}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, instructions: e.currentTarget.value }))
              }
              styles={{ wrapper: { height: '100%' }, input: { height: '100%' } }}
            />
          </div>

          {/* 全局拖放覆盖层 */}
          {isDragOver && (
            <div className={styles.dropOverlay} aria-hidden="true">
              <Box className={styles.dropOverlayBox}>
                <IconCpu size={24} />
                <span>松开鼠标添加到已选工具</span>
              </Box>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export default SkillEditor

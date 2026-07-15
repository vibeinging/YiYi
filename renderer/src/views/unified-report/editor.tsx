import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Select, Textarea, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useNavigate, useParams } from 'react-router-dom'
import yaml from 'js-yaml'
import PayloadSchemaPanel from '@/components/unified-report-editor/PayloadSchemaPanel'
import SectionCanvas from '@/components/unified-report-editor/SectionCanvas'
import SectionPalette from '@/components/unified-report-editor/SectionPalette'
import SectionPropertyPanel from '@/components/unified-report-editor/SectionPropertyPanel'
import SectionPreview from '@/components/unified-report-editor/SectionPreview'
import { projectPath } from '@/utils/project-route'
import {
  createUnifiedReportTemplate,
  getUnifiedReportTemplate,
  listUnifiedReportTemplates,
  previewUnifiedReportTemplate,
  updateUnifiedReportTemplate,
  validateUnifiedReportTemplate,
} from '@/api/unifiedReport'
import styles from './editor.module.scss'

// defineProps({ embedded, templateId }) + defineEmits(['navigate'])
interface ReportEditorProps {
  embedded?: boolean
  templateId?: string
  onNavigate?: (payload: { mode: string; id: any }) => void
}

const normalizeName = (value: any) => (value || '').trim()

function nextKey(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`
}

// 各 section 类型的默认结构工厂
const defaultSections: Record<string, () => any> = {
  heading: () => ({ type: 'heading', key: nextKey('heading'), props: { text: '{{report.title}}', level: 1 } }),
  hero_summary: () => ({ type: 'hero_summary', key: nextKey('summary'), props: { title: '摘要', content: '{{report.summary}}' } }),
  markdown: () => ({ type: 'markdown', key: nextKey('markdown'), props: { content: '{{appendix.notes}}' } }),
  metric_cards: () => ({ type: 'metric_cards', key: nextKey('metrics'), props: { title: '核心指标', items: '{{metrics}}' } }),
  data_table: () => ({ type: 'data_table', key: nextKey('table'), props: { title: '数据表格', columns: '{{tables.sales_detail.columns}}', rows: '{{tables.sales_detail.rows}}' } }),
  chart: () => ({ type: 'chart', key: nextKey('chart'), props: { title: '图表', chart_type: 'line', data: '{{charts.sales_trend}}' } }),
  insight_list: () => ({ type: 'insight_list', key: nextKey('insights'), props: { title: '核心洞察', items: '{{insights}}' } }),
  recommendations: () => ({ type: 'recommendations', key: nextKey('recommendations'), props: { title: '建议', items: '{{recommendations}}' } }),
  divider: () => ({ type: 'divider', key: nextKey('divider'), props: {} }),
  html: () => ({ type: 'html', key: nextKey('html'), props: { content: '{{appendix.custom_html}}' } }),
}

const examplePayload = `{
  "report": {
    "title": "2026年3月销售分析报告",
    "summary": "本月销售额环比增长12%，主要增量来自华东区域。"
  },
  "metrics": [
    { "label": "销售额", "value": "1200万", "trend": "+12%" },
    { "label": "订单数", "value": "3.2万", "trend": "+5%" }
  ],
  "tables": {
    "sales_detail": {
      "columns": [
        { "key": "region", "title": "区域" },
        { "key": "sales", "title": "销售额" }
      ],
      "rows": [
        { "region": "华东", "sales": "500万" },
        { "region": "华南", "sales": "320万" }
      ]
    }
  },
  "charts": {
    "sales_trend": {
      "x": ["1月", "2月", "3月"],
      "series": [{ "name": "销售额", "data": [1000, 1070, 1200] }]
    }
  },
  "insights": ["华东区域贡献主要增量。", "高客单价商品增长明显。"],
  "recommendations": ["继续加大华东区域投放。", "优化高客单价商品营销策略。"],
  "appendix": { "notes": "本报告基于2026年3月业务数据生成。" }
}`

export default function Editor({ embedded = false, templateId: propTemplateId = '', onNavigate }: ReportEditorProps) {
  const navigate = useNavigate()
  const params = useParams()

  // computed(() => props.templateId || route.params.id || '')
  const templateId = propTemplateId || params.id || ''
  const isEdit = !!templateId

  const [form, setForm] = useState<any>({
    name: '',
    report_type: 'general_analysis',
    description: '',
    status: 'active',
    is_default: false,
  })
  const [sections, setSections] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewMeta, setPreviewMeta] = useState<{ state: string; sectionCount: number }>({ state: 'idle', sectionCount: 0 })
  const [selectedKey, setSelectedKey] = useState('')
  const [existingTemplates, setExistingTemplates] = useState<any[]>([])
  const [payloadPanelExpanded, setPayloadPanelExpanded] = useState(false)
  const [yamlPanelExpanded, setYamlPanelExpanded] = useState(false)
  const [payloadText, setPayloadText] = useState(examplePayload)
  const [nameError, setNameError] = useState<string>('')

  const updateForm = (patch: Partial<any>) => setForm((prev: any) => ({ ...prev, ...patch }))

  const selectedSection = useMemo(
    () => sections.find((item) => item.key === selectedKey) || null,
    [sections, selectedKey],
  )

  const payloadParseResult = useMemo(() => {
    try {
      return {
        valid: true,
        value: JSON.parse(payloadText || '{}'),
        message: 'Payload JSON 格式正确，可用于预览模板。',
      }
    } catch {
      return {
        valid: false,
        value: {},
        message: 'Payload JSON 格式不合法，预览会被拦截。',
      }
    }
  }, [payloadText])

  const previewPayload = payloadParseResult.value

  const payloadStatus = useMemo(
    () => ({
      type: payloadParseResult.valid ? 'success' : 'warning',
      text: payloadParseResult.message,
    }),
    [payloadParseResult],
  )

  const previewStatus = useMemo(() => {
    if (!payloadParseResult.valid) {
      return { type: 'warning', text: '当前 payload 不可用，HTML 预览不会更新。' }
    }
    if (previewMeta.state === 'success') {
      return { type: 'success', text: `模板预览成功，当前渲染出 ${previewMeta.sectionCount} 个 section。` }
    }
    if (previewMeta.state === 'error') {
      return { type: 'warning', text: '上一次预览失败，请检查模板结构或 payload 内容。' }
    }
    return { type: 'muted', text: '点击“预览”后显示最终 HTML 报告。' }
  }, [payloadParseResult, previewMeta])

  const emptyPreviewText = useMemo(() => {
    if (!payloadParseResult.valid) return 'Payload JSON 不合法，请先修正后再预览。'
    if (previewMeta.state === 'error') return '预览失败，请修正模板或 payload 后重试。'
    return '点击预览后显示 HTML 报告'
  }, [payloadParseResult, previewMeta])

  // currentYamlSpec 依赖 form + sections,实时同步
  const currentYamlSpec = useMemo(() => {
    const doc = {
      template: {
        report_type: form.report_type,
        name: form.name,
        description: form.description,
        theme: 'default',
        spec_version: 'v1',
      },
      sections,
    }
    return yaml.dump(doc, { lineWidth: 120, noRefs: true })
  }, [form, sections])

  // 模板名称校验:必填 + 同项目下不可重复(对应 el-form validateTemplateName)
  const validateName = (value: any): string => {
    const nextName = normalizeName(value)
    if (!nextName) return '请输入模板名称'
    const duplicated = existingTemplates.some(
      (item) => item.id !== templateId && normalizeName(item.name) === nextName,
    )
    if (duplicated) return '同一项目下模板名称不能重复'
    return ''
  }

  const appendSection = ({ type, index }: { type: string; index: number }) => {
    const factory = defaultSections[type]
    if (!factory) return
    const section = factory()
    setSections((prev) => {
      const next = [...prev]
      next.splice(index, 0, section)
      return next
    })
    setSelectedKey(section.key)
  }

  const appendSectionByType = (type: string) => appendSection({ type, index: sections.length })

  const reorderSections = ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
    if (oldIndex === newIndex) return
    setSections((prev) => {
      const next = [...prev]
      const [section] = next.splice(oldIndex, 1)
      const safeIndex = newIndex > oldIndex ? newIndex - 1 : newIndex
      next.splice(safeIndex, 0, section)
      return next
    })
  }

  const removeSection = (key: string) => {
    setSections((prev) => {
      const index = prev.findIndex((item) => item.key === key)
      if (index === -1) return prev
      const next = [...prev]
      next.splice(index, 1)
      setSelectedKey(next[Math.max(0, index - 1)]?.key || next[0]?.key || '')
      return next
    })
  }

  const duplicateSection = (key: string) => {
    setSections((prev) => {
      const index = prev.findIndex((item) => item.key === key)
      if (index === -1) return prev
      const copy = JSON.parse(JSON.stringify(prev[index]))
      copy.key = nextKey(copy.type)
      const next = [...prev]
      next.splice(index + 1, 0, copy)
      setSelectedKey(copy.key)
      return next
    })
  }

  const updateSection = (nextSection: any) => {
    if (!nextSection) return
    setSections((prev) => {
      const index = prev.findIndex((item) => item.key === selectedKey)
      if (index === -1) return prev
      const next = [...prev]
      next[index] = JSON.parse(JSON.stringify(nextSection))
      return next
    })
    setSelectedKey(nextSection.key)
  }

  const fillExample = () => {
    setForm((prev: any) => ({
      ...prev,
      name: '通用分析报告默认模板',
      report_type: 'general_analysis',
      description: '通用分析报告标准模板',
    }))
    const nextSections = [
      { type: 'heading', key: 'title', props: { text: '{{report.title}}', level: 1 } },
      { type: 'hero_summary', key: 'summary', props: { title: '摘要', content: '{{report.summary}}' } },
      { type: 'metric_cards', key: 'metrics', props: { title: '核心指标', items: '{{metrics}}' } },
      { type: 'chart', key: 'sales_trend', props: { title: '图表', chart_type: 'line', data: '{{charts.sales_trend}}' } },
      { type: 'insight_list', key: 'insights', props: { title: '核心洞察', items: '{{insights}}' } },
      { type: 'recommendations', key: 'recommendations', props: { title: '建议', items: '{{recommendations}}' } },
    ]
    setSections(nextSections)
    setSelectedKey(nextSections[0]?.key || '')
  }

  const parsePayload = () => {
    try {
      return JSON.parse(payloadText || '{}')
    } catch {
      setPreviewMeta({ state: 'error', sectionCount: 0 })
      throw new Error('Payload JSON 格式不合法')
    }
  }

  const loadExistingTemplates = async (): Promise<any[]> => {
    const res: any = await listUnifiedReportTemplates({ page_size: 200 })
    const items = res.data?.items || []
    setExistingTemplates(items)
    return items
  }

  const loadTemplate = async () => {
    if (!templateId) return
    const res: any = await getUnifiedReportTemplate(templateId)
    setForm((prev: any) => ({ ...prev, ...res.data }))
    const doc: any = yaml.load(res.data.yaml_spec || '') || {}
    const nextSections = Array.isArray(doc.sections) ? doc.sections : []
    setSections(nextSections)
    setSelectedKey(nextSections[0]?.key || '')
  }

  const validateTemplate = async () => {
    await validateUnifiedReportTemplate({ yaml_spec: currentYamlSpec })
    notifications.show({ color: 'green', message: '模板校验通过' })
  }

  const previewTemplate = async () => {
    try {
      const payload = parsePayload()
      const res: any = await previewUnifiedReportTemplate({ yaml_spec: currentYamlSpec, payload })
      setPreviewHtml(res.data?.html || '')
      setPreviewMeta({
        state: 'success',
        sectionCount: Array.isArray(res.data?.sections) ? res.data.sections.length : 0,
      })
      notifications.show({ color: 'green', message: '模板预览成功' })
    } catch (error: any) {
      setPreviewHtml('')
      setPreviewMeta({ state: 'error', sectionCount: 0 })
      if (error?.message === 'Payload JSON 格式不合法') {
        notifications.show({ color: 'red', message: error.message })
      }
    }
  }

  const saveTemplate = async () => {
    setSaving(true)
    try {
      const trimmedName = normalizeName(form.name)
      updateForm({ name: trimmedName })
      // 保存前刷新已有模板列表并做名称校验(对应 baseFormRef.validate)
      const items = await loadExistingTemplates()
      const duplicated = items.some(
        (item: any) => item.id !== templateId && normalizeName(item.name) === trimmedName,
      )
      let errorMsg = ''
      if (!trimmedName) errorMsg = '请输入模板名称'
      else if (duplicated) errorMsg = '同一项目下模板名称不能重复'
      setNameError(errorMsg)
      if (errorMsg) {
        throw new Error(errorMsg)
      }
      const payload = {
        ...form,
        name: trimmedName,
        yaml_spec: currentYamlSpec,
      }
      if (isEdit) {
        await updateUnifiedReportTemplate(templateId, payload)
      } else {
        const res: any = await createUnifiedReportTemplate(payload)
        if (embedded) {
          onNavigate?.({ mode: 'edit', id: res.data.id })
        } else {
          navigate(`${projectPath('settings')}#reportTemplates:edit:${res.data.id}`, { replace: true })
        }
      }
      notifications.show({ color: 'green', message: '模板保存成功' })
    } finally {
      setSaving(false)
    }
  }

  // onMounted
  useEffect(() => {
    ;(async () => {
      await loadExistingTemplates()
      if (!isEdit) {
        fillExample()
      } else {
        await loadTemplate()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles['editor-page']}>
      <div className={styles.toolbar}>
        <div className={styles['toolbar-left']}>
          <span className={styles.title}>{isEdit ? '编辑模板' : '新建模板'}</span>
        </div>
        <div className={styles['toolbar-actions']}>
          <Button variant="default" onClick={validateTemplate}>
            校验
          </Button>
          <Button variant="default" onClick={previewTemplate}>
            预览
          </Button>
          <Button loading={saving} onClick={saveTemplate}>
            保存
          </Button>
        </div>
      </div>

      <Card withBorder shadow="none" className={styles['base-form-card']}>
        {/* el-form label-position="top" → 各 Input 自带 label */}
        <div className={styles['base-form-grid']}>
          <TextInput
            label="模板名称"
            placeholder="输入模板名称"
            withAsterisk
            value={form.name}
            error={nameError || undefined}
            onChange={(e) => {
              const value = e.currentTarget.value
              updateForm({ name: value })
              setNameError(validateName(value))
            }}
            onBlur={(e) => setNameError(validateName(e.currentTarget.value))}
          />
          <Select
            label="报告类型"
            disabled
            value={form.report_type}
            data={[{ value: 'general_analysis', label: '通用分析报告' }]}
            onChange={(value) => updateForm({ report_type: value })}
          />
          <Textarea
            className={styles['description-item']}
            label="描述"
            placeholder="补充说明该模板的适用场景或用途"
            rows={3}
            value={form.description}
            onChange={(e) => updateForm({ description: e.currentTarget.value })}
          />
        </div>
      </Card>

      <div className={styles['editor-layout']}>
        <Card withBorder shadow="none" className={styles['palette-panel']}>
          <SectionPalette onAdd={appendSectionByType} />
        </Card>

        <div className={styles['center-column']}>
          <Card withBorder shadow="none" className={styles['canvas-panel']}>
            <Card.Section withBorder inheritPadding py="xs">
              <div className={styles['panel-header']}>
                <span>模板画布</span>
                <Button variant="subtle" size="compact-sm" onClick={fillExample}>
                  生成示例结构
                </Button>
              </div>
            </Card.Section>
            <SectionCanvas
              sections={sections}
              selectedKey={selectedKey}
              onAppend={appendSection}
              onSelect={(key) => setSelectedKey(key)}
              onDuplicate={duplicateSection}
              onRemove={removeSection}
              onReorder={reorderSections}
            />
          </Card>

          <div className={styles['bottom-layout']}>
            <Card withBorder shadow="none">
              <Card.Section withBorder inheritPadding py="xs">
                <div className={styles['panel-header']}>
                  <span>Payload 预览输入</span>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    onClick={() => setPayloadPanelExpanded(!payloadPanelExpanded)}
                  >
                    {payloadPanelExpanded ? '收起' : '展开'}
                  </Button>
                </div>
              </Card.Section>
              {payloadPanelExpanded && (
                <div style={{ paddingTop: 12 }}>
                  <div className={`${styles['status-banner']} ${styles[payloadStatus.type]}`}>
                    {payloadStatus.text}
                  </div>
                  <Textarea
                    rows={12}
                    value={payloadText}
                    onChange={(e) => setPayloadText(e.currentTarget.value)}
                  />
                  <div className={styles['panel-hint']}>
                    输入符合 `general_analysis` 规范的 payload，用于预览模板。
                  </div>
                </div>
              )}
            </Card>

            <Card withBorder shadow="none">
              <Card.Section withBorder inheritPadding py="xs">
                <div className={styles['panel-header']}>
                  <span>YAML 同步结果</span>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    onClick={() => setYamlPanelExpanded(!yamlPanelExpanded)}
                  >
                    {yamlPanelExpanded ? '收起' : '展开'}
                  </Button>
                </div>
              </Card.Section>
              {yamlPanelExpanded && (
                <div style={{ paddingTop: 12 }}>
                  <div className={`${styles['status-banner']} ${styles.muted}`}>
                    当前 YAML 会随拖拽与属性编辑实时同步更新。
                  </div>
                  <Textarea rows={12} value={currentYamlSpec} readOnly />
                  <div className={styles['panel-hint']}>拖拽与属性编辑会实时同步为模板 YAML 规范。</div>
                </div>
              )}
            </Card>
          </div>

          <Card withBorder shadow="none" className={styles['preview-panel']}>
            <Card.Section withBorder inheritPadding py="xs">
              <span>HTML 预览</span>
            </Card.Section>
            <div style={{ paddingTop: 12 }}>
              <div className={`${styles['status-banner']} ${styles[previewStatus.type]}`}>
                {previewStatus.text}
              </div>
              <div className={styles['preview-frame']}>
                {previewHtml ? (
                  <iframe title="html-preview" srcDoc={previewHtml} className={styles['preview-iframe']} />
                ) : (
                  <div className={styles['empty-preview']}>{emptyPreviewText}</div>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className={styles['right-column']}>
          <SectionPropertyPanel
            key={selectedSection?.key || 'empty'}
            section={selectedSection}
            onUpdate={updateSection}
          />
          <SectionPreview
            key={`${selectedSection?.key || 'empty'}-${selectedSection?.props?.chart_type || ''}-${selectedSection?.visible_when || ''}`}
            section={selectedSection}
            payload={previewPayload}
          />
          <PayloadSchemaPanel />
        </div>
      </div>
    </div>
  )
}

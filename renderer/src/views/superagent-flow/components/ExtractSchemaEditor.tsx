// ExtractSchemaEditor — 可视化编辑 list 类型参数(主要给 extract_schema 用)。
//
// extract_schema 形如:
// [
//   { name: "person", type: "string", description: "提取人名" },
//   { name: "amount", type: "number", description: "提取金额" },
// ]
//
// 业务人员通过加减行编辑,而不是写 JSON。
import { useEffect, useRef, useState } from 'react'
import { Button, Select, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import styles from './ExtractSchemaEditor.module.scss'

interface SchemaField {
  name: string
  type: string
  description: string
}

interface ExtractSchemaEditorProps {
  /** 对应 Vue 的 v-model:modelValue */
  modelValue?: SchemaField[]
  /** 当前节点的抽取指令(question 参数),供"按指令生成字段"解析 */
  question?: string
  /** defineEmits(['update:modelValue']) → 回调 prop */
  onUpdateModelValue?: (value: SchemaField[]) => void
}

export default function ExtractSchemaEditor({
  modelValue = [],
  question = '',
  onUpdateModelValue,
}: ExtractSchemaEditorProps) {
  const { t } = useTranslation()

  const [fields, setFields] = useState<SchemaField[]>([])
  // 始终用 ref 读取最新 fields,供 onChange/suggest 等逻辑同步使用
  const fieldsRef = useRef<SchemaField[]>([])
  fieldsRef.current = fields

  function syncFromProps() {
    const v = modelValue
    const next: SchemaField[] = Array.isArray(v)
      ? v.map((f) => ({
          name: f?.name || '',
          type: f?.type || 'string',
          description: f?.description || '',
        }))
      : []
    fieldsRef.current = next
    setFields(next)
  }

  function sameContent(a: any, b: any): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if ((a[i]?.name || '') !== (b[i]?.name || '')) return false
      if ((a[i]?.type || 'string') !== (b[i]?.type || 'string')) return false
      if ((a[i]?.description || '') !== (b[i]?.description || '')) return false
    }
    return true
  }

  // 初始化:仅启动时从 props 同步一次,避免 emit 后自己被覆盖
  // 浅 watch:父组件主动 reset(如切换节点)时同步本地状态
  // 用 sameContent 比较跳过"自己 emit 出去导致的 props 变化",避免死循环 + 空行消失
  useEffect(() => {
    if (sameContent(modelValue, fieldsRef.current)) return
    syncFromProps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelValue])

  // emit 出完整数组(不过滤空行 — 让父组件保存时再清理)
  // 这样用户加的空行不会立即消失,且 sameContent 能跳过自己 emit 引发的 sync
  function onChange(nextFields: SchemaField[]) {
    fieldsRef.current = nextFields
    setFields(nextFields)
    onUpdateModelValue?.(
      nextFields.map((f) => ({
        name: f.name || '',
        type: f.type || 'string',
        description: f.description || '',
      })),
    )
  }

  function updateField(idx: number, patch: Partial<SchemaField>) {
    const next = fieldsRef.current.map((f, i) => (i === idx ? { ...f, ...patch } : f))
    onChange(next)
  }

  function addField() {
    onChange([...fieldsRef.current, { name: '', type: 'string', description: '' }])
  }

  function removeField(idx: number) {
    onChange(fieldsRef.current.filter((_, i) => i !== idx))
  }

  // 从抽取指令解析字段名一键生成:
  //   "从每条处理规范中抽取:适用情形、责任部门、处理时限" → 3 个字段行
  // 规则:取最后一个冒号后的部分(无冒号则取"抽取/提取/输出/给出"之后),按顿号/逗号/分号
  // 切段,清洗尾缀("等/等字段/等信息"+标点);只追加不覆盖,与已有字段名去重;
  // 解析不出就什么都不做(保守,不出垃圾字段)
  function suggestFromQuestion() {
    const q = (question || '').trim()
    if (!q) return
    const colonIdx = Math.max(q.lastIndexOf('：'), q.lastIndexOf(':'))
    let tail = colonIdx >= 0 ? q.slice(colonIdx + 1) : ''
    if (!tail) {
      const m = q.match(/(?:抽取|提取|输出|给出)([^。!！?？]+)$/)
      tail = m ? m[1] : ''
    }
    if (!tail) {
      // 解析不出也要有反馈,否则用户以为按钮坏了
      notifications.show({
        color: 'blue',
        message: t('workflow.extractSchema.suggestNoParse', {
          defaultValue: '指令里没解析出字段,试试「抽取:字段A、字段B」写法',
        }),
      })
      return
    }
    const parts = tail
      .split(/[、，,;；/]+/)
      .map((s) =>
        s
          .trim()
          .replace(/[。.!！?？]+$/, '')
          .replace(/等(字段|信息)?$/, '')
          .trim(),
      )
      .filter((s) => s && s.length <= 20)
    // 说明前缀 = question 主干(冒号前部分;无冒号取到"抽取/提取"动词为止),
    // 生成模板级说明如"从每条处理规范中抽取:归口责任部门"(进后端逐行 LLM prompt,比空强;
    // 枚举级说明如"如服务态度/系统故障"属领域知识,需用户补或后续接 LLM 完善)
    const stem = (
      colonIdx >= 0 ? q.slice(0, colonIdx) : q.match(/^.*?(?:抽取|提取|输出|给出)/)?.[0] || ''
    ).trim()
    const descFor = (name: string) => (stem ? `${stem}:${name}` : `逐行抽取:${name}`)

    // 在工作副本上操作(对齐 Vue 直接 mutate fields.value 的语义),最后整体 onChange
    const working: SchemaField[] = fieldsRef.current.map((f) => ({ ...f }))
    let touched = 0
    for (const p of parts) {
      const existRow = working.find((f) => f.name === p)
      if (existRow) {
        // 同名字段说明为空 → 补模板说明(用户删了说明想重生成的场景)
        if (!existRow.description) {
          existRow.description = descFor(p)
          touched += 1
        }
        continue
      }
      // 优先复用名字为空的行(用户清空的行/手点"添加字段"出的空行),没有再追加
      const emptyRow = working.find((f) => !f.name)
      if (emptyRow) {
        emptyRow.name = p
        if (!emptyRow.description) emptyRow.description = descFor(p)
      } else {
        working.push({ name: p, type: 'string', description: descFor(p) })
      }
      touched += 1
    }
    if (touched > 0) {
      onChange(working)
      notifications.show({
        color: 'green',
        message: t('workflow.extractSchema.suggestAdded', {
          defaultValue: `已生成/补全 ${touched} 个字段`,
          count: touched,
        }),
      })
    } else {
      notifications.show({
        color: 'blue',
        message: t('workflow.extractSchema.suggestAllExist', {
          defaultValue: '解析到的字段和说明都已齐,无新增',
        }),
      })
    }
  }

  return (
    <div className={styles.schemaEditor}>
      {fields.map((field, idx) => (
        <div key={idx} className={styles.schemaRow}>
          {/* 两行布局:窄属性面板里描述独占整行,不再被挤成一个字 */}
          <div className={styles.rowMain}>
            <TextInput
              value={field.name}
              placeholder={t('workflow.extractSchema.fieldNamePlaceholder')}
              size="xs"
              className={styles.fieldName}
              onChange={(e) => updateField(idx, { name: e.currentTarget.value })}
            />
            <Select
              value={field.type}
              size="xs"
              className={styles.fieldType}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              data={[
                { value: 'string', label: t('workflow.extractSchema.typeString') },
                { value: 'number', label: t('workflow.extractSchema.typeNumber') },
                { value: 'boolean', label: t('workflow.extractSchema.typeBoolean') },
                { value: 'date', label: t('workflow.extractSchema.typeDate') },
                { value: 'list', label: t('workflow.extractSchema.typeList') },
              ]}
              onChange={(val) => updateField(idx, { type: val || 'string' })}
            />
            <Button
              color="red"
              size="xs"
              variant="subtle"
              className={styles.deleteBtn}
              onClick={() => removeField(idx)}
              title={t('workflow.extractSchema.deleteField')}
            >
              ×
            </Button>
          </div>
          <TextInput
            value={field.description}
            placeholder={t('workflow.extractSchema.descPlaceholder')}
            size="xs"
            className={styles.fieldDesc}
            onChange={(e) => updateField(idx, { description: e.currentTarget.value })}
          />
        </div>
      ))}

      <div className={styles.editorActions}>
        <Button
          color="blue"
          size="xs"
          variant="subtle"
          className={styles.addBtn}
          onClick={addField}
        >
          {t('workflow.extractSchema.addField')}
        </Button>
        {/* 智能预填:从抽取指令(question)解析"抽取:A、B、C"里的字段名,一键生成行 */}
        {question && (
          <Button
            color="green"
            size="xs"
            variant="subtle"
            className={styles.addBtn}
            onClick={suggestFromQuestion}
          >
            {t('workflow.extractSchema.suggestFromQuestion', { defaultValue: '按指令生成字段' })}
          </Button>
        )}
      </div>

      {fields.length === 0 && (
        <div className={styles.emptyHint}>{t('workflow.extractSchema.emptyHint')}</div>
      )}
    </div>
  )
}

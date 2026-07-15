// PromptDialogField — Prompt 字段的预览/弹窗编辑器。
//
// 预览态:截断只读框,点击打开弹窗;弹窗态:大空间编辑,支持变量插入 chip、示例预设。
// 对齐 Vue 版语义:打开时把当前值拷进本地草稿(draft),编辑过程不直接改父值,取消即丢弃。
//
// TODO(migration): el-dialog 的 draggable(标题栏拖动)+ 右下角 resize 改用 CSS resize 实现,
// Mantine Modal 无内建拖拽;通过 module.scss 给 Modal body 加 resize:both 保留缩放体验。
import { useRef, useState } from 'react'
import { Badge, Button, Modal, Textarea } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './PromptDialogField.module.scss'

// 变量插入 chip
interface RefItem {
  value: string
  label: string
  title?: string
}

// 示例预设
interface ExampleItem {
  label: string
  prompt: string
}

interface PromptDialogFieldProps {
  /** v-model:modelValue */
  modelValue?: string
  /** 弹窗标题用:`编辑 ${label}` */
  label?: string
  placeholder?: string
  /** 变量插入 chip;空则不显示插入区 */
  refs?: RefItem[]
  /** 示例预设;空则不显示示例区 */
  examples?: ExampleItem[]
  /** 具名 slot #hint → ReactNode prop */
  hint?: React.ReactNode
  /** defineEmits(['update:modelValue']) → 回调 prop */
  onUpdateModelValue?: (value: string) => void
}

export default function PromptDialogField({
  modelValue = '',
  label = 'Prompt',
  placeholder = '',
  refs = [],
  examples = [],
  hint,
  onUpdateModelValue,
}: PromptDialogFieldProps) {
  const { t } = useTranslation()

  const [visible, setVisible] = useState(false)
  const [draft, setDraft] = useState('')
  // Mantine Textarea 把 ref 透传到原生 <textarea>,用于光标位置插入变量
  const taRef = useRef<HTMLTextAreaElement>(null)

  function openDialog() {
    // 打开时把当前值拷进本地草稿,编辑过程不直接改父值(取消可丢弃)
    setDraft(modelValue || '')
    setVisible(true)
  }

  function onOpened() {
    taRef.current?.focus?.()
  }

  function confirm() {
    onUpdateModelValue?.(draft)
    setVisible(false)
  }

  // 插入变量到光标位置(拿不到原生元素就追加末尾)
  function insertRef(refStr: string) {
    const inner = taRef.current
    if (!inner) {
      // 兜底:拿不到原生元素就追加末尾
      setDraft((d) => d + (d ? ' ' : '') + refStr)
      return
    }
    const start = inner.selectionStart ?? draft.length
    const end = inner.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + refStr + draft.slice(end)
    setDraft(next)
    // 等 DOM 更新后还原光标位置
    requestAnimationFrame(() => {
      const pos = start + refStr.length
      inner.focus()
      inner.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className={styles.promptDialogField}>
      {/* 预览态:截断只读框,点击打开弹窗编辑 */}
      <div
        className={`${styles.pfPreview} ${!modelValue ? styles.pfEmpty : ''}`}
        onClick={openDialog}
      >
        {modelValue ? (
          <div className={styles.pfPreviewText}>{modelValue}</div>
        ) : (
          <div className={styles.pfPreviewPlaceholder}>
            {placeholder || t('workflow.promptField.placeholder')}
          </div>
        )}
        <div className={styles.pfEditBadge}>{t('workflow.promptField.editBadge')}</div>
      </div>

      {/* 弹窗态:大空间编辑 */}
      <Modal
        opened={visible}
        onClose={() => setVisible(false)}
        onTransitionEnd={onOpened}
        title={t('workflow.promptField.dialogTitle', { label })}
        size="50%"
        closeOnClickOutside={false}
        classNames={{ content: styles.promptDialog, body: styles.promptDialogBody }}
        styles={{ inner: { paddingTop: '6vh', alignItems: 'flex-start' } }}
      >
        {/* 可引用变量插入区(refs 非空才显示) */}
        {refs && refs.length > 0 && (
          <div className={styles.refBar}>
            <div className={styles.refBarTitle}>{t('workflow.promptField.insertVars')}</div>
            <div className={styles.refBarTags}>
              {refs.map((r) => (
                <Badge
                  key={r.value}
                  size="sm"
                  variant="outline"
                  className={styles.refTag}
                  title={r.title}
                  onClick={() => insertRef(r.value)}
                >
                  {r.label}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <Textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          autosize={false}
          rows={24}
          resize="none"
          placeholder={placeholder}
          className={styles.pfTextarea}
        />

        {/* 示例预设(examples 非空才显示) */}
        {examples && examples.length > 0 && (
          <div className={styles.exampleBar}>
            <span className={styles.exampleLabel}>{t('workflow.promptField.examples')}</span>
            {examples.map((ex) => (
              <Button
                key={ex.label}
                size="compact-xs"
                variant="subtle"
                color="blue"
                onClick={() => setDraft(ex.prompt)}
              >
                {ex.label}
              </Button>
            ))}
          </div>
        )}

        {hint && <div className={styles.hintDesc}>{hint}</div>}

        {/* footer */}
        <div className={styles.dialogFooter}>
          <Button variant="default" onClick={() => setVisible(false)}>
            {t('workflow.promptField.cancel')}
          </Button>
          <Button color="blue" onClick={confirm}>
            {t('workflow.promptField.confirm')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

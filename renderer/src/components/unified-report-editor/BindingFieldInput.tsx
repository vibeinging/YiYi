import { useMemo } from 'react'
import { Badge, Textarea, TextInput } from '@mantine/core'
import styles from './BindingFieldInput.module.scss'

interface SuggestionOption {
  value: string
  label: string
}

interface BindingFieldInputProps {
  modelValue?: string | number
  placeholder?: string
  type?: string
  rows?: number
  suggestions?: SuggestionOption[]
  insertMode?: string
  helperTitle?: string
  // defineEmits(['update:modelValue', 'input', 'change']) → 三个 emit 均携带同一个值,合并为单个回调
  onChange?: (value: string | number) => void
}

export default function BindingFieldInput({
  modelValue = '',
  placeholder = '',
  type = 'text',
  rows = 4,
  suggestions = [],
  insertMode = 'replace',
  helperTitle = '常用绑定',
  onChange
}: BindingFieldInputProps) {
  const helperModeText = useMemo(
    () => (insertMode === 'append' ? '点击追加到当前内容' : '点击替换当前值'),
    [insertMode]
  )

  const emitValue = (value: string | number) => {
    onChange?.(value)
  }

  const applySuggestion = (value: string) => {
    const current = String(modelValue ?? '')
    let nextValue: string = value

    if (insertMode === 'append' && current.trim()) {
      const separator = type === 'textarea' ? '\n' : ' '
      nextValue = `${current}${separator}${value}`
    }

    emitValue(nextValue)
  }

  return (
    <div className={styles['binding-field']}>
      {type === 'textarea' ? (
        <Textarea
          value={modelValue as any}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => emitValue(e.currentTarget.value)}
        />
      ) : (
        <TextInput
          value={modelValue as any}
          type={type}
          placeholder={placeholder}
          onChange={(e) => emitValue(e.currentTarget.value)}
        />
      )}

      {suggestions.length > 0 && (
        <div className={styles['binding-helper']}>
          <div className={styles['binding-helper-header']}>
            <span className={styles['binding-helper-title']}>{helperTitle}</span>
            <span className={styles['binding-helper-mode']}>{helperModeText}</span>
          </div>
          <div className={styles['binding-tag-list']}>
            {suggestions.map((option) => (
              <Badge
                key={option.value}
                className={styles['binding-tag']}
                variant="outline"
                size="sm"
                onClick={() => applySuggestion(option.value)}
              >
                {option.label}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect } from 'react'
import { Input } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
// TODO(migration): ../payloadBindings 仍是 .js(payloadBindings.js),待该模块迁移成 .ts 后此 import 自动复用
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'
import styles from './HtmlSectionProperty.module.scss'

interface HtmlSectionPropertyProps {
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

export default function HtmlSectionProperty({ section, onUpdate }: HtmlSectionPropertyProps) {
  // 源:if (!section.props) section.props = {} —— 保证 props 对象存在
  useEffect(() => {
    if (!section.props) section.props = {}
  }, [section])

  return (
    <>
      <Input.Wrapper label="HTML 内容">
        <BindingFieldInput
          modelValue={section.props?.content}
          type="textarea"
          rows={10}
          suggestions={COMMON_BINDING_OPTIONS.content}
          insertMode="append"
          onChange={(value) => {
            section.props.content = value
            onUpdate?.()
          }}
        />
      </Input.Wrapper>
      <div className={styles['field-hint']}>适合兜底自定义内容，推荐优先使用结构化 section。</div>
    </>
  )
}

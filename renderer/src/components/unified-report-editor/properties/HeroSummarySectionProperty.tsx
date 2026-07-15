import { Input } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'
import styles from './HeroSummarySectionProperty.module.scss'

interface HeroSummarySectionPropertyProps {
  // section.props 会被就地修改(与 Vue v-model 行为一致),change 后触发 onUpdate
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

export default function HeroSummarySectionProperty({
  section,
  onUpdate
}: HeroSummarySectionPropertyProps) {
  if (!section.props) section.props = {}

  // v-model="section.props.x" + @change="$emit('update')"：就地写回 props 再通知父级
  const handleChange = (key: string, value: string | number) => {
    section.props[key] = value
    onUpdate?.()
  }

  return (
    <>
      <Input.Wrapper label="标题" className={styles['form-item']}>
        <BindingFieldInput
          modelValue={section.props.title}
          suggestions={COMMON_BINDING_OPTIONS.title}
          insertMode="append"
          onChange={(value) => handleChange('title', value)}
        />
      </Input.Wrapper>
      <Input.Wrapper label="摘要内容" className={styles['form-item']}>
        <BindingFieldInput
          modelValue={section.props.content}
          type="textarea"
          rows={5}
          suggestions={COMMON_BINDING_OPTIONS.content}
          insertMode="append"
          onChange={(value) => handleChange('content', value)}
        />
      </Input.Wrapper>
    </>
  )
}

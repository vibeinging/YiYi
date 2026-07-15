import { useEffect } from 'react'
import { Input, Select } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'

interface HeadingSectionPropertyProps {
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

// 标题级别选项(H1~H6),el-option 的 value 为数字,Select 用字符串值,提交时转回 number
const LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6].map((level) => ({
  value: String(level),
  label: `H${level}`
}))

export default function HeadingSectionProperty({ section, onUpdate }: HeadingSectionPropertyProps) {
  // 源 <script setup> 中的初始化逻辑:保证 props 存在且 level 有默认值
  if (!section.props) section.props = {}
  if (section.props.level == null) section.props.level = 1

  // 初始化属于副作用,确保挂载后默认值生效一次
  useEffect(() => {
    if (!section.props) section.props = {}
    if (section.props.level == null) section.props.level = 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Input.Wrapper label="标题文本" mb="sm">
        <BindingFieldInput
          modelValue={section.props.text}
          suggestions={COMMON_BINDING_OPTIONS.text}
          insertMode="append"
          onChange={(value) => {
            section.props.text = value
            onUpdate?.()
          }}
        />
      </Input.Wrapper>
      <Input.Wrapper label="标题级别" mb="sm">
        <Select
          value={section.props.level != null ? String(section.props.level) : null}
          data={LEVEL_OPTIONS}
          allowDeselect={false}
          onChange={(value) => {
            if (value == null) return
            section.props.level = Number(value)
            onUpdate?.()
          }}
        />
      </Input.Wrapper>
    </>
  )
}

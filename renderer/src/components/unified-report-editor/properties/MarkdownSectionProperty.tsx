// TODO(migration): ../payloadBindings 尚未迁移(纯数据模块,后续 wave 转为 payloadBindings.ts)
import { Input } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'

interface MarkdownSectionPropertyProps {
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

export default function MarkdownSectionProperty({ section, onUpdate }: MarkdownSectionPropertyProps) {
  // 源 <script setup> 中的初始化逻辑:直接读写共享的 section.props 对象(模型由父级持有)
  if (!section.props) section.props = {}

  return (
    <Input.Wrapper label="内容">
      <BindingFieldInput
        modelValue={section.props.content}
        type="textarea"
        rows={8}
        placeholder="例如：{{appendix.notes}}，或直接填写 Markdown 内容"
        suggestions={COMMON_BINDING_OPTIONS.content}
        insertMode="append"
        onChange={(value) => {
          section.props.content = value
          onUpdate?.()
        }}
      />
    </Input.Wrapper>
  )
}

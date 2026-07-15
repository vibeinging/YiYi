import { resolveEpIcon } from '@/lib/icon-map'

/**
 * 用 Element Plus 图标名渲染 Tabler 图标(对齐原 components/ElSvgIcon.vue)。
 * props: name(EP 名), size(px), color。
 */
export interface ElSvgIconProps {
  name?: string
  size?: number
  color?: string
}

export default function ElSvgIcon({ name = 'Fold', size = 18, color }: ElSvgIconProps) {
  const Icon = resolveEpIcon(name)
  return <Icon size={size} color={color || undefined} stroke={1.6} />
}

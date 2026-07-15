import type { CSSProperties } from 'react'
import './svg-icon.css'

/**
 * SVG sprite 图标(对齐原 icons/SvgIcon.vue)。
 * 使用 vite-plugin-svg-icons 注入的 symbol：#icon-<dir>-<name> / #icon-<name>。
 */
export interface SvgIconProps {
  iconClass: string
  className?: string
  color?: string
  size?: string
  style?: CSSProperties
}

export default function SvgIcon({ iconClass, className = '', color = '', size = '2em', style }: SvgIconProps) {
  const svgClass = className ? `svg-icon ${className}` : 'svg-icon'
  return (
    <svg className={svgClass} aria-hidden="true" style={{ width: size, height: size, ...style }}>
      <use xlinkHref={`#icon-${iconClass}`} fill={color} />
    </svg>
  )
}

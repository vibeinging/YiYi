/**
 * OperatorNode — 历史兼容显示组件。
 * 背景:OQ-v2-5(2026-05-21 拍板)Operator 节点空占位,3 个"算子"实际是
 * tool 节点(business.category='operator',视觉深绿色矩形)。本组件用于兼容
 * 打开早期版本含 node.type='operator' 节点的 workflow 文件,显示"未实现"警示。
 *
 * 视觉:虚线灰边圆角矩形(SVG),跟 ToolNode/ConditionNode 同 SVG 语言。
 */
import { useMemo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './OperatorNode.module.scss'

interface OperatorNodeProps {
  id?: string
  data: any
  selected?: boolean
}

export default function OperatorNode(props: NodeProps | OperatorNodeProps) {
  const { id, data, selected } = props as OperatorNodeProps
  const { t } = useTranslation()

  const title = useMemo(
    () => data?.displayName || id || 'operator',
    [data?.displayName, id],
  )

  const rootClass = [styles.wfDeprecatedNode, selected ? styles.selected : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <svg
        className={styles.shapeSvg}
        viewBox="0 0 220 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          x="3"
          y="3"
          width="214"
          height="94"
          rx="8"
          ry="8"
          fill="#f9fafb"
          stroke="#9ca3af"
          strokeWidth={selected ? 3 : 2}
          strokeDasharray="6,4"
        />
      </svg>

      <div className={styles.shapeContent}>
        <div className={styles.shapeHeader}>
          <span className={styles.shapeIcon}>
            <ElSvgIcon name="MagicStick" size={16} color="#6b7280" />
          </span>
          <span className={styles.shapeTitle}>{title}</span>
        </div>
        <div className={styles.shapeTech}>{t('workflow.node.operatorPlaceholder')}</div>
        <div className={styles.shapeError}>{t('workflow.node.operatorDeprecated')}</div>
      </div>

      <div className={styles.shapeId}>{id}</div>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

import { useMemo, useState } from 'react'
import { HoverCard } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { ICON_MAP, CATEGORY_META } from '../nodeCatalog'
import styles from './NodeCard.module.scss'

export interface NodeCardProps {
  card: any
  available?: boolean
  disabledReason?: string
  onDragstart?: (card: any) => void
  onDragend?: (card: any) => void
  onHoverEnter?: (card: any) => void
  onHoverLeave?: (card: any) => void
}

export default function NodeCard({
  card,
  available = true,
  disabledReason = '',
  onDragstart,
  onDragend,
  onHoverEnter,
  onHoverLeave,
}: NodeCardProps) {
  const { t } = useTranslation()

  const accent = useMemo(
    () => CATEGORY_META[card.business.category]?.accent || '#909399',
    [card.business.category],
  )

  // iconComponent → ICON_MAP[icon] || ICON_MAP.document(Tabler 组件)
  const IconComponent = useMemo(
    () => ICON_MAP[card.business.icon] || ICON_MAP.document,
    [card.business.icon],
  )

  const [dragging, setDragging] = useState(false)

  const hasInputs = useMemo(() => Boolean(card.spec?.inputs?.length), [card.spec])
  const hasOutputs = useMemo(() => Boolean(card.spec?.outputs?.length), [card.spec])

  const cardClassName = [
    styles.nodeCard,
    card.business.category === 'tool' ? styles.cardTool : '',
    card.business.category === 'condition' ? styles.cardCondition : '',
    card.business.category === 'operator' ? styles.cardOperator : '',
    !available ? styles.cardDisabled : '',
    dragging ? styles.cardDragging : '',
  ]
    .filter(Boolean)
    .join(' ')

  function onDragStart(e: React.DragEvent<HTMLDivElement>) {
    if (!available) {
      e.preventDefault()
      return
    }
    setDragging(true)
    // 用 dataTransfer 传递 toolName,editor 的 onDrop 读取
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(
      'application/x-workflow-card',
      JSON.stringify({
        toolName: card.toolName,
        nodeType: card.nodeType,
      }),
    )
    // 兼容部分浏览器对 application/* 类型的处理
    e.dataTransfer.setData('text/plain', card.toolName)
    onDragstart?.(card)
  }

  function onDragEnd() {
    setDragging(false)
    onDragend?.(card)
  }

  function onHoverEnterInner() {
    if (available) onHoverEnter?.(card)
  }

  function onHoverLeaveInner() {
    onHoverLeave?.(card)
  }

  // popover 是否禁用(不可用或拖拽中不弹)— 对齐 el-popover :disabled="!available || dragging"
  const popoverDisabled = !available || dragging

  return (
    <HoverCard
      position="right"
      width={340}
      withArrow
      shadow="md"
      // 对齐 el-popover :show-after=600 / :hide-after=100
      openDelay={600}
      closeDelay={100}
    >
      <HoverCard.Target>
        <div
          className={cardClassName}
          draggable={available}
          title={available ? '' : disabledReason}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMouseEnter={onHoverEnterInner}
          onMouseLeave={onHoverLeaveInner}
        >
          {/* ① 图标 + ② 业务名(头部)*/}
          <div className={styles.cardHeader}>
            <span className={styles.cardIcon} style={{ color: accent, display: 'inline-flex' }}>
              {IconComponent && <IconComponent size={18} />}
            </span>
            <span className={styles.cardTitle}>{card.business.name}</span>
            {card.business.costLevel >= 1 && (
              <span className={styles.costStars} title={card.business.costNote || ''}>
                {'⭐'.repeat(Math.min(card.business.costLevel, 6))}
              </span>
            )}
          </div>

          {/* ③ 业务描述 */}
          <div className={styles.cardDesc}>{card.business.description}</div>

          {/* ④ 技术名(灰底小字)*/}
          <div className={styles.cardTech}>{card.toolName}</div>

          {/* ⑤ 警告 / 提示标签 */}
          {card.business.hint ? (
            <div className={styles.cardHint}>{card.business.hint}</div>
          ) : card.business.costWarning ? (
            <div className={styles.cardWarning}>{card.business.costWarning}</div>
          ) : null}

          {/* 不可用遮罩 */}
          {!available && (
            <div className={styles.cardDisabledMask}>
              <div className={styles.disabledMsg}>{disabledReason}</div>
            </div>
          )}
        </div>
      </HoverCard.Target>

      {/* popover 内容:详细说明(不可用或拖拽中不弹,对齐 :disabled)*/}
      {!popoverDisabled && (
      <HoverCard.Dropdown className={styles.popoverDropdown}>
        <div className={styles.cardTooltip}>
          <div className={styles.ttHeader}>
            <span className={styles.ttIcon} style={{ color: accent }}>
              {IconComponent && <IconComponent size={18} />}
            </span>
            <span className={styles.ttTitle}>{card.business.name}</span>
            <span className={styles.ttTech}>{card.toolName}</span>
          </div>
          <div className={styles.ttDesc}>{card.business.description}</div>

          {hasInputs && (
            <div className={styles.ttSection}>
              <div className={styles.ttSectionTitle}>{t('workflow.card.inputs')}</div>
              {card.spec.inputs.map((i: any) => (
                <div key={i.name} className={styles.ttPort}>
                  <span className={styles.ttPortName}>{i.name}</span>
                  <span className={styles.ttPortMeta}>
                    {i.type}
                    {i.required ? ' · ' + t('workflow.panel.required') : ''}
                    {i.source === 'upstream' ? ' · ' + t('workflow.card.fromUpstream') : ''}
                  </span>
                  {i.description && <div className={styles.ttPortDesc}>{i.description}</div>}
                </div>
              ))}
            </div>
          )}

          {hasOutputs && (
            <div className={styles.ttSection}>
              <div className={styles.ttSectionTitle}>{t('workflow.card.outputs')}</div>
              {card.spec.outputs.map((o: any) => (
                <div key={o.name} className={styles.ttPort}>
                  <span className={styles.ttPortName}>{o.name}</span>
                  <span className={styles.ttPortMeta}>
                    {o.type}
                    {o.serializable === false ? ' · ' + t('workflow.panel.nonSerializable') : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {card.business.typicalScenarios?.length > 0 && (
            <div className={styles.ttSection}>
              <div className={styles.ttSectionTitle}>{t('workflow.card.scenarios')}</div>
              <ul className={styles.ttList}>
                {card.business.typicalScenarios.map((s: string) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {(card.business.costNote || card.business.costLevel >= 1) && (
            <div className={styles.ttCost}>
              {t('workflow.card.cost')}
              {card.business.costNote || t('workflow.card.costFree')}
            </div>
          )}

          {card.business.suggestion && (
            <div className={styles.ttSuggestion}>💡 {card.business.suggestion}</div>
          )}

          {card.business.hint && <div className={styles.ttWarning}>{card.business.hint}</div>}
        </div>
      </HoverCard.Dropdown>
      )}
    </HoverCard>
  )
}

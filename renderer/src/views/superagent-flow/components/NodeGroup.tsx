import { useMemo, useState, useEffect, useRef } from 'react'
import { Collapse } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import NodeCard from './NodeCard'
import { CATEGORY_META, cardMatchesQuery, isCardAvailable } from '../nodeCatalog'
import styles from './NodeGroup.module.scss'

export interface NodeGroupProps {
  category: string // 'tool' | 'condition' | 'operator'
  cards: any[]
  capabilities?: any
  searchQuery?: string
  defaultExpanded?: boolean
  onCardDragstart?: (card: any) => void
  onCardDragend?: (card: any) => void
  onCardHoverEnter?: (card: any) => void
  onCardHoverLeave?: (card: any) => void
}

export default function NodeGroup({
  category,
  cards,
  capabilities = null,
  searchQuery = '',
  defaultExpanded = true,
  onCardDragstart,
  onCardDragend,
  onCardHoverEnter,
  onCardHoverLeave,
}: NodeGroupProps) {
  const { t } = useTranslation()

  const [expanded, setExpanded] = useState(defaultExpanded)

  const meta = useMemo(() => CATEGORY_META[category] || {}, [category])

  const searchActive = useMemo(() => Boolean(searchQuery?.trim()), [searchQuery])

  const matchedCards = useMemo(
    () => cards.filter((c) => cardMatchesQuery(c, searchQuery)),
    [cards, searchQuery],
  )

  // 搜索时自动展开有匹配的组,清空时恢复默认展开状态
  // 用 ref 持有最新 matchedCards.length,避免把它写进依赖导致每次匹配变化都重置展开
  const matchedCountRef = useRef(matchedCards.length)
  matchedCountRef.current = matchedCards.length
  useEffect(() => {
    if (searchActive) {
      setExpanded(matchedCountRef.current > 0)
    } else {
      setExpanded(defaultExpanded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchActive])

  function toggleExpanded() {
    setExpanded((v) => !v)
  }

  function isAvailable(card: any) {
    return isCardAvailable(card, capabilities)
  }

  function disabledReason(card: any) {
    if (!card.business?.capability) return ''
    if (isAvailable(card)) return ''
    const map: Record<string, string> = {
      has_structured: t('workflow.palette.cap.structured'),
      has_unstructured: t('workflow.palette.cap.unstructured'),
      has_metrics: t('workflow.palette.cap.metrics'),
      has_metric_views: t('workflow.palette.cap.metricViews'),
      has_web_search: t('workflow.palette.cap.webSearch'),
    }
    return map[card.business.capability] || t('workflow.palette.cap.unavailable')
  }

  return (
    <div className={`${styles.nodeGroup} ${styles[`group-${category}`] || ''}`}>
      <div className={styles.groupHeader} onClick={toggleExpanded}>
        <span className={`${styles.expandIcon} ${!expanded ? styles.collapsed : ''}`}>
          <ElSvgIcon name="ArrowDown" size={12} />
        </span>
        <span className={styles.groupEmoji}>{meta.emoji}</span>
        <span className={styles.groupLabel}>{t(meta.label)}</span>
        <span className={styles.groupCount}>
          ({matchedCards.length}
          {searchActive ? `/${cards.length}` : ''})
        </span>
        <span className={styles.groupSublabel}>— {t(meta.sublabel)}</span>
      </div>

      <Collapse in={expanded}>
        <div className={styles.groupBody}>
          {matchedCards.map((card) => (
            <NodeCard
              key={card.toolName}
              card={card}
              available={isAvailable(card)}
              disabledReason={disabledReason(card)}
              onDragstart={(c: any) => onCardDragstart?.(c)}
              onDragend={(c: any) => onCardDragend?.(c)}
              onHoverEnter={(c: any) => onCardHoverEnter?.(c)}
              onHoverLeave={(c: any) => onCardHoverLeave?.(c)}
            />
          ))}
          {!matchedCards.length && (
            <div className={styles.groupEmpty}>
              {searchActive
                ? t('workflow.palette.noMatch')
                : t('workflow.palette.emptyGroup')}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  )
}

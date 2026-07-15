import { useMemo, useState } from 'react'
import { Button, TextInput, Tooltip } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import NodeGroup from './NodeGroup'
import { groupCatalogByCategory } from '../nodeCatalog'
import styles from './NodePalette.module.scss'

export interface NodePaletteProps {
  catalog: any[]
  capabilities?: any
  // 三组默认是否展开;editor 据"新建/编辑"上下文决定
  defaultExpanded?: boolean
  refreshing?: boolean
  onCardDragstart?: (card: any) => void
  onCardDragend?: (card: any) => void
  onCardHover?: (card: any | null) => void
  onRefresh?: () => void
}

export default function NodePalette({
  catalog,
  capabilities = null,
  defaultExpanded = true,
  refreshing = false,
  onCardDragstart,
  onCardDragend,
  onCardHover,
  onRefresh,
}: NodePaletteProps) {
  const { t } = useTranslation()

  const [searchQuery, setSearchQuery] = useState('')

  // 固定的展示顺序:工具 → 条件 → 算子
  const categories = ['tool', 'condition', 'operator']

  const groupedCards = useMemo(
    () => groupCatalogByCategory(catalog),
    [catalog],
  )

  function onHoverEnter(card: any) {
    onCardHover?.(card)
  }

  function onHoverLeave() {
    onCardHover?.(null)
  }

  return (
    <div className={styles.nodePalette}>
      <div className={styles.paletteHeader}>
        <span>{t('workflow.palette.title')}</span>
        <Tooltip label={t('workflow.palette.refreshTip')} position="bottom">
          <Button
            loading={refreshing}
            variant="subtle"
            size="compact-sm"
            className={styles.refreshBtn}
            onClick={() => onRefresh?.()}
          >
            <ElSvgIcon name="Refresh" size={14} />
          </Button>
        </Tooltip>
      </div>

      <div className={styles.paletteBody}>
        {categories.map((cat) => (
          <NodeGroup
            key={cat}
            category={cat}
            cards={groupedCards[cat]}
            capabilities={capabilities}
            searchQuery={searchQuery}
            defaultExpanded={defaultExpanded}
            onCardDragstart={(c) => onCardDragstart?.(c)}
            onCardDragend={(c) => onCardDragend?.(c)}
            onCardHoverEnter={onHoverEnter}
            onCardHoverLeave={onHoverLeave}
          />
        ))}
      </div>

      <div className={styles.paletteSearch}>
        <TextInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          placeholder={t('workflow.palette.searchPlaceholder')}
          size="sm"
          // clearable → Mantine 的可清除按钮
          rightSection={
            searchQuery ? (
              <span
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer', display: 'flex' }}
                onClick={() => setSearchQuery('')}
              >
                <ElSvgIcon name="CircleClose" size={14} color="#c0c4cc" />
              </span>
            ) : undefined
          }
        />
      </div>
    </div>
  )
}

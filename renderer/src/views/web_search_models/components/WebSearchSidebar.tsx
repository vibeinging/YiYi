import { useMemo, useState } from 'react'
import { Button, Input, Badge } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './WebSearchSidebar.module.scss'

// 与源 ../composables/useWebSearchState.ts 中的 WebSearchModel 保持一致
export interface WebSearchModel {
  id: string
  model: string
  name: string
  api: string
  description?: string
  config_type?: string
  custom_config?: any
}

// 源组件的 state 为 Vue ref 包裹({ value: ... }),React 侧解包为普通值
export interface WebSearchSidebarState {
  modelList: WebSearchModel[]
  selectedModel: WebSearchModel | null
  isCollapsed: boolean
}

export interface WebSearchSidebarProps {
  state: WebSearchSidebarState
  // defineEmits → 回调 props
  onSelectModel?: (item: WebSearchModel) => void
  onCreateModel?: () => void
}

export default function WebSearchSidebar({ state, onSelectModel, onCreateModel }: WebSearchSidebarProps) {
  const { t } = useTranslation()

  // 本地搜索状态
  const [localSearchKeyword, setLocalSearchKeyword] = useState('')

  const localFilteredList = useMemo(() => {
    if (!localSearchKeyword.trim()) {
      return state.modelList
    }
    const keyword = localSearchKeyword.toLowerCase()
    return state.modelList.filter(
      (item) =>
        item.name.toLowerCase().includes(keyword) ||
        item.model.toLowerCase().includes(keyword) ||
        item.api.toLowerCase().includes(keyword),
    )
  }, [localSearchKeyword, state.modelList])

  const handleSearch = () => {
    // 搜索已通过 useMemo 自动处理
  }

  const handleSelect = (item: WebSearchModel) => {
    onSelectModel?.(item)
  }

  return (
    <div className={`${styles.dataSourceSidebar} ${state.isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarHeader}>
        <div className={styles.title}>{t('webSearch.sidebarTitle')}</div>
        <Input
          value={localSearchKeyword}
          onChange={(e) => setLocalSearchKeyword(e.currentTarget.value)}
          placeholder={t('webSearch.sidebarSearch')}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          className={styles.searchInput}
          rightSection={
            <span className={styles.searchIcon} onClick={handleSearch}>
              <ElSvgIcon name="Search" size={16} />
            </span>
          }
        />
      </div>

      <div className={styles.dataSourceList}>
        {localFilteredList.map((item) => (
          <div
            key={item.id}
            className={`${styles.dataSourceItem} ${
              state.selectedModel && state.selectedModel.id === item.id ? styles.active : ''
            }`}
            onClick={() => handleSelect(item)}
          >
            <div className={styles.dsInfo}>
              <div className={styles.dsIcon}>
                {item.model === '博查' ? (
                  <svg
                    className={styles.bochaIcon}
                    viewBox="0 0 64 64"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <circle cx="32" cy="32" r="28" fill="#0A7BFF" />
                    <circle cx="32" cy="32" r="14" fill="#ffffff" />
                    <circle cx="32" cy="32" r="9" fill="#0A7BFF" />
                    <circle cx="24" cy="24" r="6" fill="#5AB0FF" />
                  </svg>
                ) : (
                  <Badge size="sm" color="gray" variant="light">
                    {item.model}
                  </Badge>
                )}
              </div>
              <div className={styles.dsContent}>
                <div className={styles.dsName}>{item.name}</div>
                <div className={styles.dsExtra}>{item.api}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.sidebarFooter}>
        <Button className={styles.createBtn} size="sm" color="blue" onClick={() => onCreateModel?.()}>
          {t('webSearch.createModel')}
        </Button>
      </div>
    </div>
  )
}

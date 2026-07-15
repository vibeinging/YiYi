import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionIcon, Badge, Button, Center, CloseButton, Text, TextInput } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './BusinessSidebar.module.scss'

// 单条业务项(对应原 businessList item),源里无类型,用宽松结构
interface BusinessItem {
  id: string | number
  name: string
  description?: string
  data_source_count?: number
  [key: string]: any
}

// 对应原 useBusinessState() composable 暴露的状态(由主页面管理并传入)
interface BusinessStateLike {
  businessList: BusinessItem[]
  selectedBusiness: BusinessItem | null
  isCollapsed: boolean
  [key: string]: any
}

export interface BusinessSidebarProps {
  businessState: BusinessStateLike
  // defineEmits(['select-business', 'create-business']) → 回调 props
  onSelectBusiness?: (business: BusinessItem) => void
  onCreateBusiness?: () => void
}

export default function BusinessSidebar({
  businessState,
  onSelectBusiness,
  onCreateBusiness,
}: BusinessSidebarProps) {
  const { t } = useTranslation()

  // 使用状态管理(来自主页面)
  const { businessList, selectedBusiness, isCollapsed } = businessState

  // 本地搜索状态
  const [searchKeyword, setSearchKeyword] = useState('')

  const filteredList = useMemo(() => {
    if (!searchKeyword.trim()) {
      return businessList
    }
    const keyword = searchKeyword.toLowerCase()
    return businessList.filter(
      (business) =>
        business.name.toLowerCase().includes(keyword) ||
        (business.description && business.description.toLowerCase().includes(keyword)),
    )
  }, [searchKeyword, businessList])

  const handleSearch = () => {
    // 搜索已通过 computed(useMemo) 自动处理
  }

  // 处理业务点击
  const handleBusinessClick = (business: BusinessItem) => {
    onSelectBusiness?.(business)
  }

  return (
    <div className={`${styles.businessSidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarHeader}>
        <div className={styles.title}>{t('business.management')}</div>
        <TextInput
          className={styles.searchInput}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.currentTarget.value)}
          placeholder={t('business.searchPlaceholder')}
          rightSection={
            // clearable: 有内容时显示清除按钮,否则显示搜索按钮(append slot)
            searchKeyword ? (
              <CloseButton
                size="sm"
                onClick={() => setSearchKeyword('')}
                aria-label="clear"
              />
            ) : (
              <ActionIcon variant="subtle" color="gray" onClick={handleSearch}>
                <ElSvgIcon name="Search" size={16} />
              </ActionIcon>
            )
          }
        />
      </div>

      <div className={styles.businessList}>
        {filteredList.map((item) => (
          <div
            key={item.id}
            className={`${styles.businessItem} ${
              selectedBusiness?.id === item.id ? styles.active : ''
            }`}
            onClick={() => handleBusinessClick(item)}
          >
            <div className={styles.businessInfo}>
              <div className={styles.businessIcon}>
                <ElSvgIcon name="Briefcase" size={24} color="#409EFF" />
              </div>
              <div className={styles.businessContent}>
                <div className={styles.businessName}>{item.name}</div>
                <div className={styles.businessMeta}>
                  <Badge size="sm" color="gray" variant="light">
                    {(item.data_source_count || 0) + ' ' + t('business.dataSourceCount')}
                  </Badge>
                </div>
              </div>
            </div>
            {item.description && (
              <div className={styles.businessExtra}>{item.description}</div>
            )}
          </div>
        ))}

        {filteredList.length === 0 && (
          <Center py="xl">
            <Text c="dimmed" size="sm">
              {t('business.noBusiness')}
            </Text>
          </Center>
        )}
      </div>

      {/* 底部新建按钮 */}
      <div className={styles.sidebarFooter}>
        <Button className={styles.createBtn} onClick={() => onCreateBusiness?.()}>
          {t('business.createBusiness')}
        </Button>
      </div>
    </div>
  )
}

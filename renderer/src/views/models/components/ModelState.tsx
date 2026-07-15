import { useTranslation } from 'react-i18next'
import { Button } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './ModelState.module.scss'

export interface ModelStateProps {
  /** 'empty' or 'loading' */
  type?: string
  icon?: string
  title?: string
  description?: string
  actionText?: string
  onAction?: () => void
}

export default function ModelState({
  type = 'empty',
  icon = 'InfoFilled',
  title = '',
  description = '',
  actionText = '',
  onAction,
}: ModelStateProps) {
  const { t } = useTranslation()

  const handleAction = () => {
    onAction?.()
  }

  if (type === 'empty') {
    return (
      <div className={styles['empty-state']}>
        <div className={styles['empty-icon']}>
          <ElSvgIcon name={icon} size={80} color="#c0c4cc" />
        </div>
        <div className={styles['empty-title']}>{title}</div>
        <div className={styles['empty-description']}>{description}</div>
        {actionText && (
          <Button
            variant="filled"
            size="md"
            onClick={handleAction}
            className={styles['empty-action']}
            leftSection={<ElSvgIcon name="Plus" size={16} />}
          >
            {actionText}
          </Button>
        )}
      </div>
    )
  }

  if (type === 'loading') {
    return (
      <div className={styles['loading-state']}>
        <div className={styles['is-loading']}>
          <ElSvgIcon name="Loading" size={40} color="var(--el-color-primary)" />
        </div>
        <div className={styles['loading-text']}>{t('common.loading')}</div>
      </div>
    )
  }

  return null
}

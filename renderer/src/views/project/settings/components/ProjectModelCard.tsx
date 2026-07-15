import { useTranslation } from 'react-i18next'
import { Badge, Button, Tooltip } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './ProjectModelCard.module.scss'

interface ProjectModelCardProps {
  model: any
  /** 'streaming' | 'dimension' | 'default' */
  tagType?: string
  /** 当前项目是否选择了此模型 */
  isProjectSelected?: boolean
  onSelect?: (model: any) => void
}

export default function ProjectModelCard({
  model,
  tagType = 'streaming',
  isProjectSelected = false,
  onSelect,
}: ProjectModelCardProps) {
  const { t } = useTranslation()

  const handleSelect = () => {
    onSelect?.(model)
  }

  return (
    <div className={`${styles['model-card']} ${isProjectSelected ? styles['is-selected'] : ''}`}>
      <div className={styles['model-header']}>
        <div className={styles['model-title']}>
          <span className={styles['model-name']}>{model.model_name}</span>
          {isProjectSelected && (
            <Badge color="green" variant="filled" size="sm" className={styles['selected-tag']}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <ElSvgIcon name="Check" size={12} />
                {t('project.modelCard.selected')}
              </span>
            </Badge>
          )}
          {tagType === 'streaming' && model.supports_streaming ? (
            <Badge color="green" size="sm">
              {t('project.modelCard.streaming')}
            </Badge>
          ) : tagType === 'dimension' && model.dimension ? (
            <Badge color="blue" size="sm">
              {t('project.modelCard.dimension')}: {model.dimension}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className={styles['model-info']}>
        <div className={styles['info-item']}>
          <span className={styles['el-icon']}>
            <ElSvgIcon name="Link" size={16} />
          </span>
          <Tooltip label={model.api_base} position="top" disabled={!model.api_base}>
            <span className={styles['info-text']}>
              {model.api_base || t('project.modelCard.enterApiBase')}
            </span>
          </Tooltip>
        </div>
        {model.display_name && model.display_name !== model.model_name && (
          <div className={styles['info-item']}>
            <span className={styles['el-icon']}>
              <ElSvgIcon name="InfoFilled" size={16} />
            </span>
            <span className={styles['info-text']}>{model.display_name}</span>
          </div>
        )}
      </div>

      <div className={styles['model-footer']}>
        {isProjectSelected ? (
          <Tooltip label={t('project.modelCard.cancelUseTip')} position="top">
            <Button size="sm" color="gray" variant="outline" onClick={handleSelect}>
              {t('project.modelCard.cancelUse')}
            </Button>
          </Tooltip>
        ) : (
          <Tooltip label={t('project.modelCard.setDefaultTip')} position="top">
            <Button size="sm" color="primary" onClick={handleSelect}>
              {t('project.modelCard.setAsDefault')}
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

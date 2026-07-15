import { Button } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DataSourceEmptyState.module.scss'

export interface DataSourceEmptyStateProps {
  // defineEmits(['add-datasource']) → 回调 prop
  onAddDatasource?: () => void
}

export default function DataSourceEmptyState({ onAddDatasource }: DataSourceEmptyStateProps) {
  const { t } = useTranslation()

  return (
    <div className={styles.emptyPlaceholder}>
      <div className={styles.emptyContent}>
        <div className={styles.emptyIntro}>
          <h3>{t('business.dataSourceEmpty.title')}</h3>
          <p>{t('business.dataSourceEmpty.description')}</p>
        </div>

        <div className={styles.featureCard}>
          <div className={styles.featureDetails}>
            <div className={styles.detailItem}>
              <strong>{t('business.dataSourceEmpty.functionLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.functionDesc')}
            </div>
            <div className={styles.detailItem}>
              <strong>{t('business.dataSourceEmpty.supportedTypesLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.supportedTypesDesc')}
            </div>
            <div className={styles.detailItem}>
              <strong>{t('business.dataSourceEmpty.scenarioLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.scenarioDesc')}
            </div>
          </div>

          <div className={styles.exampleBox}>
            <div className={styles.exampleLabel}>{t('business.dataSourceEmpty.exampleLabel')}</div>
            <div className={styles.exampleItem}>
              <strong>{t('business.dataSourceEmpty.exampleSceneLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.exampleScene')}
            </div>
            <div className={styles.exampleItem}>
              <strong>{t('business.dataSourceEmpty.exampleLinkedLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.exampleLinked')}
            </div>
            <div className={styles.exampleItem}>
              <strong>{t('business.dataSourceEmpty.exampleUserAskLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.exampleUserAsk')}
            </div>
            <div className={styles.exampleItem}>
              <strong>{t('business.dataSourceEmpty.exampleAiAnswerLabel')}</strong>
              {' '}
              {t('business.dataSourceEmpty.exampleAiAnswer')}
            </div>
          </div>

          <p className={styles.valueSummary}>
            <strong>{t('business.dataSourceEmpty.coreValueLabel')}</strong>
            {' '}
            {t('business.dataSourceEmpty.coreValue')}
          </p>

          <div className={styles.actionButtons}>
            <Button
              variant="filled"
              size="sm"
              leftSection={<ElSvgIcon name="Plus" size={16} />}
              onClick={() => onAddDatasource?.()}
            >
              {t('business.dataSourceEmpty.addDataSource')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

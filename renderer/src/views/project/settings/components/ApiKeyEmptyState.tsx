import { Button } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './ApiKeyEmptyState.module.scss'

interface ApiKeyEmptyStateProps {
  // defineEmits(['create-key']) → 回调 prop
  onCreateKey?: () => void
}

export default function ApiKeyEmptyState({ onCreateKey }: ApiKeyEmptyStateProps) {
  const { t } = useTranslation()

  return (
    <div className={styles['empty-placeholder']}>
      <div className={styles['empty-content']}>
        <div className={styles['empty-intro']}>
          <h3>{t('project.apiKey.whatIsApiKey')}</h3>
          <p>{t('project.apiKey.apiKeyDescription')}</p>
        </div>

        <div className={styles['feature-card']}>
          <div className={styles['feature-details']}>
            <div className={styles['detail-item']}>
              <strong>{t('project.apiKey.featureLabel')}</strong>
              {t('project.apiKey.featureDesc')}
            </div>
            <div className={styles['detail-item']}>
              <strong>{t('project.apiKey.useCasesLabel')}</strong>
              {t('project.apiKey.useCasesDesc')}
            </div>
            <div className={styles['detail-item']}>
              <strong>{t('project.apiKey.securityLabel')}</strong>
              {t('project.apiKey.securityDesc')}
            </div>
          </div>

          <div className={styles['example-box']}>
            <div className={styles['example-label']}>{t('project.apiKey.exampleLabel')}</div>
            <div className={styles['example-item']}>
              <strong>{t('project.apiKey.step1Label')}</strong>
              {t('project.apiKey.step1Desc')}
            </div>
            <div className={styles['example-item']}>
              <strong>{t('project.apiKey.step2Label')}</strong>
              {t('project.apiKey.step2Desc')}
            </div>
            <div className={styles['example-item']}>
              <strong>{t('project.apiKey.step3Label')}</strong>
              {t('project.apiKey.step3Desc')}
            </div>
            <div className={styles['example-item']}>
              <strong>{t('project.apiKey.step4Label')}</strong>
              {t('project.apiKey.step4Desc')}
            </div>
          </div>

          <p className={styles['value-summary']}>
            <strong>{t('project.apiKey.bestPracticeLabel')}</strong>
            {t('project.apiKey.bestPracticeDesc')}
          </p>

          <div className={styles['action-buttons']}>
            <Button
              color="primary"
              size="sm"
              className={styles['card-action']}
              leftSection={<ElSvgIcon name="Plus" />}
              onClick={() => onCreateKey?.()}
            >
              {t('project.apiKey.createFirstKey')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

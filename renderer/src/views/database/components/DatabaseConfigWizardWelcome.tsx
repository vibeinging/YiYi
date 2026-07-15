import { Button } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DatabaseConfigWizardWelcome.module.scss'

export interface DatabaseConfigWizardWelcomeProps {
  databaseId?: string
  database?: any
  onStartConfig?: () => void
}

export default function DatabaseConfigWizardWelcome({
  onStartConfig,
}: DatabaseConfigWizardWelcomeProps) {
  const { t } = useTranslation()

  // 开始配置
  const handleStartConfig = () => {
    onStartConfig?.()
  }

  return (
    <div className={styles['config-wizard-welcome']}>
      {/* 页面头部 */}
      <div className={styles['page-header']}>
        <h1 className={styles['page-title']}>{t('database.guide.welcome.pageTitle')}</h1>
        <p className={styles['page-desc']}>{t('database.guide.welcome.pageDesc')}</p>
      </div>

      {/* 欢迎卡片 */}
      <div className={styles['welcome-card']}>
        <div className={styles['welcome-content']}>
          <div className={styles['welcome-icon']}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ width: '48px', height: '48px' }}
            >
              {/* 火箭主体 */}
              <path d="M12 2L8 8L12 10L16 8L12 2Z" fill="currentColor" opacity="0.9" />
              <path d="M12 10L8 12L12 18L16 12L12 10Z" fill="currentColor" />
              {/* 火箭尾翼 */}
              <path d="M8 12L6 14L8 16L8 12Z" fill="currentColor" opacity="0.7" />
              <path d="M16 12L18 14L16 16L16 12Z" fill="currentColor" opacity="0.7" />
              {/* 火焰 */}
              <path d="M10 18L12 20L14 18L12 22L10 18Z" fill="currentColor" opacity="0.6" />
              <path d="M11 18L12 19L13 18L12 20L11 18Z" fill="currentColor" opacity="0.8" />
            </svg>
          </div>
          <div className={styles['welcome-text']}>
            <h2 className={styles['welcome-title']}>{t('database.guide.welcome.title')}</h2>
            <p className={styles['welcome-desc']}>{t('database.guide.welcome.desc')}</p>
            <div className={styles['welcome-features']}>
              <div className={styles['feature-item']}>
                <div className={styles['feature-icon']}>
                  <ElSvgIcon name="Check" size={12} />
                </div>
                <span>{t('database.guide.welcome.feature1')}</span>
              </div>
              <div className={styles['feature-item']}>
                <div className={styles['feature-icon']}>
                  <ElSvgIcon name="Check" size={12} />
                </div>
                <span>{t('database.guide.welcome.feature2')}</span>
              </div>
              <div className={styles['feature-item']}>
                <div className={styles['feature-icon']}>
                  <ElSvgIcon name="Check" size={12} />
                </div>
                <span>{t('database.guide.welcome.feature3')}</span>
              </div>
              <div className={styles['feature-item']}>
                <div className={styles['feature-icon']}>
                  <ElSvgIcon name="Check" size={12} />
                </div>
                <span>{t('database.guide.welcome.feature4')}</span>
              </div>
            </div>
            <div className={styles['welcome-actions']}>
              <Button
                size="md"
                onClick={handleStartConfig}
                rightSection={<ElSvgIcon name="ArrowRight" size={16} />}
              >
                {t('database.guide.welcome.startConfig')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 配置步骤预览 */}
      <div className={styles['steps-preview-card']}>
        <div className={styles['card-header']}>
          <div className={styles['card-title']}>{t('database.guide.welcome.stepsPreview')}</div>
        </div>
        <div className={styles['card-body']}>
          <div className={styles['step-preview-item']}>
            <div className={styles['step-preview-icon']}>1</div>
            <div className={styles['step-preview-content']}>
              <div className={styles['step-preview-title']}>{t('database.guide.welcome.step1Title')}</div>
              <div className={styles['step-preview-desc']}>{t('database.guide.welcome.step1Desc')}</div>
            </div>
          </div>
          <div className={styles['step-preview-item']}>
            <div className={styles['step-preview-icon']}>2</div>
            <div className={styles['step-preview-content']}>
              <div className={styles['step-preview-title']}>{t('database.guide.welcome.step2Title')}</div>
              <div className={styles['step-preview-desc']}>{t('database.guide.welcome.step2Desc')}</div>
            </div>
          </div>
          <div className={styles['step-preview-item']}>
            <div className={styles['step-preview-icon']}>3</div>
            <div className={styles['step-preview-content']}>
              <div className={styles['step-preview-title']}>{t('database.guide.welcome.step3Title')}</div>
              <div className={styles['step-preview-desc']}>{t('database.guide.welcome.step3Desc')}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

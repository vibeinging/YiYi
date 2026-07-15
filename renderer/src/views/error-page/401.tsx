import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@mantine/core'
import styles from './401.module.scss'

export default function V401() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const goHome = () => {
    navigate('/projects')
  }

  return (
    <div className={styles.errorPage}>
      <div className={styles.errorContent}>
        <div className={styles.errorCode}>401</div>
        <h1 className={styles.errorTitle}>{t('errorPage.401.title')}</h1>
        <p className={styles.errorDesc}>{t('errorPage.401.desc')}</p>
        <Button color="primary" onClick={goHome}>
          {t('errorPage.backHome')}
        </Button>
      </div>
    </div>
  )
}

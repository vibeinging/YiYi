// 后台-模型管理。复用 models 页面组件(内嵌模式)
import { useTranslation } from 'react-i18next'
import ModelsPage from '@/views/models/index'
import styles from './ModelManagement.module.scss'

export default function ModelManagement() {
  const { t } = useTranslation()

  return (
    <div className={styles['admin-model-management']}>
      {/* 页面头部 */}
      <div className={styles['page-header']}>
        <div className={styles['header-left']}>
          <h1>{t('admin.models.title')}</h1>
          <p>{t('admin.models.subtitle')}</p>
        </div>
      </div>

      {/* 复用 models 页面组件 */}
      <div className={styles['content-wrapper']}>
        <ModelsPage readonly={false} showHeader={false} />
      </div>
    </div>
  )
}

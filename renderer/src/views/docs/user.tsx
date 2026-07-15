import { useTranslation } from 'react-i18next'
import DocViewer from '@/components/DocViewer'

// 用户文档视图：直接复用已迁移的 DocViewer 组件，doc-type="user"
export default function User() {
  const { t } = useTranslation()

  return <DocViewer docType="user" title={t('docs.user.title')} theme="light" />
}

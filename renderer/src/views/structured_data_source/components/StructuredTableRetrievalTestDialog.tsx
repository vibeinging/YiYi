import { useTranslation } from 'react-i18next'
import SchemaRetrievalTestDialog from '@/components/schema-retrieval/SchemaRetrievalTestDialog'
import { searchRelevantTablesReq } from '@/api/structured_data_source/document'
import { useProjectStore, projectGetters } from '@/store/project'

interface StructuredTableRetrievalTestDialogProps {
  opened?: boolean
  modelValue?: boolean
  dataSourceId: string
  onOpenedChange?: (value: boolean) => void
  onUpdateModelValue?: (value: boolean) => void
  onClose?: () => void
}

export default function StructuredTableRetrievalTestDialog({
  opened,
  modelValue = false,
  dataSourceId,
  onOpenedChange,
  onUpdateModelValue,
  onClose
}: StructuredTableRetrievalTestDialogProps) {
  const { t } = useTranslation()
  const currentProjectId = useProjectStore((state) => projectGetters.currentProjectId(state))
  const isOpen = opened ?? modelValue

  const handleClose = () => {
    onOpenedChange?.(false)
    onUpdateModelValue?.(false)
    onClose?.()
  }

  const handleSearch = (question: string, topK: number) =>
    searchRelevantTablesReq(currentProjectId, dataSourceId, question, 'column_first', topK)

  return (
    <SchemaRetrievalTestDialog
      opened={isOpen}
      title={t('structuredData.testRetrievalTitle')}
      queryPlaceholder={t('structuredData.testQuestionPlaceholder')}
      onClose={handleClose}
      onSearch={handleSearch}
    />
  )
}

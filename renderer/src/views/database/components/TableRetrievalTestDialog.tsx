import { useTranslation } from 'react-i18next'
import SchemaRetrievalTestDialog from '@/components/schema-retrieval/SchemaRetrievalTestDialog'
import { searchRelevantTablesReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'

interface TableRetrievalTestDialogProps {
  opened?: boolean
  onClose?: () => void
  modelValue?: boolean
  databaseId: string
  'onUpdate:modelValue'?: (value: boolean) => void
}

export default function TableRetrievalTestDialog(props: TableRetrievalTestDialogProps) {
  const { databaseId } = props
  const { t } = useTranslation()
  const currentProjectId = useProjectStore((state) => projectGetters.currentProjectId(state))
  const opened = props.opened ?? props.modelValue ?? false

  const handleClose = () => {
    if (props.onClose) {
      props.onClose()
      return
    }
    props['onUpdate:modelValue']?.(false)
  }

  const handleSearch = (question: string, topK: number) =>
    searchRelevantTablesReq(currentProjectId, databaseId, question, 0.5, topK)

  return (
    <SchemaRetrievalTestDialog
      opened={opened}
      title={t('database.retrievalTest.title')}
      queryPlaceholder={t('database.retrievalTest.questionPlaceholder')}
      onClose={handleClose}
      onSearch={handleSearch}
    />
  )
}

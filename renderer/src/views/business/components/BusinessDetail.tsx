// TODO(migration): el-descriptions 无 Mantine 等价物 → 用 Table 自建单列带边框的描述列表
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Group, Modal, Table } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import { deleteBusinessReq } from '@/api/business'
import { useProjectStore, projectGetters } from '@/store/project'
import BusinessForm, { type BusinessFormRef } from './BusinessForm'
import styles from './BusinessDetail.module.scss'

interface BusinessDetailProps {
  business: Record<string, any>
  /** 业务更新成功 */
  onUpdated?: (payload: { id: any }) => void
  /** 业务删除成功 */
  onDeleted?: (businessId: any) => void
}

export default function BusinessDetail(props: BusinessDetailProps) {
  const { business, onUpdated, onDeleted } = props

  const { t } = useTranslation()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  const [editDialogVisible, setEditDialogVisible] = useState(false)
  const editFormRef = useRef<BusinessFormRef>(null)
  const [editFormData, setEditFormData] = useState<Record<string, any>>({})

  // 编辑业务
  const handleEdit = () => {
    setEditFormData({
      id: business.id,
      name: business.name,
      description: business.description
    })
    setEditDialogVisible(true)
  }

  // 编辑保存成功
  const handleEditSaved = (businessId: any) => {
    setEditDialogVisible(false)
    onUpdated?.({ id: businessId })
  }

  // 删除业务
  const handleDelete = () => {
    modals.openConfirmModal({
      title: t('business.message.deleteTitle'),
      children: t('business.message.deleteConfirm'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteBusinessReq(currentProjectId, business.id)
          notifications.show({ color: 'green', message: t('business.message.deleteSuccess') })
          onDeleted?.(business.id)
        } catch (error: any) {
          console.error('删除业务失败:', error)
          notifications.show({
            color: 'red',
            message: error.response?.data?.message || t('business.message.deleteFailed')
          })
        }
      }
    })
  }

  return (
    <div className={styles.businessDetailContainer}>
      <div className={styles.detailHeader}>
        <div className={styles.headerLeft}>
          <h2 className={styles.businessTitle}>{business.name}</h2>
          <Badge size="sm" color="gray" variant="light">
            {business.data_source_count || 0} {t('business.dataSourceCount')}
          </Badge>
        </div>
        <div className={styles.headerActions}>
          <Button size="sm" variant="default" onClick={handleEdit} leftSection={<ElSvgIcon name="Edit" size={16} />}>
            {t('business.edit')}
          </Button>
          <Button size="sm" color="red" onClick={handleDelete}>
            <ElSvgIcon name="Delete" size={16} />
          </Button>
        </div>
      </div>

      <div className={styles.detailContent}>
        <Table withTableBorder withColumnBorders className={styles.descriptions}>
          <Table.Tbody>
            <Table.Tr>
              <Table.Th className={styles.descLabel}>{t('business.form.name')}</Table.Th>
              <Table.Td>{business.name}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th className={styles.descLabel}>{t('business.form.description')}</Table.Th>
              <Table.Td>
                {business.description ? (
                  <span>{business.description}</span>
                ) : (
                  <span className={styles.emptyText}>{t('business.noDescription')}</span>
                )}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </div>

      {/* 编辑对话框 */}
      <Modal
        opened={editDialogVisible}
        onClose={() => setEditDialogVisible(false)}
        title={t('business.editBusiness')}
        size={600}
      >
        <BusinessForm
          ref={editFormRef}
          initialData={editFormData}
          onSaved={handleEditSaved}
          onCancel={() => setEditDialogVisible(false)}
        />
      </Modal>
    </div>
  )
}

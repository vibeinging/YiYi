import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Modal, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconCoin,
  IconEdit,
  IconLink,
  IconFileDescription,
  IconFolderOpen,
  IconWand,
  IconTrash
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { updateDatabaseReq, generateDatabaseDescriptionReq } from '@/api/database'
import { projectGetters, useProjectStore } from '@/store/project'
import DatabaseConnectionForm, {
  type DatabaseConnectionFormHandle
} from './DatabaseConnectionForm'
import styles from './DatabaseConnectionInfo.module.scss'

// defineProps({ database }) + defineEmits(['delete', 'database-updated'])
interface DatabaseConnectionInfoProps {
  database: Record<string, any>
  onDelete?: (database: any) => void
  onDatabaseUpdated?: (database: any) => void
}

export default function DatabaseConnectionInfo({
  database,
  onDelete,
  onDatabaseUpdated
}: DatabaseConnectionInfoProps) {
  const { t } = useTranslation()

  // projectStore.currentProjectId
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const [descriptionEditMode, setDescriptionEditMode] = useState(false)
  const [generatingDatabaseDesc, setGeneratingDatabaseDesc] = useState(false)
  const [savingDbDesc, setSavingDbDesc] = useState(false)
  const [databaseDescription, setDatabaseDescription] = useState('')

  // watch(() => props.database?.description, ..., { immediate: true })
  // 仅在非编辑态时同步外部描述
  useEffect(() => {
    if (!descriptionEditMode) {
      setDatabaseDescription(database?.description || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database?.description])

  // 解析 Schema 配置
  const schemaConfig = useMemo<any>(() => {
    if (!database.schema_config) return null
    try {
      return JSON.parse(database.schema_config)
    } catch (e) {
      console.warn('解析schema_config失败:', e)
      return null
    }
  }, [database.schema_config])

  // 解析扩展配置
  const extraConfig = useMemo<any>(() => {
    if (!database.extra_config) return null
    try {
      return JSON.parse(database.extra_config)
    } catch (e) {
      console.warn('解析extra_config失败:', e)
      return null
    }
  }, [database.extra_config])

  // 编辑对话框状态
  const [editDialogVisible, setEditDialogVisible] = useState(false)
  const editFormRef = useRef<DatabaseConnectionFormHandle>(null)
  // editForm（透传给 DatabaseConnectionForm 的 initialData）
  const [editForm, setEditForm] = useState<Record<string, any>>({
    id: -1,
    name: '',
    host: '',
    username: '',
    password: '',
    database: '',
    port: '',
    db_type: '',
    description: '',
    retrieval_mode: 'table',
    table_limit: 5,
    sqlite_attached_dbs: [],
    schema_config: null,
    extra_config: null,
    default_schema: '',
    available_schemas: [],
    supports_multiple_schemas: false
  })

  // 编辑数据库
  const handleEdit = () => {
    // 解析schema_config
    let schemaData: Record<string, any> = {
      default_schema: '',
      available_schemas: [],
      supports_multiple_schemas: false
    }

    if (database.schema_config) {
      try {
        const parsed = JSON.parse(database.schema_config)
        schemaData = {
          default_schema: parsed.default_schema || '',
          available_schemas: parsed.available_schemas || [],
          supports_multiple_schemas: parsed.supports_multiple_schemas || false
        }
      } catch (e) {
        console.warn('解析schema_config失败:', e)
      }
    }

    // 解析extra_config
    let retrievalMode = 'table'
    let tableLimit = 5
    if (database.extra_config) {
      try {
        const parsed = JSON.parse(database.extra_config)
        retrievalMode = parsed.retrieval_mode || 'table'
        tableLimit = parsed.table_limit || 5
      } catch (e) {
        console.warn('解析extra_config失败:', e)
      }
    }

    // 复制数据库信息到编辑表单
    setEditForm({
      id: database.id,
      name: database.name,
      host: database.host,
      username: database.username,
      password: '', // 密码不回显
      database: database.database,
      port: database.port,
      db_type: database.db_type,
      description: database.description || '',
      retrieval_mode: retrievalMode,
      table_limit: tableLimit,
      sqlite_attached_dbs: database.sqlite_attached_dbs || [],
      schema_config: database.schema_config,
      extra_config: database.extra_config,
      ...schemaData
    })

    setEditDialogVisible(true)
  }

  const handleToggleEditDescription = () => {
    if (descriptionEditMode) {
      setDatabaseDescription(database?.description || '')
      setDescriptionEditMode(false)
      return
    }
    setDatabaseDescription(database?.description || '')
    setDescriptionEditMode(true)
  }

  const handleSaveDatabaseDescription = async () => {
    if (!currentProjectId || !database?.id) return
    setSavingDbDesc(true)
    try {
      const res: any = await updateDatabaseReq(currentProjectId, {
        id: database.id,
        description: databaseDescription
      })
      if (res.success) {
        notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescSaved') })
        setDescriptionEditMode(false)
        onDatabaseUpdated?.({
          ...database,
          ...(res.data || {}),
          description: databaseDescription
        })
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.guide.metadata.dbDescSaveFailed')
        })
      }
    } catch (error) {
      console.error('保存数据库描述失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.metadata.dbDescSaveFailed') })
    } finally {
      setSavingDbDesc(false)
    }
  }

  const handleGenerateDatabaseDescription = async () => {
    if (!currentProjectId || !database?.id) return
    setGeneratingDatabaseDesc(true)
    try {
      const res: any = await generateDatabaseDescriptionReq(currentProjectId, database.id)
      if (res.success && res.data) {
        setDatabaseDescription(res.data.description || databaseDescription)
        notifications.show({
          color: 'green',
          message: t('database.guide.metadata.dbDescGenerateComplete')
        })
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.guide.metadata.dbDescGenerateFailed')
        })
      }
    } catch (error) {
      console.error('生成数据库描述失败:', error)
      notifications.show({
        color: 'red',
        message: t('database.guide.metadata.dbDescGenerateFailed')
      })
    } finally {
      setGeneratingDatabaseDesc(false)
    }
  }

  // 编辑保存成功处理
  // 注：迁移后的 DatabaseConnectionForm 的 onSaved 回调透传 databaseId
  const handleEditSaved = (databaseId: string | null) => {
    setEditDialogVisible(false)
    notifications.show({ color: 'green', message: t('database.connInfo.updateSuccess') })

    // 通知父组件数据库已更新，触发数据刷新
    onDatabaseUpdated?.({
      id: databaseId ?? database.id
    })
  }

  // 删除数据库
  const handleDelete = () => {
    modals.openConfirmModal({
      title: t('database.connInfo.deleteConfirmTitle'),
      children: t('database.connInfo.deleteConfirmMsg', { name: database.name }),
      labels: {
        confirm: t('database.connInfo.confirmDelete'),
        cancel: t('database.action.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        onDelete?.(database)
      }
    })
  }

  const retrievalModeLabel =
    extraConfig?.retrieval_mode === 'table'
      ? t('database.connInfo.tableRetrieval')
      : extraConfig?.retrieval_mode === 'column'
        ? t('database.connInfo.columnRetrieval')
        : t('database.connInfo.tableRetrieval')

  return (
    <div className={`${styles.settingsRoot} tab-container`}>
      {/* 统一的内容卡片 */}
      <div className={`${styles.settingsCard} content-card`}>
        {/* 顶部操作区 */}
        <div className={styles.operationsHeader}>
          <div className={styles.headerTitle}>
            <IconCoin size={20} color="var(--yiw-accent, #17483e)" />
            <h3>{database.name}</h3>
            <span className={styles.dbTypeBadge}>{database.db_type}</span>
          </div>
          <div className={styles.headerActions}>
            <Button
              variant="default"
              size="sm"
              leftSection={<IconEdit size={16} />}
              onClick={handleEdit}
            >
              {t('database.connInfo.editConnection')}
            </Button>
            <Button
              variant="light"
              color="red"
              size="sm"
              leftSection={<IconTrash size={16} />}
              onClick={handleDelete}
            >
              {t('database.action.delete')}
            </Button>
          </div>
        </div>

        {/* 内容区域 */}
        <div className={`${styles.settingsScroll} scrollable-content`}>
          {/* 连接与认证信息 */}
          <div className={`${styles.infoSection} connection-section`}>
            <div className={styles.sectionHeader}>
              <IconLink size={18} color="var(--yiw-accent, #17483e)" />
              <span>{t('database.connInfo.connectionAuth')}</span>
            </div>
            <div className={styles.sectionContent}>
              <div className={styles.infoColumns}>
                <div className={styles.infoColumn}>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.connInfo.hostAddress')}</span>
                    <span className={styles.infoValue}>{database.host}</span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.info.port')}</span>
                    <span className={styles.infoValue}>{database.port}</span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.connInfo.databaseName')}</span>
                    <span className={styles.infoValue}>{database.database}</span>
                  </div>

                  {/* 召回模式 */}
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.connInfo.retrievalMode')}</span>
                    <span className={styles.infoValue}>
                      <Badge
                        color={extraConfig?.retrieval_mode === 'column' ? 'green' : 'blue'}
                        size="sm"
                      >
                        {retrievalModeLabel}
                      </Badge>
                    </span>
                  </div>

                  {/* 表召回数量：仅在表召回模式下显示 */}
                  {extraConfig?.retrieval_mode !== 'column' && (
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>
                        {t('database.connInfo.tableRetrievalCount')}
                      </span>
                      <span className={styles.infoValue}>{extraConfig?.table_limit || 5}</span>
                    </div>
                  )}
                </div>
                <div className={styles.infoColumn}>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.info.username')}</span>
                    <span className={styles.infoValue}>{database.username}</span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.form.password')}</span>
                    <span className={`${styles.infoValue} ${styles.passwordMask}`}>••••••••</span>
                  </div>

                  {/* Schema配置信息 (PostgreSQL/Oracle) */}
                  {schemaConfig &&
                    schemaConfig.supports_multiple_schemas &&
                    schemaConfig.default_schema && (
                      <div className={styles.infoItem}>
                        <span className={styles.infoLabel}>
                          {t('database.connInfo.defaultSchema')}
                        </span>
                        <span className={styles.infoValue}>{schemaConfig.default_schema}</span>
                      </div>
                    )}

                  {/* SQLite附加数据库 (仅SQLite显示) */}
                  {database.db_type === 'SQLite' &&
                    database.sqlite_attached_dbs?.length > 0 && (
                      <div className={styles.attachedDbs}>
                        <div className={styles.attachedHeader}>
                          <IconFolderOpen size={14} color="var(--yiw-accent, #17483e)" />
                          <span>{t('database.connInfo.attachedDatabases')}</span>
                        </div>
                        {database.sqlite_attached_dbs.map((db: any, index: number) => (
                          <div className={styles.infoItem} key={index}>
                            <span className={styles.infoLabel}>{db.alias}</span>
                            <span className={styles.infoValue}>{db.path}</span>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            </div>
          </div>

          {/* 描述信息 */}
          <div className={`${styles.infoSection} description-section`}>
            <div className={styles.sectionHeader}>
              <IconFileDescription size={18} color="var(--yiw-accent, #17483e)" />
              <span>{t('database.connInfo.descriptionInfo')}</span>
              <Button
                variant="transparent"
                size="compact-sm"
                className={styles.aiGenerateBtn}
                leftSection={<IconEdit size={14} />}
                onClick={handleToggleEditDescription}
              >
                {descriptionEditMode ? t('database.action.cancel') : t('database.action.edit')}
              </Button>
            </div>
            <div className={styles.sectionContent}>
              {descriptionEditMode ? (
                <div className={styles.descriptionEditor}>
                  <Textarea
                    value={databaseDescription}
                    onChange={(e) => setDatabaseDescription(e.currentTarget.value)}
                    autosize
                    minRows={4}
                    maxRows={8}
                    placeholder={t('database.guide.metadata.dbDescPlaceholder')}
                    disabled={savingDbDesc}
                  />
                  <div className={styles.descriptionActions}>
                    <Button
                      variant="default"
                      size="xs"
                      loading={generatingDatabaseDesc}
                      disabled={savingDbDesc}
                      leftSection={<IconWand size={14} />}
                      onClick={handleGenerateDatabaseDescription}
                    >
                      {t('database.guide.metadata.aiGenerate')}
                    </Button>
                    <Button
                      color="green"
                      size="xs"
                      loading={savingDbDesc}
                      onClick={handleSaveDatabaseDescription}
                    >
                      {t('database.action.save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={styles.descriptionText}>
                  {databaseDescription || t('database.connInfo.noDescription')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 编辑数据库对话框 */}
      <Modal
        opened={editDialogVisible}
        onClose={() => setEditDialogVisible(false)}
        title={t('database.connInfo.editDbConnection')}
        size="80%"
        closeOnClickOutside={false}
        yOffset="1vh"
        className={styles.editModal}
      >
        <DatabaseConnectionForm
          ref={editFormRef}
          initialData={editForm}
          onSaved={handleEditSaved}
          onCancel={() => setEditDialogVisible(false)}
        />
      </Modal>
    </div>
  )
}

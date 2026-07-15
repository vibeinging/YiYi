import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Center, Checkbox, Loader, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import {
  IconArrowLeft,
  IconArrowRight,
  IconRefresh,
  IconLoader2,
  IconInfoCircle
} from '@tabler/icons-react'
import { discoverSchemasReq, updateDatabaseReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './GuideStepSchema.module.scss'

interface GuideStepSchemaProps {
  projectId: string
  database?: any
  databaseId?: string | null
  onPrev?: () => void
  onSchemaSaved?: (data: any) => void
}

// 默认 Schema 映射
const defaultSchemaMap: Record<string, string | null> = {
  PostgreSQL: 'public',
  Oracle: null, // 用户名
  SQLServer: 'dbo',
  OpenGauss: 'public',
  SQLite: 'main'
}

export default function GuideStepSchema(props: GuideStepSchemaProps) {
  const { database = null, databaseId = null, onPrev, onSchemaSaved } = props
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // 状态
  const [fetchingSchemas, setFetchingSchemas] = useState(false)
  const [saving, setSaving] = useState(false)
  const [availableSchemas, setAvailableSchemas] = useState<string[]>([])
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>([])

  // 是否全选
  const isAllSelected = useMemo(() => {
    return availableSchemas.length > 0 && selectedSchemas.length === availableSchemas.length
  }, [availableSchemas, selectedSchemas])

  // 判断是否是默认 Schema
  const isDefaultSchema = (schema: string) => {
    if (!database) return false
    const defaultSchema = defaultSchemaMap[database.db_type]
    return schema === defaultSchema
  }

  // 切换 Schema 选择
  const toggleSchema = (schema: string) => {
    setSelectedSchemas((prev) => {
      const index = prev.indexOf(schema)
      if (index > -1) {
        const next = [...prev]
        next.splice(index, 1)
        return next
      }
      return [...prev, schema]
    })
  }

  // 全选/取消全选
  const handleSelectAll = () => {
    if (isAllSelected) {
      setSelectedSchemas([])
    } else {
      setSelectedSchemas([...availableSchemas])
    }
  }

  // 获取 Schema 列表
  // 用 ref 保存最新引用，便于 onMounted 中调用而不触发额外依赖
  const handleFetchSchemasRef = useRef<() => Promise<void>>(async () => {})

  const handleFetchSchemas = async () => {
    if (!database) {
      notifications.show({ color: 'yellow', message: t('database.guide.schema.createDbFirst') })
      return
    }

    setFetchingSchemas(true)

    try {
      const payload: any = {
        host: database.host,
        port: database.port,
        username: database.username,
        password: database.password,
        database: database.database,
        db_type: database.db_type,
        connection_id: databaseId
      }

      // Oracle 特殊处理
      if (database.db_type === 'Oracle' && database.extra_config) {
        try {
          const extraConfig = JSON.parse(database.extra_config)
          payload.extra_config = JSON.stringify({
            oracle_conn_type: extraConfig.oracle_conn_type || 'service_name'
          })
        } catch (e) {
          // ignore
        }
      }

      const res: any = await discoverSchemasReq(currentProjectId, payload)

      if (res.success && res.data) {
        const schemas: string[] = res.data || []
        setAvailableSchemas(schemas)

        // 默认选中默认 Schema
        setSelectedSchemas((prevSelected) => {
          if (schemas.length > 0 && prevSelected.length === 0) {
            const defaultSchema = defaultSchemaMap[database.db_type]
            if (defaultSchema && schemas.includes(defaultSchema)) {
              return [defaultSchema]
            }
            // 没有默认 Schema，选中第一个
            return [schemas[0]]
          }
          return prevSelected
        })

        notifications.show({
          color: 'green',
          message: t('database.guide.schema.detected', { count: schemas.length })
        })
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.guide.schema.fetchFailed')
        })
      }
    } catch (error) {
      console.error('获取 Schema 列表失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.schema.fetchFailed') })
    } finally {
      setFetchingSchemas(false)
    }
  }
  handleFetchSchemasRef.current = handleFetchSchemas

  // 上一步
  const handlePrev = () => {
    onPrev?.()
  }

  // 确认选择
  const handleConfirm = async () => {
    if (selectedSchemas.length === 0) {
      notifications.show({
        color: 'yellow',
        message: t('database.guide.schema.selectAtLeastOne')
      })
      return
    }

    setSaving(true)

    try {
      // 保存 Schema 配置
      const schemaConfig = {
        selected_schemas: selectedSchemas,
        available_schemas: availableSchemas
      }

      const res: any = await updateDatabaseReq(currentProjectId, {
        id: databaseId,
        schema_config: JSON.stringify(schemaConfig)
      })

      if (res.success) {
        notifications.show({ color: 'green', message: t('database.guide.schema.saveSuccess') })
        onSchemaSaved?.(res.data)
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.guide.schema.saveFailed')
        })
      }
    } catch (error) {
      console.error('保存 Schema 配置失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.schema.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  // 初始化（对应 onMounted）
  useEffect(() => {
    let restoredSchemas: string[] = []
    // 如果有已保存的 Schema 配置，恢复选择
    if (database?.schema_config) {
      try {
        const config = JSON.parse(database.schema_config)
        restoredSchemas = config.available_schemas || []
        setAvailableSchemas(config.available_schemas || [])
        setSelectedSchemas(config.selected_schemas || [])
      } catch (e) {
        // ignore
      }
    }

    // 如果没有 Schema 列表，自动获取
    if (restoredSchemas.length === 0) {
      handleFetchSchemasRef.current()
    }
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听 database 变化
  useEffect(() => {
    if (database?.schema_config) {
      try {
        const config = JSON.parse(database.schema_config)
        setAvailableSchemas(config.available_schemas || [])
        setSelectedSchemas(config.selected_schemas || [])
      } catch (e) {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database])

  return (
    <div className={styles.guideStepSchema}>
      <div className={styles.stepHeader}>
        <h2 className={styles.stepTitle}>{t('database.guide.schema.title')}</h2>
        <p className={styles.stepDesc}>{t('database.guide.schema.desc')}</p>
      </div>

      <div className={styles.stepContent}>
        <div className={styles.contentCard}>
          {/* Schema 列表 */}
          <div className={styles.schemaSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                {t('database.guide.schema.availableSchemas')}
              </span>
              <div className={styles.sectionActions}>
                <Button
                  size="xs"
                  variant="default"
                  onClick={handleFetchSchemas}
                  loading={fetchingSchemas}
                  leftSection={<IconRefresh size={14} />}
                >
                  {t('database.guide.schema.fetchSchemas')}
                </Button>
                <Button size="xs" variant="light" onClick={handleSelectAll}>
                  {isAllSelected
                    ? t('database.guide.schema.deselectAll')
                    : t('database.guide.schema.selectAll')}
                </Button>
              </div>
            </div>

            {fetchingSchemas ? (
              <div className={styles.schemaLoading}>
                <IconLoader2 size={18} className={styles.isLoading} />
                <span>{t('database.guide.schema.fetching')}</span>
              </div>
            ) : availableSchemas.length === 0 ? (
              <div className={styles.schemaEmpty}>
                <Center>
                  <Text c="dimmed" size="sm">
                    {t('database.guide.schema.empty')}
                  </Text>
                </Center>
              </div>
            ) : (
              <div className={styles.schemaList}>
                <div className={styles.schemaCheckboxGroup}>
                  {availableSchemas.map((schema) => (
                    <div
                      key={schema}
                      className={`${styles.schemaItem} ${
                        selectedSchemas.includes(schema) ? styles.selected : ''
                      }`}
                      onClick={() => toggleSchema(schema)}
                    >
                      <Checkbox
                        checked={selectedSchemas.includes(schema)}
                        onChange={() => toggleSchema(schema)}
                        onClick={(e) => e.stopPropagation()}
                        label={<span className={styles.schemaName}>{schema}</span>}
                      />
                      {isDefaultSchema(schema) && (
                        <span className={styles.schemaBadge}>
                          {t('database.guide.schema.default')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.schemaSummary}>
              {t('database.guide.schema.selectedCount', { count: selectedSchemas.length })}
            </div>
          </div>

          {/* 提示信息 */}
          <div className={styles.tipSection}>
            <IconInfoCircle size={20} className={styles.tipIcon} />
            <div className={styles.tipContent}>
              <p>{t('database.guide.schema.tip1')}</p>
              <p>{t('database.guide.schema.tip2')}</p>
              <p>{t('database.guide.schema.tip3')}</p>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.stepFooter}>
        <Button variant="default" onClick={handlePrev} leftSection={<IconArrowLeft size={14} />}>
          {t('database.action.prev')}
        </Button>
        <div className={styles.footerRight}>
          <Button
            onClick={handleConfirm}
            loading={saving}
            disabled={selectedSchemas.length === 0}
            rightSection={<IconArrowRight size={14} />}
          >
            {t('database.guide.schema.confirmAndSync')}
          </Button>
        </div>
      </div>
    </div>
  )
}

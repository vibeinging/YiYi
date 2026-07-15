import { useEffect, useMemo, useState } from 'react'
import { Select, Text, Textarea } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import axiosReq from '@/utils/axios-req'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './EntityMappingEditor.module.scss'

interface EntityConfig {
  column_name: string
  table_name: string
  metadata_fields?: string[]
  entity_type?: string
  [key: string]: any
}

export interface EntityMappingEditorProps {
  values?: string[]
  description?: string
  fieldInfo?: Record<string, any>
  allFields?: any[]
  businessId?: string
  projectId?: string
  onUpdateValues?: (values: string[]) => void
  onUpdateDescription?: (description: string) => void
}

export default function EntityMappingEditor({
  values = [],
  description = '',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fieldInfo = {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  allFields = [],
  businessId = '',
  projectId = '',
  onUpdateValues,
  onUpdateDescription,
}: EntityMappingEditorProps) {
  const { t } = useTranslation()

  // 数据名词配置列表
  const [entityConfigs, setEntityConfigs] = useState<EntityConfig[]>([])

  // 选中的配置
  const [selectedConfigId, setSelectedConfigId] = useState('')

  // 有附属字段的配置列表
  const configsWithMetadata = useMemo(
    () => entityConfigs.filter((config) => config.metadata_fields && config.metadata_fields.length > 0),
    [entityConfigs],
  )

  // 选中的配置
  const selectedConfig = useMemo(
    () => entityConfigs.find((c) => c.column_name === selectedConfigId),
    [entityConfigs, selectedConfigId],
  )

  // 绑定的字段名
  const boundFieldName = values && values.length > 0 ? values[0] : ''

  // setter：对应原 computed 的 set
  const setBoundFieldName = (val: string) => {
    onUpdateValues?.(val ? [val] : [])
  }

  // 处理数据名词选择变化
  const handleConfigChange = (configId: string | null) => {
    setSelectedConfigId(configId || '')
    setBoundFieldName('')
  }

  // 处理附属字段选择变化
  const handleFieldChange = (fieldName: string | null) => {
    setBoundFieldName(fieldName || '')
  }

  // 处理描述变化
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  // 加载实体配置
  const loadEntityConfigs = async () => {
    if (!businessId || !projectId) {
      return
    }

    try {
      const response = await axiosReq({
        url: `/api/projects/${projectId}/businesses/${businessId}/entity_configs`,
        method: 'get',
        params: { page: 1, page_size: 100 },
      })

      if (response.data?.items) {
        setEntityConfigs(
          response.data.items.filter((config: EntityConfig) => config.entity_type === 'column_value'),
        )
      }
    } catch (error) {
      // 静默处理错误
    }
  }

  // 监听 businessId 和 projectId 变化
  useEffect(() => {
    loadEntityConfigs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, projectId])

  // 监听 entityConfigs 变化，初始化选中状态
  useEffect(() => {
    const currentField = boundFieldName
    if (!currentField) {
      setSelectedConfigId('')
      return
    }

    for (const config of entityConfigs) {
      if (config.metadata_fields?.includes(currentField)) {
        setSelectedConfigId(config.column_name)
        return
      }
    }
    setSelectedConfigId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityConfigs])

  return (
    <div className={styles.entityMappingEditor}>
      {/* 数据名词选择 */}
      <div className={styles.fieldSection}>
        <div className={styles.sectionLabel}>{t('business.codeKnowledge.selectEntityNoun')}</div>
        <Select
          value={selectedConfigId || null}
          onChange={handleConfigChange}
          placeholder={t('business.codeKnowledge.selectEntityNounPlaceholder')}
          clearable
          searchable
          data={configsWithMetadata.map((config) => ({
            value: config.column_name,
            label: `${config.column_name} (${config.table_name})`,
          }))}
        />
      </div>

      {/* 附属字段选择 */}
      {selectedConfig && (
        <div className={styles.fieldSection}>
          <div className={styles.sectionLabel}>{t('business.codeKnowledge.selectMetadataField')}</div>
          <Select
            value={boundFieldName || null}
            onChange={handleFieldChange}
            placeholder={t('business.codeKnowledge.selectMetadataFieldPlaceholder')}
            clearable
            searchable
            data={(selectedConfig.metadata_fields || []).map((field) => ({
              value: field,
              label: field,
            }))}
          />
        </div>
      )}

      {/* 说明信息 */}
      <div className={styles.hintSection}>
        <Text c="dimmed" size="sm" className={styles.hintText}>
          <ElSvgIcon name="InfoFilled" size={14} />
          {t('business.codeKnowledge.entityMappingHint')}
        </Text>
      </div>

      {/* 条件说明 */}
      <div className={styles.descriptionSection}>
        <div className={styles.sectionLabel}>{t('business.codeKnowledge.conditionDescOptional')}</div>
        <Textarea
          value={description}
          onChange={(e) => handleDescriptionChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.entityMappingDescPlaceholder')}
          rows={2}
        />
      </div>
    </div>
  )
}

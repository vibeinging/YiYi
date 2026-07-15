import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Accordion, Alert, Badge, Button, Checkbox, Center, Text, TextInput } from '@mantine/core'
import ElSvgIcon from './ElSvgIcon'
import styles from './MultiSchemaSelector.module.scss'

/**
 * 多 Schema 选择器(对齐原 components/MultiSchemaSelector.vue)。
 * el-collapse → Accordion;el-checkbox-group → Checkbox.Group;el-empty → Center+Text;el-alert → Alert。
 */
export interface MultiSchemaSelectorProps {
  databaseId: string
  availableSchemas: string[]
  defaultSchema?: string
  initialSelection?: string[]
  disabled?: boolean
  // defineEmits → 回调 props
  'onUpdate:selectedSchemas'?: (schemas: string[]) => void
  onSelectionChange?: (schemas: string[]) => void
  onRefresh?: () => void
}

export default function MultiSchemaSelector({
  availableSchemas,
  defaultSchema = '',
  initialSelection = [],
  // databaseId/disabled 在原组件中未直接用于渲染逻辑,保留 props 以保持契约
  'onUpdate:selectedSchemas': onUpdateSelectedSchemas,
  onSelectionChange,
  onRefresh
}: MultiSchemaSelectorProps) {
  const { t } = useTranslation()

  // 响应式数据
  const [activeCollapse, setActiveCollapse] = useState<string[]>(['schema-selection'])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>([...initialSelection])

  // 计算属性
  const hasSchemas = useMemo(() => availableSchemas.length > 0, [availableSchemas])

  const filteredSchemas = useMemo(() => {
    if (!searchKeyword) {
      return availableSchemas
    }
    const keyword = searchKeyword.toLowerCase()
    return availableSchemas.filter((schema) => schema.toLowerCase().includes(keyword))
  }, [searchKeyword, availableSchemas])

  // 用 ref 持有最新选中值,供回调读取(避免闭包陈旧)
  const selectedRef = useRef<string[]>(selectedSchemas)
  selectedRef.current = selectedSchemas

  const emitSelectionChange = (schemas: string[]) => {
    onUpdateSelectedSchemas?.([...schemas])
    onSelectionChange?.([...schemas])
  }

  // 方法
  const selectAll = () => {
    const next = [...availableSchemas]
    setSelectedSchemas(next)
    emitSelectionChange(next)
  }

  const clearSelection = () => {
    setSelectedSchemas([])
    emitSelectionChange([])
  }

  const toggleDefaultSchema = () => {
    if (defaultSchema) {
      const current = selectedRef.current
      const index = current.indexOf(defaultSchema)
      let next: string[]
      if (index > -1) {
        next = current.filter((s) => s !== defaultSchema)
      } else {
        next = [...current, defaultSchema]
      }
      setSelectedSchemas(next)
      emitSelectionChange(next)
    }
  }

  // el-checkbox-group @change → Checkbox.Group onChange
  const handleSelectionChange = (next: string[]) => {
    setSelectedSchemas(next)
    onUpdateSelectedSchemas?.([...next])
    onSelectionChange?.([...next])
  }

  const refreshSchemas = () => {
    onRefresh?.()
  }

  // 监听器:initialSelection 变化时同步选中
  useEffect(() => {
    setSelectedSchemas([...initialSelection])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialSelection)])

  // 监听器:availableSchemas 变化时,移除已不在可用列表中的 Schema
  useEffect(() => {
    const next = selectedRef.current.filter((schema) => availableSchemas.includes(schema))
    setSelectedSchemas(next)
    emitSelectionChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(availableSchemas)])

  // 生命周期:无初始选择且存在默认 Schema 时,自动选择默认 Schema
  useEffect(() => {
    if (selectedRef.current.length === 0 && defaultSchema) {
      const next = [defaultSchema]
      setSelectedSchemas(next)
      emitSelectionChange(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.schemaSelector}>
      <Accordion multiple value={activeCollapse} onChange={setActiveCollapse}>
        <Accordion.Item value="schema-selection">
          <Accordion.Control>
            <div className={styles.selectorHeader}>
              <ElSvgIcon name="Grid" />
              <span>{t('common.schemaSelection')}</span>
              {selectedSchemas.length > 0 && (
                <Badge color="blue" size="sm">
                  {t('common.selectedCount', { count: selectedSchemas.length })}
                </Badge>
              )}
            </div>
          </Accordion.Control>

          <Accordion.Panel>
            <div className={styles.selectorContent}>
              {/* Schema 过滤搜索 */}
              <div className={styles.filterSection}>
                <TextInput
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.currentTarget.value)}
                  placeholder={t('common.searchSchema')}
                  leftSection={<ElSvgIcon name="Search" size={16} />}
                  size="xs"
                  className={styles.searchInput}
                />
              </div>

              {/* 快速选择按钮 */}
              <div className={styles.quickActions}>
                <Button.Group>
                  <Button
                    variant="default"
                    size="xs"
                    onClick={selectAll}
                    disabled={!hasSchemas}
                    leftSection={<ElSvgIcon name="Select" size={16} />}
                  >
                    {t('common.selectAll')}
                  </Button>
                  <Button
                    variant="default"
                    size="xs"
                    onClick={clearSelection}
                    disabled={!hasSchemas}
                    leftSection={<ElSvgIcon name="Close" size={16} />}
                  >
                    {t('common.clear')}
                  </Button>
                  <Button
                    variant="default"
                    size="xs"
                    onClick={toggleDefaultSchema}
                    disabled={!defaultSchema}
                    leftSection={<ElSvgIcon name="Star" size={16} />}
                  >
                    {t('common.default')}
                  </Button>
                </Button.Group>
              </div>

              {/* Schema 列表 */}
              {hasSchemas ? (
                <div className={styles.schemaList}>
                  <Checkbox.Group value={selectedSchemas} onChange={handleSelectionChange}>
                    {filteredSchemas.map((schema) => (
                      <div key={schema} className={styles.schemaItem}>
                        <Checkbox
                          value={schema}
                          label={
                            <div className={styles.schemaItemContent}>
                              <span className={styles.schemaName}>{schema}</span>
                              {schema === defaultSchema && (
                                <Badge color="green" size="sm" variant="outline">
                                  {t('common.default')}
                                </Badge>
                              )}
                              {schema === 'public' && (
                                <Badge color="gray" size="sm" variant="outline">
                                  Public
                                </Badge>
                              )}
                            </div>
                          }
                        />
                      </div>
                    ))}
                  </Checkbox.Group>
                </div>
              ) : (
                /* 无数据状态 */
                <div className={styles.emptyState}>
                  <Center style={{ flexDirection: 'column', gap: 12 }}>
                    <Text c="dimmed" size="sm">
                      {t('common.noAvailableSchema')}
                    </Text>
                    <Button
                      color="blue"
                      onClick={refreshSchemas}
                      leftSection={<ElSvgIcon name="Refresh" size={16} />}
                    >
                      {t('common.refresh')}
                    </Button>
                  </Center>
                </div>
              )}

              {/* 选择统计 */}
              {selectedSchemas.length > 0 && (
                <div className={styles.selectionInfo}>
                  <Alert
                    color="blue"
                    title={t('common.schemaSelectedInfo', {
                      count: selectedSchemas.length,
                      schemas: selectedSchemas.join(', ')
                    })}
                    icon={<ElSvgIcon name="InfoFilled" size={16} />}
                  >
                    <div className={styles.selectionTips}>
                      <ElSvgIcon name="InfoFilled" size={14} />
                      <span>{t('common.crossSchemaQueryTip')}</span>
                    </div>
                  </Alert>
                </div>
              )}
            </div>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </div>
  )
}

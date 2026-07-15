import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Modal,
  Button,
  Textarea,
  TextInput,
  Checkbox,
  Popover,
  Pagination,
  Table,
  ScrollArea
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  updateTableDescriptionReq,
  generateSingleTableDescriptionReq,
  updateColumnDescriptionReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  getTableColumnsReq
} from '@/api/database'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useProjectStore, projectGetters } from '@/store/project'
import { formatTableDisplayName } from '@/utils/tableDisplay'
import styles from './TableEditDialog.module.scss'

export interface TableEditDialogProps {
  // v-model:modelValue → opened + onOpenedChange（对齐已迁移的父组件 TableManagement 用法）
  opened?: boolean
  table?: any
  onOpenedChange?: (value: boolean) => void
  onClose?: () => void
  onSaved?: () => void
  onUpdated?: () => void
}

// ElMessage / ElMessageBox 等价封装（统一映射到 Mantine notifications）
const ElMessage = {
  success: (arg: any) =>
    notifications.show({ color: 'green', message: typeof arg === 'string' ? arg : arg?.message }),
  warning: (msg: string) => notifications.show({ color: 'yellow', message: msg }),
  error: (msg: string) => notifications.show({ color: 'red', message: msg })
}

export default function TableEditDialog({
  opened = false,
  table = null,
  onOpenedChange,
  onClose,
  onSaved,
  onUpdated
}: TableEditDialogProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // editingTable 用 ref 存储可变深拷贝数据，配合 version 触发重渲染
  const editingTableRef = useRef<any>(null)
  const [, forceRender] = useState(0)
  const bump = () => forceRender((v) => v + 1)
  const editingTable = editingTableRef.current

  const [saving, setSaving] = useState(false)

  // 获取表显示名称（处理默认 schema 的情况）
  const getTableDisplayName = (tbl: any) => formatTableDisplayName(tbl)

  // 获取表的 database_connection_id
  const getTableConnectionId = () => {
    return editingTableRef.current?.database_connection_id || null
  }

  // 列搜索和分页
  const [columnSearchKeyword, setColumnSearchKeyword] = useState('')
  const [columnCurrentPage, setColumnCurrentPage] = useState(1)
  const [columnPageSize, setColumnPageSize] = useState(10)

  // 过滤后的列（editingTable 为可变 ref，故每次渲染派生计算，不用 useMemo 缓存）
  const computeFilteredColumns = (): any[] => {
    if (!editingTable?.columns) return []
    if (!columnSearchKeyword.trim()) {
      return editingTable.columns
    }
    const keyword = columnSearchKeyword.toLowerCase().trim()
    return editingTable.columns.filter(
      (col: any) =>
        col.column_name.toLowerCase().includes(keyword) ||
        (col.description && col.description.toLowerCase().includes(keyword))
    )
  }
  const filteredColumns = computeFilteredColumns()

  // 分页后的列
  const start = (columnCurrentPage - 1) * columnPageSize
  const paginatedColumns = filteredColumns.slice(start, start + columnPageSize)

  // 总页数
  const totalColumnPages = Math.ceil(filteredColumns.length / columnPageSize)

  // 搜索处理
  const handleColumnSearch = () => {
    setColumnCurrentPage(1)
  }

  // 分页大小变化（原 el-pagination 带 page-sizes 选择器，Mantine Pagination 无内置，
  // 暂保留逻辑供后续接入；setColumnPageSize 仍可被调用以切换每页条数）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleColumnSizeChange = (size: number) => {
    setColumnPageSize(size)
    setColumnCurrentPage(1)
  }

  // Popover 可见状态（对齐原 reactive popoverVisible）
  const [popoverVisible, setPopoverVisible] = useState<{
    tableDesc: boolean
    colDesc: Record<string, boolean>
    exampleValues: Record<string, boolean>
    enumMappings: Record<string, boolean>
  }>({
    tableDesc: false,
    colDesc: {},
    exampleValues: {},
    enumMappings: {}
  })

  // 表描述临时值
  const [tempTableDescription, setTempTableDescription] = useState('')

  // 列描述临时值
  const [tempColumnDescription, setTempColumnDescription] = useState<Record<string, string>>({})

  // 示例值临时值
  const [exampleValuesText, setExampleValuesText] = useState<Record<string, string>>({})
  const [jsonError, setJsonError] = useState<Record<string, string>>({})

  // 枚举映射临时值
  const [enumMappingsText, setEnumMappingsText] = useState<Record<string, string>>({})
  const [enumJsonError, setEnumJsonError] = useState<Record<string, string>>({})

  // 智能生成相关状态
  const [, setCurrentGenerateMode] = useState<string | null>(null) // 'ai' | null
  const [isGenerating, setIsGenerating] = useState(false)
  const [, setGenerateStatus] = useState<string | null>(null) // 'generating' | 'success' | 'failed' | null
  const [aiExtraNotes, setAiExtraNotes] = useState('') // AI模式的额外说明
  const [generateBtnState, setGenerateBtnState] = useState<'idle' | 'generatingDesc' | 'generatingVectors'>('idle')

  const generateButtonText = useMemo(() => {
    const map: Record<string, string> = {
      idle: 'structuredData.aiGenerateDescAndVectors',
      generatingDesc: 'structuredData.generatingDesc',
      generatingVectors: 'structuredData.generatingVectors'
    }
    return t(map[generateBtnState] || map.idle)
  }, [generateBtnState, t])

  // 监听 table 变化，深拷贝数据（对齐原 watch immediate）
  useEffect(() => {
    const newTable = table
    if (newTable) {
      // 深拷贝表数据以避免直接修改原数据
      const copy = JSON.parse(JSON.stringify(newTable))

      // 保存原始值用于变更检测
      copy.originalDescription = newTable.description || ''

      // 保存列的原始描述和高召回状态
      if (copy.columns && copy.columns.length > 0) {
        copy.columns.forEach((column: any) => {
          column.originalDescription = column.description || ''
          column.originalIsHighRecall = column.is_high_recall || false
          // 确保字段存在
          if (!Object.prototype.hasOwnProperty.call(column, 'is_high_recall')) {
            column.is_high_recall = false
          }
          if (!column.example_values) {
            column.example_values = []
          }
        })
      }

      editingTableRef.current = copy

      // 清空临时状态
      setTempTableDescription('')
      setTempColumnDescription({})
      setExampleValuesText({})
      setJsonError({})
      setEnumMappingsText({})
      setEnumJsonError({})
      setPopoverVisible({ tableDesc: false, colDesc: {}, exampleValues: {}, enumMappings: {} })
      // 重置搜索和分页
      setColumnSearchKeyword('')
      setColumnCurrentPage(1)
      bump()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])

  const handleDialogClose = (value: boolean) => {
    if (!value) {
      // 对话框关闭时，重置数据到原始状态
      if (editingTableRef.current && table) {
        const copy = JSON.parse(JSON.stringify(table))
        copy.originalDescription = table.description || ''

        if (copy.columns && copy.columns.length > 0) {
          copy.columns.forEach((column: any) => {
            column.originalDescription = column.description || ''
            column.originalIsHighRecall = column.is_high_recall || false
            if (!Object.prototype.hasOwnProperty.call(column, 'is_high_recall')) {
              column.is_high_recall = false
            }
          })
        }
        editingTableRef.current = copy
      }

      // 重置生成相关状态
      setCurrentGenerateMode(null)
      setIsGenerating(false)
      setAiExtraNotes('')
      setGenerateStatus(null)

      // 重置编辑相关状态
      setTempTableDescription('')
      setTempColumnDescription({})
      setExampleValuesText({})
      setJsonError({})
      setEnumMappingsText({})
      setEnumJsonError({})
      setPopoverVisible({ tableDesc: false, colDesc: {}, exampleValues: {}, enumMappings: {} })
      setColumnSearchKeyword('')
      setColumnCurrentPage(1)
      bump()
    }

    // 原 emit('update:modelValue', value)：同步开关状态；关闭时额外触发 onClose
    onOpenedChange?.(value)
    if (!value) onClose?.()
  }

  const handleCancel = () => {
    onOpenedChange?.(false)
    onClose?.()
  }

  // ========== 表描述 ==========
  const initTableDescription = () => {
    setTempTableDescription(editingTableRef.current?.description || '')
  }

  const saveTableDescription = async () => {
    if (!editingTableRef.current || !editingTableRef.current.id) {
      ElMessage.warning(t('structuredData.tableInfoNotExist'))
      return
    }

    const connectionId = getTableConnectionId()
    if (!connectionId) {
      ElMessage.warning(t('structuredData.cannotGetConnectionId'))
      return
    }

    setSaving(true)
    try {
      await updateTableDescriptionReq(
        currentProjectId,
        connectionId,
        editingTableRef.current.id,
        tempTableDescription
      )
      editingTableRef.current.description = tempTableDescription
      setPopoverVisible((p) => ({ ...p, tableDesc: false }))
      ElMessage.success(t('structuredData.tableDescSaveSuccess'))
      onSaved?.()
      bump()
    } catch (error: any) {
      ElMessage.error(t('structuredData.saveFailed') + ': ' + (error.message || ''))
    } finally {
      setSaving(false)
    }
  }

  // ========== 列描述 ==========
  const initColumnDescription = (column: any) => {
    setTempColumnDescription((prev) => ({ ...prev, [column.id]: column.description || '' }))
  }

  const saveColumnDescription = async (column: any) => {
    if (!editingTableRef.current || !editingTableRef.current.id) {
      ElMessage.warning(t('structuredData.tableInfoNotExist'))
      return
    }

    const connectionId = getTableConnectionId()
    if (!connectionId) {
      ElMessage.warning(t('structuredData.cannotGetConnectionId'))
      return
    }

    setSaving(true)
    try {
      const res: any = await updateColumnDescriptionReq(
        currentProjectId,
        connectionId,
        column.id,
        tempColumnDescription[column.id]
      )
      column.description = tempColumnDescription[column.id]
      // 自动更新从描述解析出的枚举值
      if (res.data?.enum_mappings) {
        column.enum_mappings = res.data.enum_mappings
      }
      setPopoverVisible((p) => ({ ...p, colDesc: { ...p.colDesc, [column.id]: false } }))

      // 如果描述不为空，提示用户向量正在生成
      if (tempColumnDescription[column.id] && tempColumnDescription[column.id].trim()) {
        ElMessage.success({
          message: t('structuredData.columnDescSaveSuccessWithVector'),
          duration: 4000,
          showClose: true
        })
      } else {
        ElMessage.success(t('structuredData.columnDescSaveSuccess'))
      }
      onSaved?.()
      bump()
    } catch (error: any) {
      ElMessage.error(t('structuredData.saveFailed') + ': ' + (error.message || ''))
    } finally {
      setSaving(false)
    }
  }

  // ========== 示例值 ==========
  const initExampleValuesText = (column: any) => {
    const values = column.example_values || []
    setExampleValuesText((prev) => ({
      ...prev,
      [column.id]: values.length > 0 ? JSON.stringify(values, null, 2) : ''
    }))
    setJsonError((prev) => ({ ...prev, [column.id]: '' }))
  }

  const saveExampleValues = async (column: any) => {
    if (!editingTableRef.current || !editingTableRef.current.id) {
      ElMessage.warning(t('structuredData.tableInfoNotExist'))
      return
    }

    const connectionId = getTableConnectionId()
    if (!connectionId) {
      ElMessage.warning(t('structuredData.cannotGetConnectionId'))
      return
    }

    const text = exampleValuesText[column.id]?.trim() || ''
    setJsonError((prev) => ({ ...prev, [column.id]: '' }))

    let parsedValues: any[] = []
    if (text) {
      try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
          setJsonError((prev) => ({ ...prev, [column.id]: t('structuredData.mustBeArrayFormat') }))
          return
        }
        parsedValues = parsed.map((v: any) => (typeof v === 'string' ? v : JSON.stringify(v)))
      } catch (e) {
        setJsonError((prev) => ({ ...prev, [column.id]: t('structuredData.jsonFormatError') }))
        return
      }
    }

    setSaving(true)
    try {
      await updateColumnDescriptionReq(
        currentProjectId,
        connectionId,
        column.id,
        column.description || '',
        null,
        parsedValues
      )
      column.example_values = parsedValues
      setPopoverVisible((p) => ({ ...p, exampleValues: { ...p.exampleValues, [column.id]: false } }))
      ElMessage.success(t('structuredData.exampleValuesSaveSuccess'))
      onSaved?.()
      bump()
    } catch (error: any) {
      ElMessage.error(t('structuredData.saveFailed') + ': ' + (error.message || ''))
    } finally {
      setSaving(false)
    }
  }

  // ========== 枚举值 ==========
  // 将 mappings 数组转换为简化文本格式
  const mappingsToText = (mappings: any[]) => {
    if (!mappings?.length) return ''
    return mappings.map((m) => `${m.code}=${m.label}`).join('\n')
  }

  // 将简化文本格式解析为 mappings 数组
  const textToMappings = (text: string) => {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l)
    const mappings: any[] = []
    for (const line of lines) {
      // 匹配格式：code=label
      const match = line.match(/^([^=]+)=(.+)$/)
      if (!match) {
        throw new Error(t('structuredData.enumFormatError', { line }))
      }
      const [, code, label] = match
      mappings.push({
        code: code.trim(),
        label: label.trim()
      })
    }
    return mappings
  }

  const initEnumMappingsText = (column: any) => {
    const mappings = column.enum_mappings?.mappings || []
    setEnumMappingsText((prev) => ({ ...prev, [column.id]: mappingsToText(mappings) }))
    setEnumJsonError((prev) => ({ ...prev, [column.id]: '' }))
  }

  const saveEnumMappings = async (column: any) => {
    if (!editingTableRef.current || !editingTableRef.current.id) {
      ElMessage.warning(t('structuredData.tableInfoNotExist'))
      return
    }

    const connectionId = getTableConnectionId()
    if (!connectionId) {
      ElMessage.warning(t('structuredData.cannotGetConnectionId'))
      return
    }

    const text = enumMappingsText[column.id]?.trim() || ''
    setEnumJsonError((prev) => ({ ...prev, [column.id]: '' }))

    let parsedMappings: any[] = []
    if (text) {
      try {
        parsedMappings = textToMappings(text)
      } catch (e: any) {
        setEnumJsonError((prev) => ({ ...prev, [column.id]: e.message }))
        return
      }
    }

    const payloadEnumMappings = {
      mappings: parsedMappings,
      auto_detected: false,
      detection_method: 'manual'
    }

    setSaving(true)
    try {
      await updateColumnDescriptionReq(
        currentProjectId,
        connectionId,
        column.id,
        column.description || '',
        null,
        null,
        payloadEnumMappings
      )
      column.enum_mappings = payloadEnumMappings
      setPopoverVisible((p) => ({ ...p, enumMappings: { ...p.enumMappings, [column.id]: false } }))
      ElMessage.success(t('structuredData.enumValuesSaveSuccess'))
      onSaved?.()
      bump()
    } catch (error: any) {
      ElMessage.error(t('structuredData.saveFailed') + ': ' + (error.message || ''))
    } finally {
      setSaving(false)
    }
  }

  const formatEnumMappingsPreview = (enumMappings: any) => {
    const mappings = enumMappings?.mappings || []
    if (!mappings.length) return '—'
    const preview = mappings.slice(0, 3).map((m: any) => `${m.code}=${m.label}`)
    return mappings.length > 3 ? `${preview.join(', ')}...` : preview.join(', ')
  }

  // ========== 高召回 ==========
  const toggleHighRecall = async (column: any, newValue: boolean) => {
    if (!editingTableRef.current || !editingTableRef.current.id) {
      ElMessage.warning(t('structuredData.tableInfoNotExist'))
      return
    }

    const connectionId = getTableConnectionId()
    if (!connectionId) {
      ElMessage.warning(t('structuredData.cannotGetConnectionId'))
      return
    }

    const oldValue = column.is_high_recall
    column.is_high_recall = newValue // 先更新 UI
    bump()

    try {
      await updateColumnDescriptionReq(
        currentProjectId,
        connectionId,
        column.id,
        column.description || '',
        newValue
      )
      ElMessage.success(newValue ? t('structuredData.setHighRecall') : t('structuredData.cancelHighRecall'))
      onSaved?.()
    } catch (error: any) {
      column.is_high_recall = oldValue // 恢复原值
      bump()
      ElMessage.error(t('structuredData.saveFailed') + ': ' + (error.message || ''))
    }
  }

  // ========== 智能生成相关函数 ==========

  // 切换到AI模式
  const resetGenerateStatus = () => {
    setGenerateStatus(null)
  }

  // 注：原 handleSwitchToAIMode 在模板中未直接绑定，保留逻辑等价实现
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleSwitchToAIMode = () => {
    setCurrentGenerateMode('ai')
    setIsGenerating(false)
    setAiExtraNotes('')
    resetGenerateStatus()
  }

  // AI生成
  const handleAIGenerate = async () => {
    if (!editingTableRef.current || !editingTableRef.current.id) {
      ElMessage.warning(t('structuredData.tableInfoNotExist'))
      return
    }

    const connectionId = editingTableRef.current.database_connection_id
    if (!connectionId) {
      ElMessage.warning(t('structuredData.cannotGetConnectionId'))
      return
    }

    try {
      setIsGenerating(true)
      setGenerateStatus('generating')
      setGenerateBtnState('generatingDesc')

      // 1. 调用AI生成描述接口，传入额外说明
      const res: any = await generateSingleTableDescriptionReq(
        currentProjectId,
        connectionId,
        editingTableRef.current.id,
        2, // limitExamples
        aiExtraNotes // 传入用户填写的额外说明
      )

      if (!res?.success || !res?.data) {
        ElMessage.error(res?.msg || t('structuredData.generateAiDescFailed'))
        setGenerateStatus('failed')
        return
      }

      const { columns_generated, table_description_generated, table_description } = res.data

      // 更新表描述到编辑表单
      if (table_description) {
        editingTableRef.current.description = table_description
        bump()
      }

      // 重新获取列数据以更新界面
      if (columns_generated > 0) {
        try {
          const columnsRes: any = await getTableColumnsReq(
            currentProjectId,
            connectionId,
            editingTableRef.current.id
          )
          if (columnsRes.success && columnsRes.data) {
            editingTableRef.current.columns = columnsRes.data
            bump()
          }
        } catch (e) {
          console.error('刷新列数据失败:', e)
        }
      }

      ElMessage.success(
        t('structuredData.descGenerateComplete', {
          columns: columns_generated,
          tableStatus: table_description_generated
            ? t('structuredData.updated')
            : t('structuredData.notUpdated')
        })
      )

      // 2. 生成向量
      try {
        setGenerateBtnState('generatingVectors')

        // 表描述向量
        await storeSingleTableVectorReq(currentProjectId, connectionId, editingTableRef.current.id)

        // 列描述向量
        await storeTableColumnsVectorReq(currentProjectId, connectionId, editingTableRef.current.id)
      } catch (e) {
        console.error('生成向量失败:', e)
        ElMessage.warning(t('structuredData.descGeneratedButVectorFailed'))
      }

      setGenerateStatus('success')
      // 触发更新事件，让父组件刷新数据
      onUpdated?.()
    } catch (error: any) {
      console.error('生成AI描述失败:', error)
      ElMessage.error(
        error?.response?.data?.detail || error?.message || t('structuredData.generateAiDescFailed')
      )
      setGenerateStatus('failed')
    } finally {
      setIsGenerating(false)
      setGenerateBtnState('idle')
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={() => handleDialogClose(false)}
      title={
        t('structuredData.editTableStructure') +
        ' - ' +
        (editingTable ? getTableDisplayName(editingTable) : '')
      }
      size="80%"
      styles={{ inner: { top: '3vh' } }}
    >
      {editingTable && (
        <div className={styles.singleEditStructure}>
          <div className={styles.formSection}>
            {/* 表名 */}
            <div className={styles.formItem}>
              <div className={styles.formItemLabel}>{t('structuredData.tableName')}</div>
              <div className={styles.formItemContent}>
                <strong>{getTableDisplayName(editingTable)}</strong>
              </div>
            </div>

            {/* AI生成描述区域 */}
            <div className={styles.formItem}>
              <div className={styles.formItemLabel}>{t('structuredData.aiAssistNotes')}</div>
              <div className={styles.formItemContent}>
                <div className={styles.aiGenerateSection}>
                  <Textarea
                    className={styles.aiTextarea}
                    value={aiExtraNotes}
                    onChange={(e) => setAiExtraNotes(e.currentTarget.value)}
                    autosize
                    minRows={2}
                    maxRows={2}
                    placeholder={t('structuredData.aiAssistNotesPlaceholder')}
                    disabled={isGenerating}
                  />
                  <Button
                    className={styles.aiButton}
                    color="blue"
                    loading={isGenerating}
                    disabled={isGenerating}
                    onClick={handleAIGenerate}
                    leftSection={<ElSvgIcon name="MagicStick" size={16} />}
                  >
                    {generateButtonText}
                  </Button>
                </div>
              </div>
            </div>

            {/* 表注释 */}
            <div className={styles.formItem}>
              <div className={styles.formItemLabel}>{t('structuredData.tableComment')}</div>
              <div className={styles.formItemContent}>
                <Popover
                  position="bottom"
                  width={500}
                  trapFocus
                  opened={popoverVisible.tableDesc}
                  onChange={(o) => {
                    setPopoverVisible((p) => ({ ...p, tableDesc: o }))
                    if (o) initTableDescription()
                  }}
                >
                  <Popover.Target>
                    <div
                      className={styles.editableField}
                      onClick={() => {
                        const next = !popoverVisible.tableDesc
                        setPopoverVisible((p) => ({ ...p, tableDesc: next }))
                        if (next) initTableDescription()
                      }}
                    >
                      {editingTable.description ? (
                        <span className={styles.fieldValue}>{editingTable.description}</span>
                      ) : (
                        <span className={styles.placeholder}>{t('structuredData.clickToEdit')}</span>
                      )}
                    </div>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <div className={styles.fieldEditor}>
                      <Textarea
                        value={tempTableDescription}
                        onChange={(e) => setTempTableDescription(e.currentTarget.value)}
                        autosize
                        minRows={4}
                        maxRows={4}
                        placeholder={t('structuredData.tableDescPlaceholder')}
                      />
                      <div className={styles.editorFooter}>
                        <div></div>
                        <div className={styles.footerButtons}>
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => setPopoverVisible((p) => ({ ...p, tableDesc: false }))}
                          >
                            {t('structuredData.cancel')}
                          </Button>
                          <Button size="xs" color="blue" loading={saving} onClick={saveTableDescription}>
                            {t('structuredData.save')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Popover.Dropdown>
                </Popover>
              </div>
            </div>

            {/* 列 */}
            <div className={styles.formItem}>
              <div className={styles.formItemLabel}>{t('structuredData.columnsLabel')}</div>
              <div className={styles.formItemContent}>
                {/* 搜索和统计 */}
                <div className={styles.columnToolbar}>
                  <TextInput
                    value={columnSearchKeyword}
                    onChange={(e) => {
                      setColumnSearchKeyword(e.currentTarget.value)
                      handleColumnSearch()
                    }}
                    placeholder={t('structuredData.searchColumnPlaceholder')}
                    leftSection={<ElSvgIcon name="Search" size={14} />}
                    size="xs"
                    style={{ width: 220 }}
                  />
                  <span className={styles.columnCount}>
                    {t('structuredData.totalColumns', { count: editingTable.columns?.length || 0 })}
                  </span>
                </div>

                <ScrollArea className={styles.tableWrapper} type="auto">
                  <Table striped highlightOnHover style={{ width: '100%' }} stickyHeader>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('structuredData.columnName')}</Table.Th>
                        <Table.Th style={{ width: 100 }}>{t('structuredData.dataType')}</Table.Th>
                        <Table.Th style={{ minWidth: 200 }}>
                          {t('structuredData.descriptionLabel')}
                        </Table.Th>
                        <Table.Th style={{ width: 200 }}>{t('structuredData.exampleValues')}</Table.Th>
                        <Table.Th style={{ width: 200 }}>{t('structuredData.enumValues')}</Table.Th>
                        <Table.Th style={{ width: 80, textAlign: 'center' }}>
                          {t('structuredData.highRecall')}
                        </Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {paginatedColumns.map((row: any) => (
                        <Table.Tr key={row.id}>
                          {/* 列名 */}
                          <Table.Td>{row.column_name}</Table.Td>
                          {/* 数据类型 */}
                          <Table.Td>{row.data_type}</Table.Td>

                          {/* 描述 */}
                          <Table.Td>
                            <Popover
                              position="bottom"
                              width={400}
                              trapFocus
                              opened={!!popoverVisible.colDesc[row.id]}
                              onChange={(o) => {
                                setPopoverVisible((p) => ({
                                  ...p,
                                  colDesc: { ...p.colDesc, [row.id]: o }
                                }))
                                if (o) initColumnDescription(row)
                              }}
                            >
                              <Popover.Target>
                                <div
                                  className={styles.editableField}
                                  onClick={() => {
                                    const next = !popoverVisible.colDesc[row.id]
                                    setPopoverVisible((p) => ({
                                      ...p,
                                      colDesc: { ...p.colDesc, [row.id]: next }
                                    }))
                                    if (next) initColumnDescription(row)
                                  }}
                                >
                                  {row.description ? (
                                    <span className={styles.fieldValue}>{row.description}</span>
                                  ) : (
                                    <span className={styles.placeholder}>
                                      {t('structuredData.clickToEdit')}
                                    </span>
                                  )}
                                </div>
                              </Popover.Target>
                              <Popover.Dropdown>
                                <div className={styles.fieldEditor}>
                                  <Textarea
                                    value={tempColumnDescription[row.id] || ''}
                                    onChange={(e) =>
                                      setTempColumnDescription((prev) => ({
                                        ...prev,
                                        [row.id]: e.currentTarget.value
                                      }))
                                    }
                                    autosize
                                    minRows={3}
                                    maxRows={3}
                                    placeholder={t('structuredData.fieldDescPlaceholder')}
                                  />
                                  <div className={styles.editorFooter}>
                                    <div></div>
                                    <div className={styles.footerButtons}>
                                      <Button
                                        size="xs"
                                        variant="default"
                                        onClick={() =>
                                          setPopoverVisible((p) => ({
                                            ...p,
                                            colDesc: { ...p.colDesc, [row.id]: false }
                                          }))
                                        }
                                      >
                                        {t('structuredData.cancel')}
                                      </Button>
                                      <Button
                                        size="xs"
                                        color="blue"
                                        loading={saving}
                                        onClick={() => saveColumnDescription(row)}
                                      >
                                        {t('structuredData.save')}
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              </Popover.Dropdown>
                            </Popover>
                          </Table.Td>

                          {/* 示例值 */}
                          <Table.Td>
                            <Popover
                              position="bottom"
                              width={400}
                              trapFocus
                              opened={!!popoverVisible.exampleValues[row.id]}
                              onChange={(o) => {
                                setPopoverVisible((p) => ({
                                  ...p,
                                  exampleValues: { ...p.exampleValues, [row.id]: o }
                                }))
                                if (o) initExampleValuesText(row)
                              }}
                            >
                              <Popover.Target>
                                <div
                                  className={styles.editableField}
                                  onClick={() => {
                                    const next = !popoverVisible.exampleValues[row.id]
                                    setPopoverVisible((p) => ({
                                      ...p,
                                      exampleValues: { ...p.exampleValues, [row.id]: next }
                                    }))
                                    if (next) initExampleValuesText(row)
                                  }}
                                >
                                  {row.example_values?.length ? (
                                    <>
                                      <span className={`${styles.fieldValue} ${styles.truncate}`}>
                                        {row.example_values.slice(0, 3).join(', ')}
                                        {row.example_values.length > 3 && <span>...</span>}
                                      </span>
                                      <span className={styles.countBadge}>
                                        {row.example_values.length}
                                      </span>
                                    </>
                                  ) : (
                                    <span className={styles.placeholder}>
                                      {t('structuredData.clickToEdit')}
                                    </span>
                                  )}
                                </div>
                              </Popover.Target>
                              <Popover.Dropdown>
                                <div className={styles.fieldEditor}>
                                  <div className={styles.editorHeader}>
                                    <span>{t('structuredData.editExampleValues')}</span>
                                    <span className={styles.editorTip}>
                                      {t('structuredData.jsonArrayFormat')}
                                    </span>
                                  </div>
                                  <Textarea
                                    value={exampleValuesText[row.id] || ''}
                                    onChange={(e) =>
                                      setExampleValuesText((prev) => ({
                                        ...prev,
                                        [row.id]: e.currentTarget.value
                                      }))
                                    }
                                    autosize
                                    minRows={8}
                                    maxRows={8}
                                    placeholder={'["示例值1", "示例值2"]'}
                                  />
                                  <div className={styles.editorFooter}>
                                    {jsonError[row.id] && (
                                      <span className={styles.jsonError}>{jsonError[row.id]}</span>
                                    )}
                                    <div className={styles.footerButtons}>
                                      <Button
                                        size="xs"
                                        variant="default"
                                        onClick={() =>
                                          setPopoverVisible((p) => ({
                                            ...p,
                                            exampleValues: { ...p.exampleValues, [row.id]: false }
                                          }))
                                        }
                                      >
                                        {t('structuredData.cancel')}
                                      </Button>
                                      <Button
                                        size="xs"
                                        color="blue"
                                        loading={saving}
                                        onClick={() => saveExampleValues(row)}
                                      >
                                        {t('structuredData.save')}
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              </Popover.Dropdown>
                            </Popover>
                          </Table.Td>

                          {/* 枚举值 */}
                          <Table.Td>
                            <Popover
                              position="bottom"
                              width={420}
                              trapFocus
                              opened={!!popoverVisible.enumMappings[row.id]}
                              onChange={(o) => {
                                setPopoverVisible((p) => ({
                                  ...p,
                                  enumMappings: { ...p.enumMappings, [row.id]: o }
                                }))
                                if (o) initEnumMappingsText(row)
                              }}
                            >
                              <Popover.Target>
                                <div
                                  className={styles.editableField}
                                  onClick={() => {
                                    const next = !popoverVisible.enumMappings[row.id]
                                    setPopoverVisible((p) => ({
                                      ...p,
                                      enumMappings: { ...p.enumMappings, [row.id]: next }
                                    }))
                                    if (next) initEnumMappingsText(row)
                                  }}
                                >
                                  {row.enum_mappings?.mappings?.length ? (
                                    <>
                                      <span className={`${styles.fieldValue} ${styles.truncate}`}>
                                        {formatEnumMappingsPreview(row.enum_mappings)}
                                      </span>
                                      <span className={styles.countBadge}>
                                        {row.enum_mappings.mappings.length}
                                      </span>
                                    </>
                                  ) : (
                                    <span className={styles.placeholder}>
                                      {t('structuredData.clickToEdit')}
                                    </span>
                                  )}
                                </div>
                              </Popover.Target>
                              <Popover.Dropdown>
                                <div className={styles.fieldEditor}>
                                  <div className={styles.editorHeader}>
                                    <span>{t('structuredData.editEnumValues')}</span>
                                    <span className={styles.editorTip}>
                                      {t('structuredData.enumFormatTip')}
                                    </span>
                                  </div>
                                  <Textarea
                                    value={enumMappingsText[row.id] || ''}
                                    onChange={(e) =>
                                      setEnumMappingsText((prev) => ({
                                        ...prev,
                                        [row.id]: e.currentTarget.value
                                      }))
                                    }
                                    autosize
                                    minRows={8}
                                    maxRows={8}
                                    placeholder={'1=正常\n2=异常\n3=待处理'}
                                  />
                                  <div className={styles.editorFooter}>
                                    {enumJsonError[row.id] && (
                                      <span className={styles.jsonError}>{enumJsonError[row.id]}</span>
                                    )}
                                    <div className={styles.footerButtons}>
                                      <Button
                                        size="xs"
                                        variant="default"
                                        onClick={() =>
                                          setPopoverVisible((p) => ({
                                            ...p,
                                            enumMappings: { ...p.enumMappings, [row.id]: false }
                                          }))
                                        }
                                      >
                                        {t('structuredData.cancel')}
                                      </Button>
                                      <Button
                                        size="xs"
                                        color="blue"
                                        loading={saving}
                                        onClick={() => saveEnumMappings(row)}
                                      >
                                        {t('structuredData.save')}
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              </Popover.Dropdown>
                            </Popover>
                          </Table.Td>

                          {/* 高召回 */}
                          <Table.Td style={{ textAlign: 'center' }}>
                            <Checkbox
                              checked={!!row.is_high_recall}
                              onChange={(e) => toggleHighRecall(row, e.currentTarget.checked)}
                            />
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>

                {/* 分页 */}
                {totalColumnPages > 1 && (
                  <div className={styles.columnPagination}>
                    <Pagination
                      value={columnCurrentPage}
                      onChange={setColumnCurrentPage}
                      total={totalColumnPages}
                      size="sm"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* footer */}
      <div className={styles.dialogFooter}>
        <Button
          className={styles.closeButton}
          variant="default"
          onClick={(e) => {
            e.stopPropagation()
            handleCancel()
          }}
          leftSection={<ElSvgIcon name="Close" size={16} />}
        >
          {t('structuredData.close')}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Entity Data Hook
 * 实体数据 CRUD 操作（Vue composable → React hook）
 *
 * 迁移说明：
 * - ref → useState；方法用 useCallback 包裹（依赖 projectId/businessId）。
 * - 原 Vue 版 projectId/businessId 是 ref，内部用 .value 取值；React 版直接传普通值，去掉 .value。
 * - ElMessage.success/error → notifications.show({ color, message })。
 * - ElMessageBox.prompt（输入确认文本后才能删除）→ 自建 confirmWithText（modals.openConfirmModal
 *   + 受控 TextInput），保持「输入准确文本才能确认 + 一键填充」的交互。
 * - 导出名与返回字段名保持一致。
 */
import { useCallback, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { Button, Group, Stack, Text, TextInput } from '@mantine/core'
import {
  createEntityConfigReq,
  getEntityConfigsReq,
  deleteEntityConfigReq,
  updateEntityConfigReq,
  searchEntitiesReq,
  generateEntityEmbeddingsReq,
  createColumnNameEntitiesReq,
  testEntityAgentReq
} from '@/api/business-semantic'

export function useEntityData(projectId: any, businessId: any) {
  const [entityMappings, setEntityMappings] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  // 分页状态
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)

  // 用 ref 持有最新分页值，供无参调用的 loadEntityMappings 默认参数引用
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const pageSizeRef = useRef(pageSize)
  pageSizeRef.current = pageSize

  // 加载实体映射（支持分页）
  const loadEntityMappings = useCallback(
    async (page = currentPageRef.current, size = pageSizeRef.current) => {
      try {
        setLoading(true)
        const res = await getEntityConfigsReq(projectId, page, size)
        if (res.success) {
          setEntityMappings(res.data.items || [])
          setTotal(res.data.total || 0)
          setCurrentPage(page)
          setPageSize(size)
        }
      } catch (error) {
        console.error('加载实体映射失败:', error)
      } finally {
        setLoading(false)
      }
    },
    [projectId, businessId]
  )

  // 分页变化
  const handlePageChange = useCallback(
    async (page: any) => {
      await loadEntityMappings(page, pageSizeRef.current)
    },
    [loadEntityMappings]
  )

  // 每页条数变化
  const handleSizeChange = useCallback(
    async (size: any) => {
      await loadEntityMappings(1, size)
    },
    [loadEntityMappings]
  )

  // 创建实体配置
  const createEntityConfig = useCallback(
    async (config: any) => {
      return await createEntityConfigReq(projectId, config)
    },
    [projectId, businessId]
  )

  // 批量创建列值实体
  const createColumnValueEntities = useCallback(
    async (configs: any[]) => {
      const results: any[] = []
      for (const config of configs) {
        const res = await createEntityConfigReq(projectId, {
          source_id: config.source_id,
          source_type: config.source_type,
          table_id: config.table_id,
          column_name: config.column_name,
          metadata_fields: config.metadata_fields?.length > 0 ? config.metadata_fields : null,
          rule: config.rule?.trim() || null
        })
        results.push(res)
      }
      return results
    },
    [projectId, businessId]
  )

  // 创建列名实体
  const createColumnNameEntities = useCallback(
    async (tableId: any, sourceType: any, columns: any) => {
      return await createColumnNameEntitiesReq(projectId, tableId, sourceType, columns)
    },
    [projectId, businessId]
  )

  // 更新实体配置
  const updateEntityConfig = useCallback(
    async (configId: any, data: any) => {
      return await updateEntityConfigReq(projectId, configId, data)
    },
    [projectId, businessId]
  )

  // 删除实体配置
  const deleteEntityConfig = useCallback(
    async (configId: any) => {
      return await deleteEntityConfigReq(projectId, configId)
    },
    [projectId, businessId]
  )

  // 生成实体向量
  const generateEntityEmbeddings = useCallback(
    async (configId: any) => {
      return await generateEntityEmbeddingsReq(projectId, configId)
    },
    [projectId, businessId]
  )

  // 搜索实体
  const searchEntities = useCallback(
    async (keyword: any, limit = 10) => {
      return await searchEntitiesReq(projectId, keyword, limit)
    },
    [projectId, businessId]
  )

  // Agent 测试
  const testEntityAgent = useCallback(
    async (question: any) => {
      return await testEntityAgentReq(projectId, question)
    },
    [projectId, businessId]
  )

  // 删除列值实体确认
  const confirmDeleteColumnValueEntity = useCallback(
    async (config: any) => {
      const { id, table_name: tableName, column_name: columnName } = config
      const expectedConfirmation = `${tableName}.${columnName}`

      const confirmed = await confirmDeleteWithText({
        title: '二次确认删除实体配置',
        expected: expectedConfirmation,
        placeholder: '请输入确认文本'
      })

      if (!confirmed) return false

      const res = await deleteEntityConfig(id)
      if (res.success) {
        notifications.show({ message: `成功删除表 "${tableName}" 列 "${columnName}" 的实体配置` })
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || '删除实体配置失败' })
      }
      return res.success
    },
    [deleteEntityConfig, loadEntityMappings]
  )

  // 删除列名实体确认
  const confirmDeleteColumnNameEntity = useCallback(
    async (table: any) => {
      const { id, table_name: tableName } = table

      const confirmed = await confirmDeleteWithText({
        title: '确认删除字段名词',
        expected: tableName,
        placeholder: '请输入表名确认'
      })

      if (!confirmed) return false

      const res = await deleteEntityConfig(id)
      if (res.success) {
        notifications.show({ message: `成功删除表 "${tableName}" 的字段名词配置` })
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || '删除失败' })
      }
      return res.success
    },
    [deleteEntityConfig, loadEntityMappings]
  )

  // 过滤 meta_data 中不需要展示的字段
  const filterMetaData = useCallback((metaData: any) => {
    if (!metaData) return {}
    const excludeKeys = ['table_name', 'column_name', 'source_value', 'source_type', 'entity_type']
    return Object.fromEntries(
      Object.entries(metaData).filter(([key]) => !excludeKeys.includes(key))
    )
  }, [])

  return {
    entityMappings,
    loading,
    // 分页
    currentPage,
    pageSize,
    total,
    handlePageChange,
    handleSizeChange,
    // 方法
    loadEntityMappings,
    createEntityConfig,
    createColumnValueEntities,
    createColumnNameEntities,
    updateEntityConfig,
    deleteEntityConfig,
    generateEntityEmbeddings,
    searchEntities,
    testEntityAgent,
    confirmDeleteColumnValueEntity,
    confirmDeleteColumnNameEntity,
    filterMetaData
  }
}

/**
 * 二次确认删除：必须输入与 expected 完全一致的文本才能点确认。
 * 对应原 Vue 版 ElMessageBox.prompt + inputPattern 校验 + 「填充」按钮。
 * resolve(true) 表示确认删除，resolve(false) 表示取消/未通过校验。
 */
function confirmDeleteWithText(opts: {
  title: string
  expected: string
  placeholder: string
}): Promise<boolean> {
  const { title, expected, placeholder } = opts
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const modalId = `confirm-delete-${Date.now()}`
    modals.open({
      modalId,
      title,
      onClose: () => finish(false),
      children: (
        <ConfirmDeleteForm
          expected={expected}
          placeholder={placeholder}
          onCancel={() => {
            modals.close(modalId)
            finish(false)
          }}
          onConfirm={() => {
            modals.close(modalId)
            finish(true)
          }}
        />
      )
    })
  })
}

function ConfirmDeleteForm(props: {
  expected: string
  placeholder: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { expected, placeholder, onCancel, onConfirm } = props
  const [value, setValue] = useState('')
  const matched = value === expected
  return (
    <Stack gap="sm">
      <Group gap={6} wrap="nowrap" align="center">
        <Text size="sm">
          为了防止误操作，请输入确认文本：<strong>{expected}</strong>
        </Text>
        {/* 「填充」按钮：一键把确认文本填入输入框（对应原 HTML 内联 onclick） */}
        <Button size="compact-xs" variant="default" onClick={() => setValue(expected)}>
          填充
        </Button>
      </Group>
      <TextInput
        value={value}
        placeholder={placeholder}
        error={value && !matched ? `请输入准确的确认文本: ${expected}` : undefined}
        onChange={(e) => setValue(e.currentTarget.value)}
        autoFocus
      />
      <Group justify="flex-end" gap="sm">
        <Button variant="default" onClick={onCancel}>
          取消
        </Button>
        <Button color="red" disabled={!matched} onClick={onConfirm}>
          确认删除
        </Button>
      </Group>
    </Stack>
  )
}

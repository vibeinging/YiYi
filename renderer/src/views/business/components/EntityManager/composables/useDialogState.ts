/**
 * Dialog State Composable
 * 弹窗状态管理
 */
import { useCallback, useState } from 'react'

export function useDialogState() {
  // 列值实体弹窗
  const [addEntityDialogVisible, setAddEntityDialogVisible] = useState(false)

  // 列名实体弹窗
  const [columnNameDialogVisible, setColumnNameDialogVisible] = useState(false)

  // 搜索测试弹窗
  const [searchDialogVisible, setSearchDialogVisible] = useState(false)

  // 编辑规则弹窗
  const [editRuleDialogVisible, setEditRuleDialogVisible] = useState(false)

  // Loading 状态
  const [saving, setSaving] = useState(false)
  const [savingColumnNameEntities, setSavingColumnNameEntities] = useState(false)
  const [savingRule, setSavingRule] = useState(false)
  const [searching, setSearching] = useState(false)
  const [agentTesting, setAgentTesting] = useState(false)
  const [deletingTableColumn, setDeletingTableColumn] = useState<any>(null)
  const [generatingTableColumn, setGeneratingTableColumn] = useState<any>(null)
  const [deletingColumnNameTable, setDeletingColumnNameTable] = useState<any>(null)
  const [generatingColumnNameTable, setGeneratingColumnNameTable] = useState<any>(null)
  const [togglingConfig, setTogglingConfig] = useState<any>(null)

  // 搜索相关状态
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [agentResult, setAgentResult] = useState<any>(null)

  // 编辑规则相关状态
  const [editingRuleConfig, setEditingRuleConfig] = useState<any>(null)
  const [editingRuleValue, setEditingRuleValue] = useState('')

  // 打开列值实体弹窗
  const openAddEntityDialog = useCallback(() => {
    setAddEntityDialogVisible(true)
  }, [])

  // 关闭列值实体弹窗
  const closeAddEntityDialog = useCallback(() => {
    setAddEntityDialogVisible(false)
  }, [])

  // 打开列名实体弹窗
  const openColumnNameDialog = useCallback(() => {
    setColumnNameDialogVisible(true)
  }, [])

  // 关闭列名实体弹窗
  const closeColumnNameDialog = useCallback(() => {
    setColumnNameDialogVisible(false)
  }, [])

  // 打开搜索测试弹窗
  const openSearchDialog = useCallback(() => {
    setSearchDialogVisible(true)
    setSearchKeyword('')
    setSearchResults([])
    setHasSearched(false)
    setAgentResult(null)
  }, [])

  // 关闭搜索测试弹窗
  const closeSearchDialog = useCallback(() => {
    setSearchDialogVisible(false)
  }, [])

  // 打开编辑规则弹窗
  const openEditRuleDialog = useCallback((config: any) => {
    setEditingRuleConfig(config)
    setEditingRuleValue(config.rule || '')
    setEditRuleDialogVisible(true)
  }, [])

  // 关闭编辑规则弹窗
  const closeEditRuleDialog = useCallback(() => {
    setEditRuleDialogVisible(false)
    setEditingRuleConfig(null)
    setEditingRuleValue('')
  }, [])

  // 清空搜索结果
  const clearSearchResults = useCallback(() => {
    setSearchResults([])
    setHasSearched(false)
  }, [])

  // 清空 Agent 结果
  const clearAgentResult = useCallback(() => {
    setAgentResult(null)
  }, [])

  return {
    // 状态值(保持与原 composable 一致的导出名)
    addEntityDialogVisible,
    columnNameDialogVisible,
    searchDialogVisible,
    editRuleDialogVisible,
    saving,
    savingColumnNameEntities,
    savingRule,
    searching,
    agentTesting,
    deletingTableColumn,
    generatingTableColumn,
    deletingColumnNameTable,
    generatingColumnNameTable,
    togglingConfig,
    searchKeyword,
    searchResults,
    hasSearched,
    agentResult,
    editingRuleConfig,
    editingRuleValue,
    // 方法
    openAddEntityDialog,
    closeAddEntityDialog,
    openColumnNameDialog,
    closeColumnNameDialog,
    openSearchDialog,
    closeSearchDialog,
    openEditRuleDialog,
    closeEditRuleDialog,
    clearSearchResults,
    clearAgentResult,
    // setter(Vue 中通过 .value 直接赋值的状态,在 React 中以 setter 暴露)
    setAddEntityDialogVisible,
    setColumnNameDialogVisible,
    setSearchDialogVisible,
    setEditRuleDialogVisible,
    setSaving,
    setSavingColumnNameEntities,
    setSavingRule,
    setSearching,
    setAgentTesting,
    setDeletingTableColumn,
    setGeneratingTableColumn,
    setDeletingColumnNameTable,
    setGeneratingColumnNameTable,
    setTogglingConfig,
    setSearchKeyword,
    setSearchResults,
    setHasSearched,
    setAgentResult,
    setEditingRuleConfig,
    setEditingRuleValue,
  }
}

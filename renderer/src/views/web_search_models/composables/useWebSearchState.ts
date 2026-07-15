import { useState } from 'react'

export interface WebSearchModel {
    id: string
    model: string
    name: string
    api: string
    description?: string
    config_type?: string
    custom_config?: any
}

export function useWebSearchState() {
  const [modelList, setModelList] = useState<WebSearchModel[]>([])

  const [selectedModel, setSelectedModel] = useState<WebSearchModel | null>(null)
  // 初始不进入创建模式，避免在已有数据时先闪现“新建网络数据源”表单
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isCreateMode, setIsCreateMode] = useState(false)

  return {
    modelList,
    setModelList,
    selectedModel,
    setSelectedModel,
    isCollapsed,
    setIsCollapsed,
    isCreateMode,
    setIsCreateMode
  }
}

/**
 * 本地存储工具类
 * 配合keep-alive使用，简化存储逻辑
 *
 * 存储策略：
 * - keep-alive负责保持组件内存状态（包括查询结果）
 * - localStorage只保存基本配置信息和用户偏好
 * - 减少存储操作，提升性能
 * - 用户未登录时不进行存储操作
 */

const STORAGE_KEYS = {
  TABS: 'yiw_tabs',
  PREFERENCES: 'yiw_preferences',
  CONFIG: 'yiw_config_',
  LAST_ACTIVE_TAB: 'yiw_last_active_tab',
  SIDEBAR_STATE: 'yiw_sidebar_state',
  SELECTED_DATABASE: 'yiw_selected_database'
}

// yiw存储的前缀
const AGENTIC_DATA_PREFIX = 'yiw_'

const DEFAULT_PREFERENCES = {
  autoSave: true,
  saveInterval: 30, // 秒
  preserveState: true // 是否在页面关闭时保存状态
}

// 检查用户是否已登录
function isUserLoggedIn() {
  try {
    // 检查单独的token存储（兼容性检查）
    const standaloneToken = localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('access_token')
    if (standaloneToken && standaloneToken !== '' && standaloneToken !== 'null' && standaloneToken !== 'undefined') {
      return true
    }

    // 检查Pinia持久化store中的token（正确的key是'basic'）
    if (typeof window !== 'undefined' && window.localStorage) {
      const basicStoreData = localStorage.getItem('basic')
      if (basicStoreData) {
        try {
          const parsedData = JSON.parse(basicStoreData)
          const hasToken = !!(parsedData && parsedData.token && parsedData.token !== '' && parsedData.token !== 'null')
          console.log('检查basic store token:', {
            hasBasicStore: !!basicStoreData,
            token: parsedData?.token,
            hasValidToken: hasToken
          })
          return hasToken
        } catch (error) {
          console.warn('解析basic store数据失败:', error)
          return false
        }
      }
    }

    console.log('未找到有效的token')
    return false
  } catch (error) {
    console.error('检查登录状态失败:', error)
    return false
  }
}

class QueryPanelStorage {
  // 保存标签页数据（简化版 - 配合keep-alive使用）
  saveTabs(tabs: any) {
    // 检查用户是否已登录
    if (!isUserLoggedIn()) {
      console.warn('用户未登录，跳过保存标签页数据')
      return false
    }

    if (!tabs || !tabs.length) return

    // 由于使用keep-alive，只保存基本信息，不保存查询结果
    const simplifiedTabs = tabs.map((tab: any) => ({
      id: tab.id,
      title: tab.title,
      databaseId: tab.databaseId,
      databaseName: tab.databaseName,
      tableName: tab.tableName,
      nlQuery: tab.nlQuery,
      sql: tab.sql,
      // 不再保存查询结果，keep-alive会保持内存状态
      currentPage: tab.currentPage || 1,
      limit: tab.limit || 100,
      // 不保存状态标记，每次重新加载时重置
    }))

    try {
      localStorage.setItem(STORAGE_KEYS.TABS, JSON.stringify(simplifiedTabs))
      return true
    } catch (error) {
      console.error('保存标签页失败:', error)
      return false
    }
  }

  // 加载标签页数据（简化版 - 配合keep-alive使用）
  loadTabs() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.TABS)
      // 只返回基本信息，查询结果由keep-alive保持
      return data ? JSON.parse(data) : []
    } catch (error) {
      console.error('加载标签页失败:', error)
      return []
    }
  }

  // 保存最后激活的标签页
  saveLastActiveTab(tabId: any) {
    // 检查用户是否已登录
    if (!isUserLoggedIn()) {
      console.warn('用户未登录，跳过保存最后激活标签页')
      return false
    }

    try {
      localStorage.setItem(STORAGE_KEYS.LAST_ACTIVE_TAB, tabId)
      return true
    } catch (error) {
      console.error('保存最后激活标签页失败:', error)
      return false
    }
  }

  // 获取最后激活的标签页
  getLastActiveTab() {
    try {
      return localStorage.getItem(STORAGE_KEYS.LAST_ACTIVE_TAB)
    } catch (error) {
      console.error('获取最后激活标签页失败:', error)
      return null
    }
  }

  // 保存侧边栏状态
  saveSidebarState(isCollapsed: any) {
    // 检查用户是否已登录
    if (!isUserLoggedIn()) {
      console.warn('用户未登录，跳过保存侧边栏状态')
      return false
    }

    try {
      localStorage.setItem(STORAGE_KEYS.SIDEBAR_STATE, JSON.stringify(isCollapsed))
      return true
    } catch (error) {
      console.error('保存侧边栏状态失败:', error)
      return false
    }
  }

  // 获取侧边栏状态
  getSidebarState() {
    try {
      const state = localStorage.getItem(STORAGE_KEYS.SIDEBAR_STATE)
      return state ? JSON.parse(state) : false
    } catch (error) {
      console.error('获取侧边栏状态失败:', error)
      return false
    }
  }

  // 保存选中的数据库ID
  saveSelectedDatabase(databaseId: any) {
    // 检查用户是否已登录
    if (!isUserLoggedIn()) {
      console.warn('用户未登录，跳过保存选中数据库')
      return false
    }

    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_DATABASE, JSON.stringify(databaseId))
      return true
    } catch (error) {
      console.error('保存选中数据库失败:', error)
      return false
    }
  }

  // 获取选中的数据库ID
  getSelectedDatabase() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SELECTED_DATABASE)
      return data ? JSON.parse(data) : null
    } catch (error) {
      console.error('获取选中数据库失败:', error)
      return null
    }
  }

  // 保存标签页配置
  saveTabConfig(tabId: any, config: any) {
    // 检查用户是否已登录
    if (!isUserLoggedIn()) {
      console.warn('用户未登录，跳过保存标签页配置')
      return false
    }

    try {
      localStorage.setItem(STORAGE_KEYS.CONFIG + tabId, JSON.stringify(config))
      return true
    } catch (error) {
      console.error('保存标签页配置失败:', error)
      return false
    }
  }

  // 加载标签页配置
  loadTabConfig(tabId: any) {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.CONFIG + tabId)
      return data ? JSON.parse(data) : null
    } catch (error) {
      console.error('加载标签页配置失败:', error)
      return null
    }
  }

  // 保存用户偏好
  savePreferences(preferences: any) {
    // 检查用户是否已登录
    if (!isUserLoggedIn()) {
      console.warn('用户未登录，跳过保存用户偏好')
      return false
    }

    try {
      localStorage.setItem(STORAGE_KEYS.PREFERENCES, JSON.stringify(preferences))
      return true
    } catch (error) {
      console.error('保存偏好设置失败:', error)
      return false
    }
  }

  // 加载用户偏好
  loadPreferences() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PREFERENCES)
      return data ? { ...DEFAULT_PREFERENCES, ...JSON.parse(data) } : DEFAULT_PREFERENCES
    } catch (error) {
      console.error('加载偏好设置失败:', error)
      return DEFAULT_PREFERENCES
    }
  }

  // 清理过期数据（7天前的）
  cleanOldData() {
    try {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      const tabs = this.loadTabs()
      const filteredTabs = tabs.filter((tab: any) =>
        !tab.lastModified || tab.lastModified > weekAgo
      )

      if (filteredTabs.length !== tabs.length) {
        this.saveTabs(filteredTabs)
        return tabs.length - filteredTabs.length
      }
      return 0
    } catch (error) {
      console.error('清理旧数据失败:', error)
      return 0
    }
  }

  // 清理所有数据
  clearAll() {
    try {
      Object.values(STORAGE_KEYS).forEach(key => {
        if (key.endsWith('_')) {
          // 清理所有以特定前缀开头的键
          Object.keys(localStorage)
            .filter(k => k.startsWith(key))
            .forEach(k => localStorage.removeItem(k))
        } else {
          localStorage.removeItem(key)
        }
      })
      return true
    } catch (error) {
      console.error('清理所有数据失败:', error)
      return false
    }
  }

  // 清理所有yiw_相关的配置（退出登录时调用）
  clearAllYiWData() {
    try {
      console.log('正在清理所有YiW相关的localStorage配置...')

      // 获取所有localStorage键
      const allKeys = Object.keys(localStorage)

      // 筛选出所有以yiw_开头的键
      const yiwKeys = allKeys.filter(key => key.startsWith(AGENTIC_DATA_PREFIX))

      console.log('找到以下YiW相关配置:', yiwKeys)

      // 删除所有yiw_相关的配置
      yiwKeys.forEach(key => {
        localStorage.removeItem(key)
        console.log(`已删除: ${key}`)
      })

      console.log(`成功清理了 ${yiwKeys.length} 个YiW相关配置`)
      return {
        success: true,
        clearedCount: yiwKeys.length,
        clearedKeys: yiwKeys
      }
    } catch (error: any) {
      console.error('清理YiW配置失败:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  // 清理数据库选择记录
  clearSelectedDatabase() {
    try {
      localStorage.removeItem(STORAGE_KEYS.SELECTED_DATABASE)
      return true
    } catch (error) {
      console.error('清理数据库选择失败:', error)
      return false
    }
  }

  // 查看当前localStorage中所有yiw_相关的配置（调试用）
  inspectYiWData() {
    try {
      const allKeys = Object.keys(localStorage)
      const yiwKeys = allKeys.filter(key => key.startsWith(AGENTIC_DATA_PREFIX))

      console.log('=== YiW localStorage 配置检查 ===')
      console.log(`找到 ${yiwKeys.length} 个yiw_相关配置:`)

      const data: any = {}
      yiwKeys.forEach(key => {
        try {
          const value = localStorage.getItem(key)
          data[key] = value ? JSON.parse(value) : value
          console.log(`${key}:`, data[key])
        } catch (parseError) {
          data[key] = localStorage.getItem(key) // 原始字符串
          console.log(`${key} (字符串):`, data[key])
        }
      })

      console.log('=== 检查完成 ===')
      return {
        count: yiwKeys.length,
        keys: yiwKeys,
        data: data
      }
    } catch (error) {
      console.error('检查YiW配置失败:', error)
      return null
    }
  }

  // 调试登录状态和localStorage（调试用）
  debugLoginStatus() {
    try {
      console.log('=== 登录状态和localStorage调试 ===')

      // 检查各种可能的token存储位置
      const standaloneToken = localStorage.getItem('token')
      const authToken = localStorage.getItem('authToken')
      const accessToken = localStorage.getItem('access_token')
      const basicStore = localStorage.getItem('basic')

      console.log('Token存储检查:')
      console.log('- localStorage.token:', standaloneToken)
      console.log('- localStorage.authToken:', authToken)
      console.log('- localStorage.access_token:', accessToken)
      console.log('- localStorage.basic:', basicStore)

      // 解析basic store
      if (basicStore) {
        try {
          const parsed = JSON.parse(basicStore)
          console.log('Basic Store解析结果:', parsed)
          console.log('- basic.token:', parsed.token)
          console.log('- basic.userInfo:', parsed.userInfo)
          console.log('- basic.isAdmin:', parsed.isAdmin)
        } catch (error) {
          console.error('解析basic store失败:', error)
        }
      }

      // 检查登录状态
      const loginStatus = isUserLoggedIn()
      console.log('isUserLoggedIn()结果:', loginStatus)

      // 检查所有localStorage keys
      const allKeys = Object.keys(localStorage)
      console.log('所有localStorage keys:', allKeys)

      console.log('=== 调试完成 ===')

      return {
        tokens: {
          standalone: standaloneToken,
          auth: authToken,
          access: accessToken,
          basicStore: basicStore
        },
        loginStatus: loginStatus,
        allKeys: allKeys
      }
    } catch (error) {
      console.error('调试登录状态失败:', error)
      return null
    }
  }
}

export default new QueryPanelStorage()

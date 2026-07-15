import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import settings from '@/settings'
import { navigate } from '@/router/navigation'
import { constantRoutes } from '@/router/routes'

export interface UserInfo {
  userId: string
  username: string
  avatar: string
  email: string
  is_admin: boolean
  can_create_project: boolean
}

interface SidebarState {
  opened: boolean
  collapsed: boolean
  hidden: boolean
}

interface AxiosPromiseItem {
  url?: string
  cancel: (msg?: string) => void
}

export interface BasicState {
  token: string
  getUserInfo: boolean
  userInfo: UserInfo
  allRoutes: any[]
  buttonCodes: string[]
  filterAsyncRoutes: any[]
  cachedViews: string[]
  cachedViewsDeep: string[]
  sessionStates: Record<string, any>
  sidebar: SidebarState
  isAdminMode: boolean
  axiosPromiseArr: AxiosPromiseItem[]
  settings: typeof settings

  remotePromiseArrByReqUrl: (reqUrl?: string) => void
  clearPromiseArr: () => void
  setToken: (token: string) => void
  setFilterAsyncRoutes: (routes: any[]) => void
  setUserInfo: (payload?: { userInfo?: Partial<UserInfo> }) => void
  resetState: () => void
  resetStateAndToLogin: () => void
  setSidebarOpen: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  setSidebarHidden: (v: boolean) => void
  toggleSidebar: () => void
  toggleSidebarHidden: () => void
  setToggleSideBar: () => void
  setAdminMode: (v: boolean) => void
  toggleAdminMode: () => void
  addCachedView: (view: string) => void
  delCachedView: (view: string) => void
  addCachedViewDeep: (view: string) => void
  delCacheViewDeep: (view: string) => void
  saveSessionState: (sessionId: string, sessionState: any) => void
  getSessionState: (sessionId: string) => any
  getAllSessionStates: () => Record<string, any>
  clearSessionState: (sessionId: string) => void
  clearAllSessionStates: () => void
}

const emptyUserInfo = (): UserInfo => ({
  userId: '',
  username: '',
  avatar: '',
  email: '',
  is_admin: false,
  can_create_project: false
})

export const useBasicStore = create<BasicState>()(
  persist(
    (set, get) => ({
      token: '',
      getUserInfo: false,
      userInfo: emptyUserInfo(),
      allRoutes: [],
      buttonCodes: [],
      filterAsyncRoutes: [],
      cachedViews: [],
      cachedViewsDeep: [],
      sessionStates: {},
      sidebar: { opened: true, collapsed: false, hidden: false },
      isAdminMode: false,
      axiosPromiseArr: [],
      settings,

      remotePromiseArrByReqUrl: (reqUrl) =>
        set((s) => ({ axiosPromiseArr: s.axiosPromiseArr.filter((f) => f.url !== reqUrl) })),
      clearPromiseArr: () => set({ axiosPromiseArr: [] }),
      setToken: (token) => set({ token }),
      setFilterAsyncRoutes: (routes) =>
        set({ filterAsyncRoutes: routes, allRoutes: constantRoutes.concat(routes) }),
      setUserInfo: (payload) => {
        const userInfo = payload?.userInfo
        if (!userInfo) {
          set({ getUserInfo: false, userInfo: emptyUserInfo() })
          return
        }
        set({
          getUserInfo: true,
          userInfo: {
            userId: userInfo.userId || '',
            username: userInfo.username || '',
            avatar: userInfo.avatar || '',
            email: userInfo.email || '',
            is_admin: userInfo.is_admin || false,
            can_create_project: userInfo.can_create_project || false
          }
        })
      },
      resetState: () =>
        set({
          token: '',
          allRoutes: [],
          buttonCodes: [],
          filterAsyncRoutes: [],
          userInfo: emptyUserInfo(),
          getUserInfo: false
        }),
      resetStateAndToLogin: () => {
        get().resetState()
        queueMicrotask(() => navigate('/agent'))
      },
      setSidebarOpen: (v) => set((s) => ({ sidebar: { ...s.sidebar, opened: v } })),
      setSidebarCollapsed: (v) => set((s) => ({ sidebar: { ...s.sidebar, collapsed: v } })),
      setSidebarHidden: (v) => set((s) => ({ sidebar: { ...s.sidebar, hidden: v } })),
      toggleSidebar: () => set((s) => ({ sidebar: { ...s.sidebar, collapsed: !s.sidebar.collapsed } })),
      toggleSidebarHidden: () => set((s) => ({ sidebar: { ...s.sidebar, hidden: !s.sidebar.hidden } })),
      setToggleSideBar: () => set((s) => ({ sidebar: { ...s.sidebar, opened: !s.sidebar.opened } })),
      setAdminMode: (v) => set({ isAdminMode: v }),
      toggleAdminMode: () => set((s) => ({ isAdminMode: !s.isAdminMode })),
      addCachedView: (view) =>
        set((s) => (s.cachedViews.includes(view) ? s : { cachedViews: [...s.cachedViews, view] })),
      delCachedView: (view) => set((s) => ({ cachedViews: s.cachedViews.filter((v) => v !== view) })),
      addCachedViewDeep: (view) =>
        set((s) => (s.cachedViewsDeep.includes(view) ? s : { cachedViewsDeep: [...s.cachedViewsDeep, view] })),
      delCacheViewDeep: (view) => set((s) => ({ cachedViewsDeep: s.cachedViewsDeep.filter((v) => v !== view) })),
      saveSessionState: (sessionId, sessionState) =>
        set((s) => ({
          sessionStates: {
            ...s.sessionStates,
            [sessionId]: { ...s.sessionStates[sessionId], ...sessionState, lastUpdated: Date.now() }
          }
        })),
      getSessionState: (sessionId) => get().sessionStates[sessionId] || null,
      getAllSessionStates: () => get().sessionStates,
      clearSessionState: (sessionId) =>
        set((s) => {
          const next = { ...s.sessionStates }
          delete next[sessionId]
          return { sessionStates: next }
        }),
      clearAllSessionStates: () => set({ sessionStates: {} })
    }),
    {
      name: 'basic',
      partialize: (s) => ({
        token: s.token,
        userInfo: s.userInfo,
        sidebar: s.sidebar,
        sessionStates: s.sessionStates,
        isAdminMode: s.isAdminMode
      })
    }
  )
)

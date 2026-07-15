/**
 * 全局设置(对齐原 src/settings.js)。仅保留 React 工程仍有意义的字段。
 */
export interface AppSettings {
  title: string
  sidebarLogo: boolean
  showNavbarTitle: boolean
  ShowDropDown: boolean
  showHamburger: boolean
  showLeftMenu: boolean
  showTagsView: boolean
  tagsViewNum: number
  showTopNavbar: boolean
  mainNeedAnimation: boolean
  isNeedNprogress: boolean
  isNeedLogin: boolean
  permissionMode: 'rbac' | 'roles' | 'code'
  errorLog: string[]
  delWindowHeight: string
  tmpToken: string
  viteBasePath: string
  defaultLanguage: 'zh' | 'en'
  defaultTheme: string
  defaultSize: 'large' | 'default' | 'small'
  plateFormId: number
  enableDocs: boolean
}

export const settings: AppSettings = {
  title: 'YiW',
  sidebarLogo: true,
  showNavbarTitle: false,
  ShowDropDown: true,
  showHamburger: true,
  showLeftMenu: true,
  showTagsView: true,
  tagsViewNum: 6,
  showTopNavbar: true,
  mainNeedAnimation: false,
  isNeedNprogress: true,
  isNeedLogin: true,
  permissionMode: 'roles',
  errorLog: ['prod'],
  delWindowHeight: '210px',
  tmpToken: 'tmp_token',
  viteBasePath: '/',
  defaultLanguage: 'zh',
  defaultTheme: 'yiw-warm',
  defaultSize: 'default',
  plateFormId: 2,
  enableDocs: true
}

export default settings

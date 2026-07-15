// yiw-agent 主题上下文:亮 / 暗 / 跟随系统。
// 入口(index.tsx)持有状态并应用到 .yiw-root[data-theme] 与 MantineProvider;
// 左栏底部的三态开关通过 useYiWTheme() 读取与切换。
import { createContext, useContext } from 'react'

export type YiWThemeMode = 'light' | 'dark' | 'system'
export type YiWScheme = 'light' | 'dark'

export interface YiWThemeCtx {
  mode: YiWThemeMode
  scheme: YiWScheme // 实际生效(system 已解析)
  setMode: (m: YiWThemeMode) => void
}

export const YiWThemeContext = createContext<YiWThemeCtx>({
  mode: 'system',
  scheme: 'light',
  setMode: () => {}
})

export const useYiWTheme = () => useContext(YiWThemeContext)

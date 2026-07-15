// yiw-agent 桌面入口(顶级路由 /agent,layout:false,自带外壳)。
// 旧智能问数页面已下线;问数能力保留为后端/eval 能力,不再暴露独立页面路由。
// 主题:亮(对齐问数·YiW 深绿)/ 暗(中性灰黑)/ 跟随系统 —— 由 .yiw-root[data-theme] + Mantine 同步。
import { useEffect, useMemo, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import YiWShell from './YiWShell'
import { applyYiWZoom, loadYiWSettings } from './YiWSettings'
import { YiWThemeContext, type YiWScheme, type YiWThemeMode } from './themeContext'
import './yiw-theme.scss'

const STORAGE_KEY = 'yiw-theme'
const systemScheme = (): YiWScheme =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

export default function AgentPage() {
  const [mode, setMode] = useState<YiWThemeMode>(
    () => (localStorage.getItem(STORAGE_KEY) as YiWThemeMode) || 'dark'
  )
  const [sysScheme, setSysScheme] = useState<YiWScheme>(systemScheme)

  // 跟随系统:监听 prefers-color-scheme 变化
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSysScheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  // 应用上次保存的界面缩放(设置页可调,刷新后续用)
  useEffect(() => {
    applyYiWZoom(loadYiWSettings().zoom)
  }, [])

  const scheme: YiWScheme = mode === 'system' ? sysScheme : mode

  // resize 时露白:给 html 设主题底色(= app 外缘色),让拖拽暴露的区域不再是默认白。
  // 同时把 Mantine 配色方案挂到 <html>:body 上的传送门弹层(Select 下拉等)逃出了
  // 嵌套 MantineProvider 的暗色作用域,只有挂到根才会跟着变暗。
  // 仅 yiw 路由期间生效,卸载即还原,不影响问数。
  useEffect(() => {
    const el = document.documentElement
    const prevBg = el.style.backgroundColor
    const prevScheme = el.getAttribute('data-mantine-color-scheme')
    el.style.backgroundColor = scheme === 'dark' ? '#202a25' : 'var(--el-color-primary-light-9, #f1ecf6)'
    el.setAttribute('data-mantine-color-scheme', scheme)
    return () => {
      el.style.backgroundColor = prevBg
      if (prevScheme) el.setAttribute('data-mantine-color-scheme', prevScheme)
      else el.removeAttribute('data-mantine-color-scheme')
    }
  }, [scheme])
  const ctx = useMemo(() => ({ mode, scheme, setMode }), [mode, scheme])

  return (
    <YiWThemeContext.Provider value={ctx}>
      <MantineProvider forceColorScheme={scheme}>
        <div className="yiw-root" data-theme={scheme}>
          {/* 拖拽区 + 外框 padding 在 .yiw-root(不缩放);缩放只作用于 .yiw-zoom 内的内容 */}
          <div className="yiw-dragbar" />
          <div className="yiw-dragbar-side" />
          <div className="yiw-zoom">
            <YiWShell />
          </div>
        </div>
      </MantineProvider>
    </YiWThemeContext.Provider>
  )
}

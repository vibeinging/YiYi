import type { ReactNode } from 'react'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/lang'
import { mantineTheme } from '@/theme/mantineTheme'

// Mantine 样式入口(全局,一次性引入)
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dates/styles.css'
import '@mantine/dropzone/styles.css'

/**
 * 全局 Provider 聚合(对齐原 main.js 里 app.use(...) 的一串注册)：
 * - MantineProvider   ← element-plus + ElConfigProvider
 * - Notifications     ← ElMessage / ElNotification
 * - ModalsProvider    ← ElMessageBox
 * - I18nextProvider   ← vue-i18n
 */
export default function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MantineProvider theme={mantineTheme} defaultColorScheme="light">
        <Notifications position="top-center" />
        <ModalsProvider>{children}</ModalsProvider>
      </MantineProvider>
    </I18nextProvider>
  )
}

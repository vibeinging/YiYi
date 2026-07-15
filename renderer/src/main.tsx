import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import AppProviders from '@/providers/AppProviders'
import { router } from '@/router'
import { initApp } from '@/app-init'

// ── 全局样式 + 副作用(对齐原 main.js 的一串 import) ──
import 'virtual:svg-icons-register'
import '@/theme/index.scss'
import '@/styles/index.scss'
import '@xyflow/react/dist/style.css'
import 'katex/dist/katex.min.css'
import 'nprogress/nprogress.css'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

initApp()

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <AppProviders>
    <RouterProvider router={router} />
  </AppProviders>
)

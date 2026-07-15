import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import UnifiedReportIndex from '@/views/unified-report/index'
import UnifiedReportEditor from '@/views/unified-report/editor'
import UnifiedReportViewer from '@/views/unified-report/viewer'
import styles from './UnifiedReportSettings.module.scss'

/**
 * 报告模板设置入口：根据路由 hash 在 列表 / 新建 / 编辑 / 查看 之间切换，
 * 并把子组件发出的 navigate 事件写回 hash，保持与 Vue 版完全一致的行为。
 *
 * hash 约定：
 *   #reportTemplates                     → list
 *   #reportTemplates:create              → create
 *   #reportTemplates:edit:<id>           → edit
 *   #reportTemplates:view:<id>           → view
 */
export default function UnifiedReportSettings() {
  const location = useLocation()
  const navigate = useNavigate()

  // computed(reportState) → useMemo，依赖 hash
  const reportState = useMemo(() => {
    const hash = location.hash?.replace('#', '') || 'reportTemplates'
    const segments = hash.split(':')
    const [, mode = 'list', id = ''] = segments

    if (mode === 'create') {
      return { mode: 'create', id: '' }
    }
    if (mode === 'edit') {
      return { mode: 'edit', id }
    }
    if (mode === 'view') {
      return { mode: 'view', id }
    }
    return { mode: 'list', id: '' }
  }, [location.hash])

  const viewMode = reportState.mode
  const currentId = reportState.id

  const updateHash = useCallback(
    (mode = 'list', id = '') => {
      const hash =
        mode === 'list'
          ? '#reportTemplates'
          : `#reportTemplates:${mode}${id ? `:${id}` : ''}`
      // router.replace({ hash }) → navigate(hash, { replace: true })
      navigate(`${location.pathname}${location.search}${hash}`, { replace: true })
    },
    [navigate, location.pathname, location.search]
  )

  // @navigate → onNavigate 回调 prop
  const handleNavigate = useCallback(
    ({ mode = 'list', id = '' }: { mode?: string; id?: any } = {}) => {
      updateHash(mode, id)
    },
    [updateHash]
  )

  return (
    <div className={styles.unifiedReportSettings}>
      {viewMode === 'list' && (
        <UnifiedReportIndex embedded onNavigate={handleNavigate} />
      )}
      {(viewMode === 'create' || viewMode === 'edit') && (
        <UnifiedReportEditor
          // key 保证 mode/id 变化时重新挂载，等价于 Vue 的 :key
          key={`${viewMode}:${currentId || 'new'}`}
          embedded
          templateId={currentId}
          onNavigate={handleNavigate}
        />
      )}
      {viewMode === 'view' && (
        <UnifiedReportViewer
          key={`${viewMode}:${currentId}`}
          embedded
          reportId={currentId}
        />
      )}
    </div>
  )
}

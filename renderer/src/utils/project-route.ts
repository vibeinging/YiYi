import { useProjectStore } from '@/store/project'

const resolveProjectId = (explicitId?: string) =>
  explicitId || useProjectStore.getState().currentProject?.id || ''

/**
 * 拼接带项目 ID 的路径：projectPath('settings') → /project/<id>/settings
 * 当前没有项目时返回 /projects，让守卫去兜底。
 */
export const projectPath = (subpath: string | number = '', projectId?: string): string => {
  const id = resolveProjectId(projectId)
  if (!id) return '/projects'
  const tail = String(subpath).replace(/^\/+/, '')
  return tail ? `/project/${id}/${tail}` : `/project/${id}`
}

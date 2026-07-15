import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Group, Textarea, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { IconFolder, IconFolderCog, IconFolderOpen } from '@tabler/icons-react'
import {
  getProjectWorkspaceDirReq,
  openProjectFolderReq,
  setProjectWorkspaceDirReq,
  updateProjectReq
} from '@/api/project'
import { isDesktop, pickFolder } from '@/views/agent/folders'
import styles from './BasicInfo.module.scss'

interface BasicInfoProps {
  project?: any
  // defineEmits(['updated']) → 回调 prop
  onUpdated?: (data: any) => void
}

export default function BasicInfo({ project = null, onUpdated }: BasicInfoProps) {
  const { t } = useTranslation()

  // 保存中状态
  const [saving, setSaving] = useState(false)
  // 本机工作区有效路径(后端解析,跟随自定义位置;仅桌面端展示)
  const [wsPath, setWsPath] = useState<string | null>(null)
  const [relocating, setRelocating] = useState(false)
  const desktop = isDesktop()

  // 表单 + 校验规则
  const form = useForm({
    initialValues: {
      name: '',
      description: ''
    },
    validate: {
      name: (value: string) => {
        if (!value) return t('project.rules.name')
        if (value.length < 2 || value.length > 100) return t('project.rules.nameLength')
        return null
      }
    }
  })

  // 监听项目变化，更新表单（watch immediate）
  useEffect(() => {
    if (project) {
      form.setValues({
        name: project.name || '',
        description: project.description || ''
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  // 工作区有效路径:从后端取(跟随自定义位置),仅桌面端
  useEffect(() => {
    if (!desktop || !project?.id) {
      setWsPath(null)
      return
    }
    let alive = true
    getProjectWorkspaceDirReq(project.id)
      .then((res: any) => alive && setWsPath(res?.data?.path || null))
      .catch(() => alive && setWsPath(null))
    return () => {
      alive = false
    }
  }, [desktop, project?.id])

  // 是否有修改
  const hasChanges = useMemo(() => {
    if (!project) return false
    return form.values.name !== project.name || form.values.description !== (project.description || '')
  }, [project, form.values.name, form.values.description])

  // 重置表单
  const resetForm = () => {
    if (project) {
      form.setValues({
        name: project.name || '',
        description: project.description || ''
      })
    }
  }

  // 保存
  const handleSave = async () => {
    const validation = form.validate()
    if (validation.hasErrors) return

    setSaving(true)
    try {
      const res: any = await updateProjectReq(project.id, {
        name: form.values.name,
        description: form.values.description
      })
      notifications.show({ color: 'green', message: t('project.basicInfo.updateSuccess') })
      onUpdated?.(res.data)
    } catch (err: any) {
      console.error('更新失败:', err)
      notifications.show({
        color: 'red',
        message: err?.msg || t('project.basicInfo.updateFailed')
      })
    } finally {
      setSaving(false)
    }
  }

  // 格式化日期
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // 打开本机工作区文件夹:走后端(确保目录存在 → 系统文件管理器打开),失败给提示
  const openFolder = async () => {
    if (!project?.id) return
    try {
      await openProjectFolderReq(project.id)
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || '打开文件夹失败' })
    }
  }

  // 更换工作区位置:原生选目录 → 后端迁移内容 + 软链 → 刷新路径
  const relocate = async () => {
    if (!project?.id) return
    const picked = await pickFolder()
    if (!picked) return
    setRelocating(true)
    try {
      const res: any = await setProjectWorkspaceDirReq(project.id, picked)
      setWsPath(res?.data?.path || picked)
      notifications.show({ color: 'green', message: t('project.basicInfo.relocateSuccess') })
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || t('project.basicInfo.relocateFailed') })
    } finally {
      setRelocating(false)
    }
  }

  // 路径展示:家目录折叠成 ~
  const prettyPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

  const initial = (project?.name || '·').trim().charAt(0).toUpperCase()

  return (
    <div className={styles.basicInfo}>
      {/* 身份头:文件夹标 + 名称 + 打开文件夹 */}
      <div className={styles.identity}>
        <button
          type="button"
          className={styles.avatar}
          onClick={desktop ? openFolder : undefined}
          disabled={!desktop}
          title={desktop ? t('project.basicInfo.openFolder') : undefined}
          data-clickable={desktop ? 'true' : undefined}
        >
          {desktop ? <IconFolder size={26} stroke={1.5} /> : <span className={styles.avatarInitial}>{initial}</span>}
        </button>
        <div className={styles.identityMain}>
          <div className={styles.identityName} title={project?.name || ''}>
            {project?.name || '-'}
          </div>
          <div className={styles.identitySub}>
            <span>{desktop ? t('project.basicInfo.subtitle') : project?.description || '—'}</span>
          </div>
        </div>
        {desktop && (
          <button type="button" className={styles.openBtn} onClick={openFolder}>
            <IconFolderOpen size={16} stroke={1.7} />
            <span>{t('project.basicInfo.openFolder')}</span>
          </button>
        )}
      </div>

      {/* 编辑表单 */}
      <form className={styles.form} onSubmit={form.onSubmit(() => handleSave())}>
        <TextInput
          classNames={{ label: styles.formLabel }}
          label={t('project.form.name')}
          placeholder={t('project.form.namePlaceholder')}
          maxLength={100}
          mb="md"
          {...form.getInputProps('name')}
        />

        <Textarea
          classNames={{ label: styles.formLabel }}
          label={t('project.form.description')}
          placeholder={t('project.form.descriptionPlaceholder')}
          rows={4}
          maxLength={500}
          mb="md"
          {...form.getInputProps('description')}
        />

        <Group className={styles.formActions}>
          <Button type="submit" loading={saving} disabled={!hasChanges}>
            {t('project.basicInfo.save')}
          </Button>
          {hasChanges && (
            <Button variant="default" type="button" onClick={resetForm}>
              {t('project.basicInfo.reset')}
            </Button>
          )}
        </Group>
      </form>

      {/* 元信息卡 */}
      <div className={styles.meta}>
        {desktop && (
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{t('project.basicInfo.localWorkspace')}</span>
            <span className={`${styles.metaValue} ${styles.metaPath}`} title={wsPath || ''}>
              {wsPath ? prettyPath(wsPath) : t('project.basicInfo.resolvingPath')}
            </span>
            <button
              type="button"
              className={styles.metaAction}
              onClick={relocate}
              disabled={relocating}
              aria-label={t('project.basicInfo.changeLocation')}
              data-tip={t('project.basicInfo.changeLocation')}
            >
              <IconFolderCog size={15} stroke={1.8} />
            </button>
            <button
              type="button"
              className={styles.metaAction}
              onClick={openFolder}
              aria-label={t('project.basicInfo.revealInFinder')}
              data-tip={t('project.basicInfo.revealInFinder')}
            >
              <IconFolderOpen size={14} stroke={1.8} />
            </button>
          </div>
        )}

        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>{t('project.basicInfo.createdAt')}</span>
          <span className={styles.metaValue}>{formatDate(project?.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

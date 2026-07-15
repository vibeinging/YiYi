import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, Radio, Switch } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { setProjectOpenReq, getProjectDetailReq } from '@/api/project'
import styles from './OpenAccessConfig.module.scss'

interface OpenAccessConfigProps {
  project?: any
  // defineEmits(['updated']) → 回调 prop
  onUpdated?: (data: any) => void
}

// 权限选项静态定义(EP 图标名 → ElSvgIcon)
interface PermOption {
  value: string
  // label/desc 的 i18n key,渲染时再 t()
  labelKey: string
  descKey: string
  icon: string
  checked: boolean
  locked?: boolean
}

const PERMISSION_OPTIONS: PermOption[] = [
  {
    value: 'ask_data',
    labelKey: 'project.openAccess.permCards.askData',
    descKey: 'project.openAccess.permCards.askDataDesc',
    icon: 'Search',
    checked: true,
    locked: true
  },
  {
    value: 'data_manage',
    labelKey: 'project.openAccess.permCards.dataManage',
    descKey: 'project.openAccess.permCards.dataManageDesc',
    icon: 'Coin',
    checked: false
  },
  {
    value: 'model_service_manage',
    labelKey: 'project.openAccess.permCards.modelService',
    descKey: 'project.openAccess.permCards.modelServiceDesc',
    icon: 'Setting',
    checked: false
  },
  {
    value: 'report_manage',
    labelKey: 'project.openAccess.permCards.report',
    descKey: 'project.openAccess.permCards.reportDesc',
    icon: 'DataAnalysis',
    checked: false
  },
  {
    value: 'member_manage',
    labelKey: 'project.openAccess.permCards.memberManage',
    descKey: 'project.openAccess.permCards.memberManageDesc',
    icon: 'User',
    checked: false
  }
]

export default function OpenAccessConfig({ project = null, onUpdated }: OpenAccessConfigProps) {
  const { t } = useTranslation()

  // 加载/保存中状态
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // 开关
  const [isOpen, setIsOpen] = useState(false)
  const [initialIsOpen, setInitialIsOpen] = useState(false)
  // 关闭时是否移除成员
  const [removeMembers, setRemoveMembers] = useState(false)

  // 权限卡片选中态(克隆静态定义,checked 可变)
  const [permissionOptions, setPermissionOptions] = useState<PermOption[]>(() =>
    PERMISSION_OPTIONS.map((p) => ({ ...p }))
  )
  // 初始权限快照(用于 hasChanges 比对)
  const initialPermissions = useRef<string[]>([])

  // 切换某张卡片的选中态
  const togglePerm = (value: string) => {
    setPermissionOptions((prev) =>
      prev.map((p) => (p.value === value && !p.locked ? { ...p, checked: !p.checked } : p))
    )
  }

  // 是否有修改(computed)
  const hasChanges = useMemo(() => {
    if (isOpen !== initialIsOpen) return true
    const currentPerms = permissionOptions.filter((p) => p.checked).map((p) => p.value)
    if (currentPerms.length !== initialPermissions.current.length) return true
    return !currentPerms.every((p) => initialPermissions.current.includes(p))
  }, [isOpen, initialIsOpen, permissionOptions])

  // 应用项目数据到本地状态
  const applyProjectData = (projectData: any) => {
    const open = projectData.is_open || false
    setIsOpen(open)
    setInitialIsOpen(open)

    const existingPerms: string[] = projectData.open_permissions || []
    setPermissionOptions(
      PERMISSION_OPTIONS.map((p) => ({
        ...p,
        checked: p.locked ? true : existingPerms.includes(p.value)
      }))
    )
    initialPermissions.current = [...existingPerms]
  }

  // onMounted:首次加载,必要时回查详情
  useEffect(() => {
    const init = async () => {
      if (!project?.id) return
      const hasValidPerms = project.open_permissions?.length > 0 || !project.is_open
      if (hasValidPerms) {
        applyProjectData(project)
        return
      }
      setLoading(true)
      try {
        const res: any = await getProjectDetailReq(project.id)
        applyProjectData(res.data)
      } catch {
        applyProjectData(project)
      } finally {
        setLoading(false)
      }
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // watch(() => props.project):项目变化时重新应用
  useEffect(() => {
    if (project) {
      applyProjectData(project)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  // 保存
  const handleSave = async () => {
    const permissions = permissionOptions.filter((p) => p.checked).map((p) => p.value)

    if (isOpen && permissions.length === 0) {
      notifications.show({ color: 'yellow', message: t('project.openAccess.atLeastOnePermission') })
      return
    }

    const isClosing = !isOpen && initialIsOpen
    await doSave(isClosing ? [] : permissions, isClosing ? removeMembers : false)
  }

  const doSave = async (permissions: string[], removeOpenMembers: boolean) => {
    setSaving(true)
    try {
      const res: any = await setProjectOpenReq(project.id, {
        is_open: isOpen,
        permissions: isOpen ? permissions : [],
        remove_open_members: removeOpenMembers
      })
      notifications.show({ color: 'green', message: t('project.openAccess.saveSuccess') })

      setInitialIsOpen(isOpen)
      initialPermissions.current = [...permissions]

      onUpdated?.(res.data)
    } catch (e) {
      notifications.show({ color: 'red', message: t('project.openAccess.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.openAccessConfig}>
      <div className={styles.sectionBody}>
        {/* 开关 */}
        <div className={styles.openToggle}>
          <div className={styles.toggleInfo}>
            <h3>{t('project.openAccess.title')}</h3>
            <p className={styles.toggleDesc}>{t('project.openAccess.desc')}</p>
          </div>
          <Switch
            checked={isOpen}
            onChange={(e) => setIsOpen(e.currentTarget.checked)}
            disabled={loading}
          />
        </div>

        {/* 开启状态:权限卡片 */}
        {isOpen && (
          <div className={styles.permissionsSection}>
            <div className={styles.sectionHeader}>
              <h4>{t('project.openAccess.permissions')}</h4>
              <p className={styles.permissionsDesc}>{t('project.openAccess.permissionsDesc')}</p>
            </div>

            <div className={styles.permissionCards}>
              {permissionOptions.map((perm) => (
                <div
                  key={perm.value}
                  className={`${styles.permCard} ${perm.checked ? styles.checked : ''} ${
                    perm.locked ? styles.locked : ''
                  }`}
                  onClick={() => !perm.locked && togglePerm(perm.value)}
                >
                  <div className={styles.permCardHeader}>
                    <div className={`${styles.permIconWrap} ${styles[perm.value]}`}>
                      <ElSvgIcon name={perm.icon} size={18} />
                    </div>
                    <Checkbox
                      checked={perm.checked}
                      disabled={perm.locked}
                      onChange={() => togglePerm(perm.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className={styles.permCardBody}>
                    <h5 className={styles.permName}>{t(perm.labelKey)}</h5>
                    <p className={styles.permDesc}>{t(perm.descKey)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 关闭状态且原来是开启的:显示成员处理选项 */}
        {!isOpen && initialIsOpen && (
          <div className={styles.closeOptionsSection}>
            <div className={styles.sectionHeader}>
              <h4>{t('project.openAccess.closeConfirmTitle')}</h4>
            </div>
            <div className={styles.closeOptions}>
              <div
                className={`${styles.closeOptionCard} ${!removeMembers ? styles.active : ''}`}
                onClick={() => setRemoveMembers(false)}
              >
                <div className={`${styles.optionIcon} ${styles.keep}`}>
                  <ElSvgIcon name="User" size={20} />
                </div>
                <div className={styles.optionContent}>
                  <h5>{t('project.openAccess.closeConfirmKeep')}</h5>
                  <p>{t('project.openAccess.closeConfirmKeepDesc')}</p>
                </div>
                <Radio
                  checked={!removeMembers}
                  onChange={() => setRemoveMembers(false)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div
                className={`${styles.closeOptionCard} ${removeMembers ? styles.active : ''}`}
                onClick={() => setRemoveMembers(true)}
              >
                <div className={`${styles.optionIcon} ${styles.remove}`}>
                  <ElSvgIcon name="RemoveFilled" size={20} />
                </div>
                <div className={styles.optionContent}>
                  <h5>{t('project.openAccess.closeConfirmRemove')}</h5>
                  <p>{t('project.openAccess.closeConfirmRemoveDesc')}</p>
                </div>
                <Radio
                  checked={removeMembers}
                  onChange={() => setRemoveMembers(true)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          </div>
        )}

        {/* 保存按钮 */}
        <div className={styles.actionBar}>
          <Button loading={saving} disabled={!hasChanges} onClick={handleSave}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

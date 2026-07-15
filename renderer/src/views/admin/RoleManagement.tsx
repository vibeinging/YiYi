// 角色管理 —— 迁移自 webui/src/views/admin/RoleManagement.vue
import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, TextInput, Select, Textarea, Checkbox, Modal, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { IconPlus, IconSearch, IconUserFilled } from '@tabler/icons-react'
import { getRolesReq, createRoleReq, updateRoleReq, deleteRoleReq } from '@/api/project'
import styles from './RoleManagement.module.scss'

interface RoleRow {
  id: any
  name: string
  code: string
  description: string
  is_system: boolean
  permissions: string[]
  created_at: any
}

interface PermItem {
  code: string
  name: string
}

interface PermGroup {
  name: string
  permissions: PermItem[]
}

interface RoleForm {
  name: string
  code: string
  description: string
  permissions: string[]
}

export default function RoleManagement() {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dialogVisible, setDialogVisible] = useState(false)
  const [isEdit, setIsEdit] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<any>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [filterType, setFilterType] = useState<string>('')

  // 角色列表（从API获取）
  const [roleList, setRoleList] = useState<RoleRow[]>([])

  // 过滤后的角色列表（现在由后端处理过滤，这里直接返回）
  const filteredRoleList = roleList

  // 表单
  const [form, setForm] = useState<RoleForm>({
    name: '',
    code: '',
    description: '',
    permissions: []
  })
  // 表单校验错误
  const [errors, setErrors] = useState<{ name?: string; code?: string }>({})

  // 权限分组
  const permissionGroups = useMemo<PermGroup[]>(
    () => [
      {
        name: t('admin.roles.permGroup.memberMgmt'),
        permissions: [{ code: 'member_manage', name: t('admin.roles.perm.manageMembers') }]
      },
      {
        name: t('admin.roles.permGroup.dataConfig'),
        permissions: [
          { code: 'data_manage', name: t('admin.roles.perm.dataManage') },
          { code: 'model_service_manage', name: t('admin.roles.perm.modelServiceManage') }
        ]
      },
      {
        name: t('admin.roles.permGroup.dataQuery'),
        permissions: [{ code: 'ask_data', name: t('admin.roles.perm.askData') }]
      },
      {
        name: t('admin.roles.permGroup.reportMgmt'),
        permissions: [{ code: 'report_manage', name: t('admin.roles.perm.manageReports') }]
      }
    ],
    [t]
  )

  // 权限名称映射
  const permissionLabels = useMemo<Record<string, string>>(
    () => ({
      member_manage: t('admin.roles.permLabel.memberManage'),
      data_manage: t('admin.roles.permLabel.dataManage'),
      model_service_manage: t('admin.roles.permLabel.modelService'),
      ask_data: t('admin.roles.permLabel.askData'),
      report_manage: t('admin.roles.permLabel.report')
    }),
    [t]
  )

  const formatDate = (date: any) => {
    if (!date) return '-'
    return new Date(date).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // 获取显示的权限（最多3个）
  const getDisplayPermissions = (row: RoleRow) => {
    if (!row.permissions) return []
    return row.permissions.map((p) => permissionLabels[p] || p)
  }

  // 权限分组全选相关
  const isGroupAllChecked = (group: PermGroup) => {
    return group.permissions.every((p) => form.permissions.includes(p.code))
  }

  const isGroupIndeterminate = (group: PermGroup) => {
    const checkedCount = group.permissions.filter((p) => form.permissions.includes(p.code)).length
    return checkedCount > 0 && checkedCount < group.permissions.length
  }

  const toggleGroupAll = (group: PermGroup, checked: boolean) => {
    const codes = group.permissions.map((p) => p.code)
    setForm((prev) => {
      if (checked) {
        const next = [...prev.permissions]
        codes.forEach((code) => {
          if (!next.includes(code)) next.push(code)
        })
        return { ...prev, permissions: next }
      } else {
        return { ...prev, permissions: prev.permissions.filter((p) => !codes.includes(p)) }
      }
    })
  }

  const togglePerm = (code: string, checked: boolean) => {
    setForm((prev) => {
      if (checked) {
        if (prev.permissions.includes(code)) return prev
        return { ...prev, permissions: [...prev.permissions, code] }
      }
      return { ...prev, permissions: prev.permissions.filter((p) => p !== code) }
    })
  }

  // 加载角色列表
  const loadRoles = async () => {
    setLoading(true)
    try {
      const res: any = await getRolesReq({
        filter_type: filterType || undefined,
        search: searchKeyword || undefined
      })
      setRoleList(res.data || [])
    } catch (err) {
      console.error('加载角色列表失败:', err)
      notifications.show({ color: 'red', message: t('admin.roles.loadFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 初始化加载
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    loadRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听过滤条件变化（对齐原 watch [filterType, searchKeyword]，immediate:false）
  useEffect(() => {
    if (!mountedRef.current) return
    loadRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterType, searchKeyword])

  const handleCreate = () => {
    setIsEdit(false)
    setEditingRoleId(null)
    setForm({ name: '', code: '', description: '', permissions: [] })
    setErrors({})
    setDialogVisible(true)
  }

  const handleEdit = (row: RoleRow) => {
    setIsEdit(true)
    setEditingRoleId(row.id)
    setForm({
      name: row.name,
      code: row.code,
      description: row.description,
      permissions: [...(row.permissions || [])]
    })
    setErrors({})
    setDialogVisible(true)
  }

  const handleDelete = (row: RoleRow) => {
    modals.openConfirmModal({
      title: t('admin.roles.deleteConfirmTitle'),
      children: t('admin.roles.deleteConfirmMsg', { name: row.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteRoleReq(row.id)
          notifications.show({ color: 'green', message: t('admin.roles.deleteSuccess') })
          await loadRoles()
        } catch (err: any) {
          console.error('删除角色失败:', err)
          notifications.show({ color: 'red', message: err?.msg || t('admin.roles.deleteFailed') })
        }
      }
    })
  }

  // 表单校验（对齐原 el-form rules）
  const validateForm = () => {
    const next: { name?: string; code?: string } = {}
    if (!form.name) {
      next.name = t('admin.roles.rules.nameRequired')
    }
    if (!form.code) {
      next.code = t('admin.roles.rules.codeRequired')
    } else if (!/^[a-z_]+$/.test(form.code)) {
      next.code = t('admin.roles.rules.codeFormat')
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = async () => {
    if (!validateForm()) return
    setSubmitting(true)

    try {
      if (isEdit) {
        // 更新角色
        const updateData = {
          name: form.name,
          description: form.description,
          permissions: form.permissions
        }
        await updateRoleReq(editingRoleId, updateData)
        notifications.show({ color: 'green', message: t('admin.roles.editSuccess') })
      } else {
        // 创建角色
        await createRoleReq({
          name: form.name,
          code: form.code,
          description: form.description,
          permissions: form.permissions
        })
        notifications.show({ color: 'green', message: t('admin.roles.createSuccess') })
      }
      setDialogVisible(false)
      await loadRoles()
    } catch (err: any) {
      console.error('保存角色失败:', err)
      notifications.show({ color: 'red', message: err?.msg || t('admin.roles.saveFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles['role-management']}>
      {/* 页面头部 */}
      <div className={styles['page-header']}>
        <div className={styles['header-left']}>
          <h1>{t('admin.roles.title')}</h1>
          <p>{t('admin.roles.subtitle')}</p>
        </div>
        <div className={styles['header-right']}>
          <Button color="yiw" leftSection={<IconPlus size={16} />} onClick={handleCreate}>
            {t('admin.roles.create')}
          </Button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className={styles['content-wrapper']}>
        <div className={styles.panel}>
          <div className={styles.toolbar}>
            <TextInput
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.currentTarget.value)}
              placeholder={t('admin.roles.searchPlaceholder')}
              style={{ width: 280 }}
              leftSection={<IconSearch size={16} />}
            />
            <Select
              value={filterType || null}
              onChange={(v) => setFilterType(v || '')}
              placeholder={t('admin.roles.filterType')}
              clearable
              style={{ width: 140 }}
              data={[
                { value: 'system', label: t('admin.roles.systemRole') },
                { value: 'custom', label: t('admin.roles.customRole') }
              ]}
            />
          </div>

          {/* 桌面端表格 */}
          <div className={styles['table-view']} style={{ position: 'relative' }}>
            <LoadingOverlay visible={loading} />
            <div className={styles['table-container']}>
              <table>
                <thead>
                  <tr>
                    <th style={{ minWidth: 280 }}>{t('admin.roles.role')}</th>
                    <th style={{ width: 120, textAlign: 'center' }}>{t('admin.roles.type')}</th>
                    <th style={{ minWidth: 200 }}>{t('admin.roles.permissions')}</th>
                    <th style={{ width: 180 }}>{t('admin.roles.createdAt')}</th>
                    <th style={{ width: 180 }}>{t('admin.roles.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoleList.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className={styles['role-cell']}>
                          <div className={`${styles['role-icon']} ${row.is_system ? styles.system : styles.custom}`}>
                            <IconUserFilled size={18} />
                          </div>
                          <div className={styles['role-info']}>
                            <div className={styles['role-name']}>
                              {row.name}
                              <span className={styles['role-code']}>{row.code}</span>
                            </div>
                            <div className={styles['role-desc']}>{row.description}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={`${styles['type-badge']} ${row.is_system ? styles.system : styles.custom}`}>
                          {row.is_system ? t('admin.roles.systemRole') : t('admin.roles.custom')}
                        </span>
                      </td>
                      <td>
                        <div className={styles['permission-preview']}>
                          {getDisplayPermissions(row).map((perm) => (
                            <span key={perm} className={styles['perm-tag']}>
                              {perm}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={styles['time-text']}>{formatDate(row.created_at)}</span>
                      </td>
                      <td>
                        <button
                          className={`${styles['action-btn']} ${styles.primary}`}
                          onClick={() => handleEdit(row)}
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          className={`${styles['action-btn']} ${styles.danger}`}
                          disabled={row.is_system}
                          onClick={() => handleDelete(row)}
                        >
                          {t('common.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 移动端卡片 */}
          <div className={styles['card-view']}>
            <div className={styles['mobile-card-list']} style={{ position: 'relative' }}>
              <LoadingOverlay visible={loading} />
              {filteredRoleList.map((row) => (
                <div className={styles['mobile-card']} key={row.id}>
                  <div className={styles['card-header']}>
                    <span className={styles['card-title']}>{row.name}</span>
                    <span className={`${styles['type-badge']} ${row.is_system ? styles.system : styles.custom}`}>
                      {row.is_system ? t('admin.roles.systemRole') : t('admin.roles.custom')}
                    </span>
                  </div>
                  <div className={styles['card-body']}>
                    <div className={`${styles['card-field']} ${styles['card-field--perms']}`}>
                      <span className={styles['field-label']}>{t('admin.roles.permissions')}</span>
                      <div className={`${styles['field-value']} ${styles['permission-preview']}`}>
                        {getDisplayPermissions(row).map((perm) => (
                          <span key={perm} className={styles['perm-tag']}>
                            {perm}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className={styles['card-field']}>
                      <span className={styles['field-label']}>{t('admin.roles.createdAt')}</span>
                      <span className={styles['field-value']}>{formatDate(row.created_at)}</span>
                    </div>
                  </div>
                  <div className={styles['card-footer']}>
                    <button
                      className={`${styles['action-btn']} ${styles.primary}`}
                      onClick={() => handleEdit(row)}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      className={`${styles['action-btn']} ${styles.danger}`}
                      disabled={row.is_system}
                      onClick={() => handleDelete(row)}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 角色编辑对话框 */}
      <Modal
        opened={dialogVisible}
        onClose={() => setDialogVisible(false)}
        title={isEdit ? t('admin.roles.editRole') : t('admin.roles.create')}
        size={640}
        closeOnClickOutside={false}
      >
        <div className={styles['role-form']}>
          <div className={styles['form-row']}>
            <div className={styles['form-item-half']}>
              <TextInput
                label={t('admin.roles.roleName')}
                placeholder={t('admin.roles.roleNamePlaceholder')}
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.currentTarget.value }))}
                error={errors.name}
                withAsterisk
              />
            </div>
            <div className={styles['form-item-half']}>
              <TextInput
                label={t('admin.roles.roleCode')}
                placeholder={t('admin.roles.roleCodePlaceholder')}
                value={form.code}
                onChange={(e) => setForm((prev) => ({ ...prev, code: e.currentTarget.value }))}
                disabled={isEdit}
                error={errors.code}
                withAsterisk
              />
            </div>
          </div>
          <Textarea
            label={t('admin.roles.roleDesc')}
            placeholder={t('admin.roles.roleDescPlaceholder')}
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.currentTarget.value }))}
            autosize
            minRows={2}
            mt="md"
          />
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 500, color: '#1e293b', marginBottom: 8, fontSize: 14 }}>
              {t('admin.roles.permissionConfig')}
            </div>
            <div className={styles['permission-config']}>
              {permissionGroups.map((group) => (
                <div className={styles['permission-group']} key={group.name}>
                  <div className={styles['group-header']}>
                    <span className={styles['group-title']}>{group.name}</span>
                    <Checkbox
                      indeterminate={isGroupIndeterminate(group)}
                      checked={isGroupAllChecked(group)}
                      onChange={(e) => toggleGroupAll(group, e.currentTarget.checked)}
                      label={t('common.selectAll')}
                      size="xs"
                    />
                  </div>
                  <div className={styles['group-items']}>
                    {group.permissions.map((perm) => (
                      <Checkbox
                        key={perm.code}
                        checked={form.permissions.includes(perm.code)}
                        onChange={(e) => togglePerm(perm.code, e.currentTarget.checked)}
                        label={perm.name}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <Button variant="default" onClick={() => setDialogVisible(false)}>
            {t('common.cancel')}
          </Button>
          <Button color="yiw" loading={submitting} onClick={handleSubmit}>
            {t('common.confirm')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

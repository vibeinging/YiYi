// 用户管理（源：views/admin/UserManagement.vue）
// el-tabs → ScrollableTabs(已转) + Tabs.List/Tab/Panel；el-table → Mantine Table 手动 map；
// el-dialog → Modal；ElMessage → notifications.show；ElMessageBox → modals.openConfirmModal。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Avatar,
  Button,
  Divider,
  LoadingOverlay,
  Modal,
  NumberInput,
  Pagination,
  Radio,
  Select,
  Switch,
  Table,
  Tabs,
  TextInput,
} from '@mantine/core'
import { DateTimePicker } from '@mantine/dates'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { IconSearch, IconLink, IconCopy } from '@tabler/icons-react'
import ScrollableTabs from '@/components/ScrollableTabs'
import SystemRoleSelect from '@/components/SystemRoleSelect'
import { copyToClipboard } from '@/utils/clipboard'
import { useBasicStore } from '@/store/basic'
import {
  getUserListReq,
  updateUserPermissionsReq,
  updateUserStatusReq,
  createInviteLinkReq,
  getInviteLinksReq,
  revokeInviteLinkReq,
  restoreInviteLinkReq,
  deleteInviteLinkReq,
} from '@/api/user'
import styles from './UserManagement.module.scss'

export default function UserManagement() {
  const { t } = useTranslation()

  // 获取当前用户信息（computed → 派生 selector）
  const userInfo = useBasicStore((s) => s.userInfo)
  const currentUserId = userInfo?.userId || ''

  // Tab 状态
  const [activeTab, setActiveTab] = useState('users')

  // 用户列表
  const [userList, setUserList] = useState<any[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [filterRole, setFilterRole] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  // pagination(reactive) → useState 对象
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0 })

  // 邀请注册链接
  const [inviteLinks, setInviteLinks] = useState<any[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [invitePagination, setInvitePagination] = useState({ page: 1, pageSize: 10, total: 0 })

  // 编辑权限对话框
  const [showPermissionDialog, setShowPermissionDialog] = useState(false)
  const [editingUser, setEditingUser] = useState<any>(null)
  const [permissionForm, setPermissionForm] = useState({
    is_admin: false,
    can_create_project: false,
  })
  const [saving, setSaving] = useState(false)

  // 邀请注册链接对话框
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [inviteForm, setInviteForm] = useState<{
    permission_type: 'invited' | 'creator' | 'admin'
    max_uses: number | null
    expires_at: any
  }>({
    permission_type: 'invited', // invited | creator | admin
    max_uses: null,
    expires_at: null,
  })
  const [generating, setGenerating] = useState(false)
  const [generatedLink, setGeneratedLink] = useState('')

  // 加载用户列表
  const loadUsers = async (overridePage?: number) => {
    setUsersLoading(true)
    try {
      const page = overridePage ?? pagination.page
      const params: any = {
        page,
        page_size: pagination.pageSize,
      }
      if (searchKeyword) {
        params.keyword = searchKeyword
      }
      if (filterRole) {
        params.role = filterRole
      }
      if (filterStatus) {
        params.status = filterStatus
      }
      const res = await getUserListReq(params)
      setUserList(res.data?.items || res.data || [])
      setPagination((p) => ({ ...p, total: res.data?.total || 0 }))
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || t('admin.users.loadUsersFailed') })
    } finally {
      setUsersLoading(false)
    }
  }

  // 搜索处理
  const handleSearch = () => {
    setPagination((p) => ({ ...p, page: 1 }))
    loadUsers(1)
  }

  // 分页变化
  const handlePageChange = (page: number) => {
    setPagination((p) => ({ ...p, page }))
    loadUsers(page)
  }

  // 加载邀请注册链接
  const loadInviteLinks = async (overridePage?: number) => {
    setInvitesLoading(true)
    try {
      const page = overridePage ?? invitePagination.page
      const res = await getInviteLinksReq({
        page,
        per_page: invitePagination.pageSize,
      })
      setInviteLinks(res.data?.items || res.data || [])
      setInvitePagination((p) => ({ ...p, total: res.data?.total || 0 }))
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || t('admin.users.loadInvitesFailed') })
    } finally {
      setInvitesLoading(false)
    }
  }

  // 邀请链接分页变化
  const handleInvitePageChange = (page: number) => {
    setInvitePagination((p) => ({ ...p, page }))
    loadInviteLinks(page)
  }

  // 编辑用户权限
  const editUserPermissions = (user: any) => {
    setEditingUser(user)
    setPermissionForm({
      is_admin: user.is_admin || false,
      can_create_project: user.can_create_project || false,
    })
    setShowPermissionDialog(true)
  }

  // 保存用户权限
  const saveUserPermissions = async () => {
    setSaving(true)
    try {
      await updateUserPermissionsReq(editingUser.id, {
        is_admin: permissionForm.is_admin,
        can_create_project: permissionForm.is_admin || permissionForm.can_create_project,
      })
      notifications.show({ color: 'green', message: t('admin.users.permissionsSaved') })
      setShowPermissionDialog(false)
      loadUsers()
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || t('admin.users.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  // 切换用户状态
  const toggleUserStatus = async (user: any) => {
    // 检查是否是自己
    if (user.id === currentUserId) {
      notifications.show({ color: 'yellow', message: t('admin.users.cannotDisableSelf') })
      return
    }

    const action = user.is_active ? t('admin.users.disable') : t('admin.users.enable')
    const newStatus = !user.is_active
    // ElMessageBox.confirm → modals.openConfirmModal（确认逻辑搬到 onConfirm）
    modals.openConfirmModal({
      title: t('admin.users.toggleStatusTitle', { action }),
      children: t('admin.users.toggleStatusConfirm', { action, name: user.username }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'yellow' },
      onConfirm: async () => {
        try {
          await updateUserStatusReq(user.id, newStatus)
          notifications.show({ color: 'green', message: t('admin.users.toggleStatusSuccess', { action }) })
          loadUsers()
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.msg || t('admin.users.toggleStatusFailed', { action }) })
        }
      },
    })
  }

  // 生成邀请注册链接
  const generateInviteLink = async () => {
    setGenerating(true)
    try {
      const res = await createInviteLinkReq({
        grant_admin: inviteForm.permission_type === 'admin',
        grant_create_project:
          inviteForm.permission_type === 'creator' || inviteForm.permission_type === 'admin',
        max_uses: inviteForm.max_uses || null,
        expires_at: inviteForm.expires_at || null, // 直接传日期，null 表示永不过期
      })

      const baseUrl = window.location.origin
      setGeneratedLink(`${baseUrl}/login?invite=${res.data.code}`)

      notifications.show({ color: 'green', message: t('admin.users.generateSuccess') })
      loadInviteLinks()
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || t('admin.users.generateFailed') })
    } finally {
      setGenerating(false)
    }
  }

  // 获取邀请链接URL（完整）
  const getInviteLinkUrl = (code: any) => {
    return `${window.location.origin}/login?invite=${code}`
  }

  // 获取邀请链接URL（短格式）
  const getInviteLinkShort = (code: any) => {
    // 从 host 中提取最后部分，如 localhost:5155 -> ...5155
    const host = window.location.host
    const parts = host.split('.')
    const lastPart = parts[parts.length - 1]
    // 如果是 localhost:端口，提取端口号
    if (lastPart.includes(':')) {
      const port = lastPart.split(':')[1]
      return `...${port}?invite=${code}`
    }
    // 如果是域名，取前几个字符 + ...
    return `...${lastPart.slice(0, 4)}?invite=${code}`
  }

  // 复制邀请链接
  const copyInviteLink = async (link: any) => {
    const fullUrl = getInviteLinkUrl(link.code)
    const success = await copyToClipboard(fullUrl)
    if (success) {
      notifications.show({ color: 'green', message: t('admin.users.linkCopied') })
    } else {
      notifications.show({ color: 'red', message: t('admin.users.copyFailed') })
    }
  }

  // 复制生成的链接
  const copyGeneratedLink = async () => {
    const success = await copyToClipboard(generatedLink)
    if (success) {
      notifications.show({ color: 'green', message: t('admin.users.linkCopied') })
    } else {
      notifications.show({ color: 'red', message: t('admin.users.copyFailed') })
    }
  }

  // 撤销邀请链接
  const revokeInviteLink = async (link: any) => {
    modals.openConfirmModal({
      title: t('admin.users.revokeConfirmTitle'),
      children: t('admin.users.revokeConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'yellow' },
      onConfirm: async () => {
        try {
          await revokeInviteLinkReq(link.id)
          notifications.show({ color: 'green', message: t('admin.users.revokeSuccess') })
          loadInviteLinks()
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.msg || t('admin.users.revokeFailed') })
        }
      },
    })
  }

  // 恢复邀请链接
  const restoreInviteLink = async (link: any) => {
    modals.openConfirmModal({
      title: t('admin.users.restoreConfirmTitle'),
      children: t('admin.users.restoreConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      onConfirm: async () => {
        try {
          await restoreInviteLinkReq(link.id)
          notifications.show({ color: 'green', message: t('admin.users.restoreSuccess') })
          loadInviteLinks()
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.msg || t('admin.users.restoreFailed') })
        }
      },
    })
  }

  // 删除邀请链接
  const deleteInviteLink = async (link: any) => {
    modals.openConfirmModal({
      title: t('admin.users.deleteConfirmTitle'),
      children: t('admin.users.deleteConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteInviteLinkReq(link.id)
          notifications.show({ color: 'green', message: t('admin.users.deleteSuccess') })
          // 如果当前页只有一条数据且不是第一页，则回到上一页
          let nextPage = invitePagination.page
          if (inviteLinks.length === 1 && invitePagination.page > 1) {
            nextPage = invitePagination.page - 1
            setInvitePagination((p) => ({ ...p, page: nextPage }))
          }
          loadInviteLinks(nextPage)
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.msg || t('admin.users.deleteFailed') })
        }
      },
    })
  }

  // 格式化日期
  const formatDate = (dateStr: any) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // 检查是否过期
  const isExpired = (dateStr: any) => {
    if (!dateStr) return false
    return new Date(dateStr) < new Date()
  }

  // 邀请注册链接状态（后端已返回 status 字段）
  const getInviteComputedStatus = (row: any) => {
    if (!row) return 'unknown'
    return row.status || 'unknown'
  }

  const getInviteStatusText = (status: any) => {
    const texts: Record<string, string> = {
      active: t('admin.users.inviteStatusActive'),
      revoked: t('admin.users.inviteStatusRevoked'),
      expired: t('admin.users.inviteStatusExpired'),
      exhausted: t('admin.users.inviteStatusExhausted'),
    }
    return texts[status] || t('admin.users.inviteStatusUnknown')
  }

  // 监听 Tab 切换（watch activeTab）
  useEffect(() => {
    if (activeTab === 'invites' && inviteLinks.length === 0) {
      loadInviteLinks()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // 监听邀请对话框打开（watch showInviteDialog）
  useEffect(() => {
    if (showInviteDialog) {
      setInviteForm({ permission_type: 'invited', max_uses: null, expires_at: null })
      setGeneratedLink('')
    }
  }, [showInviteDialog])

  // onMounted
  useEffect(() => {
    loadUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 权限标签（共享于桌面端/移动端）
  const renderUserPermTags = (row: any) => (
    <div className={styles.permissionTags}>
      {row.is_admin && (
        <span className={`${styles.permTag} ${styles.admin}`}>{t('admin.users.roleAdmin')}</span>
      )}
      {row.can_create_project && (
        <span className={`${styles.permTag} ${styles.creator}`}>{t('admin.users.roleCreator')}</span>
      )}
      {!row.is_admin && !row.can_create_project && (
        <span className={`${styles.permTag} ${styles.guest}`}>{t('admin.users.roleGuest')}</span>
      )}
    </div>
  )

  const renderInvitePermTags = (row: any) => (
    <div className={styles.permissionTags}>
      {row.grant_admin ? (
        <span className={`${styles.permTag} ${styles.admin}`}>{t('admin.users.roleAdmin')}</span>
      ) : row.can_create_project ? (
        <span className={`${styles.permTag} ${styles.creator}`}>{t('admin.users.roleCreator')}</span>
      ) : (
        <span className={`${styles.permTag} ${styles.guest}`}>{t('admin.users.roleGuest')}</span>
      )}
    </div>
  )

  const statusBadge = (active: boolean, text: string) => (
    <span className={`${styles.statusBadge} ${active ? styles.active : styles.disabled}`}>{text}</span>
  )

  // 用户列表表格 panel
  const usersPanel = (
    <div className={styles.tabPanel}>
      <div className={styles.toolbar}>
        <TextInput
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.currentTarget.value)}
          placeholder={t('admin.users.searchPlaceholder')}
          style={{ width: 280 }}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          rightSection={
            <IconSearch size={16} className={styles.searchIcon} onClick={handleSearch} />
          }
        />
        <SystemRoleSelect
          modelValue={filterRole}
          placeholder={t('admin.users.filterRole')}
          clearable
          onChange={(v) => {
            setFilterRole(v)
            // change 后立即搜索（对齐源 @change="handleSearch"）
            setPagination((p) => ({ ...p, page: 1 }))
            loadUsersWith({ role: v, page: 1 })
          }}
        />
        <Select
          value={filterStatus || null}
          onChange={(v) => {
            const next = v || ''
            setFilterStatus(next)
            setPagination((p) => ({ ...p, page: 1 }))
            loadUsersWith({ status: next, page: 1 })
          }}
          placeholder={t('admin.users.filterStatus')}
          clearable
          style={{ width: 120 }}
          data={[
            { value: 'active', label: t('admin.users.statusActive') },
            { value: 'disabled', label: t('admin.users.statusDisabled') },
          ]}
        />
      </div>
      <div
        className={`${styles.tableContainer} ${
          pagination.total > pagination.pageSize ? styles.hasPagination : ''
        }`}
      >
        {/* 桌面端表格视图 */}
        <div className={styles.tableView} style={{ position: 'relative' }}>
          <LoadingOverlay visible={usersLoading} />
          <Table className={styles.dataTable}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ minWidth: 200 }}>{t('admin.users.user')}</Table.Th>
                <Table.Th style={{ width: 120 }}>{t('admin.users.systemRole')}</Table.Th>
                <Table.Th style={{ width: 100, textAlign: 'center' }}>{t('admin.users.status')}</Table.Th>
                <Table.Th style={{ width: 180 }}>{t('admin.users.registeredAt')}</Table.Th>
                <Table.Th style={{ width: 210 }}>{t('admin.users.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {userList.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <div className={styles.userCell}>
                      <div className={styles.userName}>{row.username}</div>
                      <div className={styles.userEmail}>{row.email}</div>
                    </div>
                  </Table.Td>
                  <Table.Td>{renderUserPermTags(row)}</Table.Td>
                  <Table.Td style={{ textAlign: 'center' }}>
                    {statusBadge(
                      row.is_active,
                      row.is_active ? t('admin.users.statusActive') : t('admin.users.statusDisabled')
                    )}
                  </Table.Td>
                  <Table.Td>
                    <span className={styles.timeText}>{formatDate(row.created_at)}</span>
                  </Table.Td>
                  <Table.Td>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.primary}`}
                      onClick={() => editUserPermissions(row)}
                    >
                      {t('admin.users.roleSettings')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${row.is_active ? styles.danger : styles.success}`}
                      disabled={row.id === currentUserId}
                      onClick={() => toggleUserStatus(row)}
                    >
                      {row.is_active ? t('admin.users.disable') : t('admin.users.enable')}
                    </button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {/* 移动端卡片视图 */}
        <div className={styles.cardView} style={{ position: 'relative' }}>
          <LoadingOverlay visible={usersLoading} />
          <div className={styles.mobileCardList}>
            {userList.map((row) => (
              <div className={styles.mobileCard} key={row.id}>
                <div className={styles.cardHeader}>
                  <span className={styles.cardTitle}>{row.username}</span>
                  {statusBadge(
                    row.is_active,
                    row.is_active ? t('admin.users.statusActive') : t('admin.users.statusDisabled')
                  )}
                </div>
                <div className={styles.cardSubtitle}>{row.email}</div>
                <div className={styles.cardBody}>
                  <div className={styles.cardField}>
                    <span className={styles.fieldLabel}>{t('admin.users.systemRole')}</span>
                    <span className={styles.fieldValue}>{renderUserPermTags(row)}</span>
                  </div>
                  <div className={styles.cardField}>
                    <span className={styles.fieldLabel}>{t('admin.users.registeredAt')}</span>
                    <span className={styles.fieldValue}>{formatDate(row.created_at)}</span>
                  </div>
                </div>
                <div className={styles.cardFooter}>
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${styles.primary}`}
                    onClick={() => editUserPermissions(row)}
                  >
                    {t('admin.users.roleSettings')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${row.is_active ? styles.danger : styles.success}`}
                    disabled={row.id === currentUserId}
                    onClick={() => toggleUserStatus(row)}
                  >
                    {row.is_active ? t('admin.users.disable') : t('admin.users.enable')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* 分页 */}
        {pagination.total > pagination.pageSize && (
          <div className={styles.paginationWrapper}>
            <Pagination
              value={pagination.page}
              total={Math.ceil(pagination.total / pagination.pageSize)}
              onChange={handlePageChange}
            />
          </div>
        )}
      </div>
    </div>
  )

  // 邀请链接 panel
  const invitesPanel = (
    <div className={styles.tabPanel}>
      <div
        className={`${styles.tableContainer} ${
          invitePagination.total > invitePagination.pageSize ? styles.hasPagination : ''
        }`}
      >
        {/* 桌面端表格视图 */}
        <div className={styles.tableView} style={{ position: 'relative' }}>
          <LoadingOverlay visible={invitesLoading} />
          <Table className={styles.dataTable}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ minWidth: 280 }}>{t('admin.users.inviteLink')}</Table.Th>
                <Table.Th style={{ width: 120 }}>{t('admin.users.permissionConfig')}</Table.Th>
                <Table.Th style={{ width: 100, textAlign: 'center' }}>{t('admin.users.usage')}</Table.Th>
                <Table.Th style={{ width: 160 }}>{t('admin.users.expiresAt')}</Table.Th>
                <Table.Th style={{ width: 120, textAlign: 'center' }}>{t('admin.users.status')}</Table.Th>
                <Table.Th style={{ width: 100 }}>{t('admin.users.createdBy')}</Table.Th>
                <Table.Th style={{ width: 280 }}>{t('admin.users.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {inviteLinks.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <div className={styles.linkCell}>
                      <span className={styles.inviteLink}>...{getInviteLinkShort(row.code)}</span>
                    </div>
                  </Table.Td>
                  <Table.Td>{renderInvitePermTags(row)}</Table.Td>
                  <Table.Td style={{ textAlign: 'center' }}>
                    <span className={styles.usageText}>
                      {row.used_count} / {row.max_uses || '∞'}
                    </span>
                  </Table.Td>
                  <Table.Td>
                    <span
                      className={`${styles.timeText} ${isExpired(row.expires_at) ? styles.expired : ''}`}
                    >
                      {row.expires_at ? formatDate(row.expires_at) : t('admin.users.neverExpires')}
                    </span>
                  </Table.Td>
                  <Table.Td style={{ textAlign: 'center' }}>
                    {statusBadge(
                      getInviteComputedStatus(row) === 'active',
                      getInviteStatusText(getInviteComputedStatus(row))
                    )}
                  </Table.Td>
                  <Table.Td>
                    <span>{row.created_by_name || row.created_by}</span>
                  </Table.Td>
                  <Table.Td>
                    {/* 使用原生 button 解决 el-button 在 el-tab-pane 中的点击事件问题 */}
                    {getInviteComputedStatus(row) === 'active' ? (
                      <>
                        <button
                          className={`${styles.actionBtn} ${styles.primary}`}
                          type="button"
                          onClick={() => copyInviteLink(row)}
                        >
                          {t('common.copy')}
                        </button>
                        <button
                          className={`${styles.actionBtn} ${styles.danger}`}
                          type="button"
                          onClick={() => revokeInviteLink(row)}
                        >
                          {t('admin.users.revoke')}
                        </button>
                      </>
                    ) : (
                      <>
                        {getInviteComputedStatus(row) === 'revoked' && (
                          <button
                            className={`${styles.actionBtn} ${styles.success}`}
                            type="button"
                            onClick={() => restoreInviteLink(row)}
                          >
                            {t('admin.users.restore')}
                          </button>
                        )}
                        <button
                          className={`${styles.actionBtn} ${styles.danger}`}
                          type="button"
                          onClick={() => deleteInviteLink(row)}
                        >
                          {t('common.delete')}
                        </button>
                      </>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {/* 移动端卡片视图 */}
        <div className={styles.cardView} style={{ position: 'relative' }}>
          <LoadingOverlay visible={invitesLoading} />
          <div className={styles.mobileCardList}>
            {inviteLinks.map((row) => (
              <div className={styles.mobileCard} key={row.id}>
                <div className={styles.cardHeader}>
                  <span className={styles.cardTitle}>
                    <span className={styles.inviteLink}>...{getInviteLinkShort(row.code)}</span>
                  </span>
                  {statusBadge(
                    getInviteComputedStatus(row) === 'active',
                    getInviteStatusText(getInviteComputedStatus(row))
                  )}
                </div>
                <div className={styles.cardSubtitle}>
                  {t('admin.users.createdBy')}: {row.created_by_name || row.created_by}
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.cardField}>
                    <span className={styles.fieldLabel}>{t('admin.users.permissionConfig')}</span>
                    <span className={styles.fieldValue}>{renderInvitePermTags(row)}</span>
                  </div>
                  <div className={styles.cardField}>
                    <span className={styles.fieldLabel}>{t('admin.users.usage')}</span>
                    <span className={`${styles.fieldValue} ${styles.usageText}`}>
                      {row.used_count} / {row.max_uses || '∞'}
                    </span>
                  </div>
                  <div className={styles.cardField}>
                    <span className={styles.fieldLabel}>{t('admin.users.expiresAt')}</span>
                    <span
                      className={`${styles.fieldValue} ${styles.timeText} ${
                        isExpired(row.expires_at) ? styles.expired : ''
                      }`}
                    >
                      {row.expires_at ? formatDate(row.expires_at) : t('admin.users.neverExpires')}
                    </span>
                  </div>
                </div>
                <div className={styles.cardFooter}>
                  {getInviteComputedStatus(row) === 'active' ? (
                    <>
                      <button
                        className={`${styles.actionBtn} ${styles.primary}`}
                        type="button"
                        onClick={() => copyInviteLink(row)}
                      >
                        {t('common.copy')}
                      </button>
                      <button
                        className={`${styles.actionBtn} ${styles.danger}`}
                        type="button"
                        onClick={() => revokeInviteLink(row)}
                      >
                        {t('admin.users.revoke')}
                      </button>
                    </>
                  ) : (
                    <>
                      {getInviteComputedStatus(row) === 'revoked' && (
                        <button
                          className={`${styles.actionBtn} ${styles.success}`}
                          type="button"
                          onClick={() => restoreInviteLink(row)}
                        >
                          {t('admin.users.restore')}
                        </button>
                      )}
                      <button
                        className={`${styles.actionBtn} ${styles.danger}`}
                        type="button"
                        onClick={() => deleteInviteLink(row)}
                      >
                        {t('common.delete')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* 分页 */}
        {invitePagination.total > invitePagination.pageSize && (
          <div className={styles.paginationWrapper}>
            <Pagination
              value={invitePagination.page}
              total={Math.ceil(invitePagination.total / invitePagination.pageSize)}
              onChange={handleInvitePageChange}
            />
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className={styles.userManagement}>
      {/* 页面头部 */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <h1>{t('admin.users.title')}</h1>
          <p>{t('admin.users.subtitle')}</p>
        </div>
        <div className={styles.headerRight}>
          <Button leftSection={<IconLink size={16} />} onClick={() => setShowInviteDialog(true)}>
            {t('admin.users.createInviteLink')}
          </Button>
        </div>
      </div>

      {/* Tab 切换 + 内容区域 */}
      <div className={styles.contentWrapper}>
        <ScrollableTabs
          modelValue={activeTab}
          type="card"
          tabsClass="admin-tabs"
          onUpdateModelValue={(v) => setActiveTab(v)}
        >
          <Tabs.List>
            <Tabs.Tab value="users">{t('admin.users.userList')}</Tabs.Tab>
            <Tabs.Tab value="invites">{t('admin.users.inviteLinks')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="users">{usersPanel}</Tabs.Panel>
          <Tabs.Panel value="invites">{invitesPanel}</Tabs.Panel>
        </ScrollableTabs>
      </div>

      {/* 编辑用户权限对话框 */}
      <Modal
        opened={showPermissionDialog}
        onClose={() => setShowPermissionDialog(false)}
        title={t('admin.users.setSystemRole')}
        size={500}
        closeOnClickOutside={false}
      >
        {editingUser && (
          <div className={styles.permissionForm}>
            <div className={styles.userInfoHeader}>
              <Avatar size={48} className={styles.userAvatar}>
                {editingUser.username?.charAt(0)?.toUpperCase()}
              </Avatar>
              <div className={styles.userDetails}>
                <h3>{editingUser.username}</h3>
                <p>{editingUser.email}</p>
              </div>
            </div>

            <Divider my="md" />

            <div>
              <div className={styles.formItem}>
                <div className={styles.formLabel}>{t('admin.users.roleAdmin')}</div>
                <Switch
                  checked={permissionForm.is_admin}
                  onChange={(e) =>
                    setPermissionForm((f) => ({ ...f, is_admin: e.currentTarget.checked }))
                  }
                />
                <p className={styles.formTip}>{t('admin.users.adminTip')}</p>
              </div>
              <div className={styles.formItem}>
                <div className={styles.formLabel}>{t('admin.users.roleCreator')}</div>
                <Switch
                  checked={permissionForm.can_create_project}
                  disabled={permissionForm.is_admin}
                  onChange={(e) =>
                    setPermissionForm((f) => ({ ...f, can_create_project: e.currentTarget.checked }))
                  }
                />
                <p className={styles.formTip}>{t('admin.users.creatorTip')}</p>
              </div>
            </div>
          </div>
        )}
        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setShowPermissionDialog(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={saving} onClick={saveUserPermissions}>
            {t('common.save')}
          </Button>
        </div>
      </Modal>

      {/* 创建邀请注册链接对话框 */}
      <Modal
        opened={showInviteDialog}
        onClose={() => setShowInviteDialog(false)}
        title={t('admin.users.createInviteLink')}
        size={550}
        closeOnClickOutside={false}
      >
        <div className={styles.inviteForm}>
          <Alert color="blue" title={t('admin.users.inviteAlertTitle')} style={{ marginBottom: 20 }} />

          <div>
            <div className={styles.formItem}>
              <div className={styles.formLabel}>{t('admin.users.postRegPermission')}</div>
              <Radio.Group
                value={inviteForm.permission_type}
                onChange={(v) =>
                  setInviteForm((f) => ({ ...f, permission_type: v as 'invited' | 'creator' | 'admin' }))
                }
              >
                <div style={{ display: 'flex', gap: 24 }}>
                  <Radio value="invited" label={t('admin.users.permGuest')} />
                  <Radio value="creator" label={t('admin.users.roleCreator')} />
                  <Radio value="admin" label={t('admin.users.roleAdmin')} />
                </div>
              </Radio.Group>
            </div>

            <div className={styles.formItem}>
              <div className={styles.formLabel}>{t('admin.users.maxUsesLabel')}</div>
              <NumberInput
                value={inviteForm.max_uses ?? ''}
                onChange={(v) =>
                  setInviteForm((f) => ({
                    ...f,
                    max_uses: v === '' || v === null ? null : Number(v),
                  }))
                }
                min={1}
                max={100}
                placeholder={t('admin.users.noLimit')}
                style={{ width: 200 }}
              />
              <span className={styles.inputSuffix}>{t('admin.users.maxUsesSuffix')}</span>
            </div>

            <div className={styles.formItem}>
              <div className={styles.formLabel}>{t('admin.users.validityPeriod')}</div>
              <DateTimePicker
                value={inviteForm.expires_at}
                onChange={(v) => setInviteForm((f) => ({ ...f, expires_at: v }))}
                placeholder={t('admin.users.selectExpiry')}
                style={{ width: 200 }}
              />
              <span className={styles.inputSuffix}>{t('admin.users.validitySuffix')}</span>
            </div>
          </div>

          {/* 生成的链接 */}
          {generatedLink && (
            <div className={styles.generatedLink}>
              <Alert color="green">
                <div className={styles.linkContent}>
                  <span style={{ marginRight: 20 }}>{t('admin.users.linkGenerated')}</span>
                  <Button size="xs" leftSection={<IconCopy size={14} />} onClick={copyGeneratedLink}>
                    {t('admin.users.copyLink')}
                  </Button>
                </div>
                <div className={styles.linkUrl}>{generatedLink}</div>
              </Alert>
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setShowInviteDialog(false)}>
            {t('common.close')}
          </Button>
          <Button loading={generating} onClick={generateInviteLink}>
            {t('admin.users.generateLink')}
          </Button>
        </div>
      </Modal>
    </div>
  )

  // 过滤器变化时携带最新值立即查询（filterRole/filterStatus 的 setState 异步，故显式传参）
  function loadUsersWith(extra: { role?: string; status?: string; page?: number }) {
    setUsersLoading(true)
    const page = extra.page ?? 1
    const role = extra.role !== undefined ? extra.role : filterRole
    const status = extra.status !== undefined ? extra.status : filterStatus
    const params: any = { page, page_size: pagination.pageSize }
    if (searchKeyword) params.keyword = searchKeyword
    if (role) params.role = role
    if (status) params.status = status
    getUserListReq(params)
      .then((res) => {
        setUserList(res.data?.items || res.data || [])
        setPagination((p) => ({ ...p, total: res.data?.total || 0 }))
      })
      .catch((err: any) => {
        notifications.show({ color: 'red', message: err?.msg || t('admin.users.loadUsersFailed') })
      })
      .finally(() => setUsersLoading(false))
  }
}

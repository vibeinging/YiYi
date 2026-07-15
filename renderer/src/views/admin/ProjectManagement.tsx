// 项目管理（源：views/admin/ProjectManagement.vue）
// el-table → Mantine Table 手动 map；el-dialog → Modal；el-dropdown → Menu；
// el-select(filterable/remote) → Mantine Select(searchable)；ElMessage → notifications.show；
// ElMessageBox → modals.openConfirmModal；el-switch → Switch；el-pagination → Pagination。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Loader,
  LoadingOverlay,
  Menu,
  Modal,
  Pagination,
  Select,
  Switch,
  Table,
  Textarea,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconPlus,
  IconSearch,
  IconChevronDown,
  IconTrash,
  IconFolder,
  IconFolderOpen,
  IconArrowsExchange,
} from '@tabler/icons-react'
import { useBasicStore } from '@/store/basic'
import { useProjectStore } from '@/store/project'
import {
  getAllProjectsReq,
  createProjectReq,
  updateProjectReq,
  deleteProjectReq,
  getProjectMembersReq,
  addProjectMemberReq,
  transferProjectOwnershipReq,
  getRolesReq,
  getProjectDetailReq,
} from '@/api/project'
import { searchUsersReq } from '@/api/user'
// OpenAccessConfig 迁移中可能仍为 stub（无 props 类型），此处按真实契约传 project/onUpdated
import OpenAccessConfigRaw from '@/views/project/settings/components/OpenAccessConfig'
const OpenAccessConfig = OpenAccessConfigRaw as any
import { projectPath } from '@/utils/project-route'
import styles from './ProjectManagement.module.scss'

export default function ProjectManagement() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const setAdminMode = useBasicStore((s) => s.setAdminMode)

  // 数据
  const [loading, setLoading] = useState(false)
  const [projects, setProjects] = useState<any[]>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [totalCount, setTotalCount] = useState(0)

  // 创建对话框
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', description: '' })
  const [createNameError, setCreateNameError] = useState('')

  // 编辑（转移负责人）对话框
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editingProject, setEditingProject] = useState<any>(null)

  // 成员管理
  const [projectMembers, setProjectMembers] = useState<any[]>([])

  // 添加成员对话框
  const [showAddMemberDialogVisible, setShowAddMemberDialogVisible] = useState(false)
  const [addMemberForm, setAddMemberForm] = useState({ user_id: '', role_id: '' })
  const [addingMember, setAddingMember] = useState(false)
  const [searchingUsers, setSearchingUsers] = useState(false)
  const [availableUsers, setAvailableUsers] = useState<any[]>([])

  // 转移负责人
  const [transferForm, setTransferForm] = useState({ new_manager_id: '' })
  const [transferNewManagerError, setTransferNewManagerError] = useState('')
  const [transferring, setTransferring] = useState(false)
  const [transferSearchKeyword, setTransferSearchKeyword] = useState('')

  // 项目角色列表（从API获取）
  const [projectRoles, setProjectRoles] = useState<any[]>([])

  // 可转移的成员列表（排除当前负责人）
  const transferableMembers = useMemo(
    () => projectMembers.filter((m) => !m.is_manager),
    [projectMembers]
  )

  // 过滤后的可转移成员列表
  const filteredTransferMembers = useMemo(() => {
    if (!transferSearchKeyword) {
      return transferableMembers
    }
    const keyword = transferSearchKeyword.toLowerCase()
    return transferableMembers.filter(
      (m) =>
        m.username?.toLowerCase().includes(keyword) || m.email?.toLowerCase().includes(keyword)
    )
  }, [transferableMembers, transferSearchKeyword])

  // 搜索过滤方法
  const filterTransferMembers = (keyword: string) => {
    setTransferSearchKeyword(keyword)
  }

  // 加载角色列表
  const loadRoles = async () => {
    try {
      const res = await getRolesReq()
      setProjectRoles(res.data || [])
    } catch (err) {
      console.error('加载角色列表失败:', err)
    }
  }

  // 过滤后的项目列表（后端已处理筛选，直接返回）
  const filteredProjects = projects

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

  // 获取角色名称
  const getRoleName = (roleId: any) => {
    const role = projectRoles.find((r) => r.id === roleId)
    return role?.name || t('admin.projects.unknownRole')
  }

  // 加载项目列表（page/perPage 可显式传入以规避 setState 异步）
  const loadProjects = async (overridePage?: number, overridePerPage?: number) => {
    setLoading(true)
    try {
      const params: any = {
        page: overridePage ?? currentPage,
        per_page: overridePerPage ?? pageSize,
        search: searchKeyword || undefined,
        status: statusFilter || undefined,
      }
      const res = await getAllProjectsReq(params)
      setProjects(res.data.items || [])
      setTotalCount(res.data.total || 0)
    } catch (err) {
      console.error('加载项目列表失败:', err)
      notifications.show({ color: 'red', message: t('admin.projects.loadFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 加载项目成员
  const loadProjectMembers = async (projectId: any) => {
    try {
      const res = await getProjectMembersReq(projectId)
      const members = res.data.items || []
      // 标记最后一个管理员（项目管理员角色）
      const adminRole = projectRoles.find((r) => r.code === 'project_admin')
      const adminRoleId = adminRole?.id
      const admins = members.filter((m: any) => m.role_id === adminRoleId)
      members.forEach((m: any) => {
        m.is_last_admin = admins.length === 1 && m.role_id === adminRoleId
      })
      setProjectMembers(members)
    } catch (err) {
      console.error('加载项目成员失败:', err)
      notifications.show({ color: 'red', message: t('admin.projects.loadMembersFailed') })
    }
  }

  // 搜索用户
  const searchUsers = async (query: string) => {
    if (!query) {
      setAvailableUsers([])
      return
    }
    setSearchingUsers(true)
    try {
      const res = await searchUsersReq({ keyword: query, per_page: 20 })
      const allUsers = res.data?.items || []
      // 过滤已经是项目成员的用户
      const existingIds = projectMembers.map((m) => m.user_id)
      setAvailableUsers(allUsers.filter((u: any) => !existingIds.includes(u.id)))
    } catch (err) {
      console.error('搜索用户失败:', err)
    } finally {
      setSearchingUsers(false)
    }
  }

  // 每页条数变化：重置到第一页再加载
  const handleSizeChange = (size: number) => {
    setPageSize(size)
    setCurrentPage(1)
    loadProjects(1, size)
  }

  // 页码变化
  const handleCurrentChange = (page: number) => {
    setCurrentPage(page)
    loadProjects(page)
  }

  // 打开创建项目对话框
  const openCreateDialog = () => {
    setCreateForm({ name: '', description: '' })
    setCreateNameError('')
    setShowCreateDialog(true)
  }

  // 校验创建表单
  const validateCreateForm = () => {
    const name = createForm.name
    if (!name) {
      setCreateNameError(t('admin.projects.rules.nameRequired'))
      return false
    }
    if (name.length < 2 || name.length > 100) {
      setCreateNameError(t('admin.projects.rules.nameLength'))
      return false
    }
    setCreateNameError('')
    return true
  }

  // 创建项目
  const handleCreate = async () => {
    if (!validateCreateForm()) return

    setSubmitting(true)
    try {
      const res = await createProjectReq({
        name: createForm.name,
        description: createForm.description,
      })
      const newProject = res.data
      setProjects((prev) => [newProject, ...prev])
      setTotalCount((c) => c + 1)
      notifications.show({ color: 'green', message: t('admin.projects.createSuccess') })
      setShowCreateDialog(false)
    } catch (err: any) {
      console.error('创建失败:', err)
      notifications.show({ color: 'red', message: err?.msg || t('admin.projects.createFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  // 切换到项目（获取完整权限数据后导航）
  const switchToProject = async (project: any, route: string) => {
    try {
      const res = await getProjectDetailReq(project.id)
      setCurrentProject(res.data || project)
    } catch {
      setCurrentProject(project)
    }
    setAdminMode(false)
    navigate(route)
  }

  const enterProject = (project: any) => switchToProject(project, '/')
  const goToProjectSettings = (project: any) =>
    switchToProject(project, `${projectPath('settings', project.id)}#basic`)
  const goToProjectMembers = (project: any) =>
    switchToProject(project, `${projectPath('settings', project.id)}#members`)

  // 打开转移负责人对话框
  const openTransferDialog = (project: any) => {
    setEditingProject(project)
    setTransferForm({ new_manager_id: '' })
    setTransferNewManagerError('')
    setTransferSearchKeyword('')
    setShowEditDialog(true)
    loadProjectMembers(project.id)
  }

  // 更多操作
  const handleMoreAction = (command: string, project: any) => {
    switch (command) {
      case 'transfer':
        openTransferDialog(project)
        break
      case 'archive':
      case 'activate':
        toggleProjectStatus(project)
        break
      case 'delete':
        deleteProject(project)
        break
    }
  }

  // 添加成员
  const handleAddMember = async () => {
    if (!addMemberForm.user_id) {
      notifications.show({ color: 'red', message: t('admin.projects.rules.userRequired') })
      return
    }
    if (!addMemberForm.role_id) {
      notifications.show({ color: 'red', message: t('admin.projects.rules.roleRequired') })
      return
    }

    setAddingMember(true)
    try {
      const res = await addProjectMemberReq(editingProject.id, {
        user_id: addMemberForm.user_id,
        role_id: addMemberForm.role_id,
      })
      const newMember = res.data
      setProjectMembers((prev) => [...prev, newMember])
      setEditingProject((prev: any) =>
        prev ? { ...prev, member_count: (prev.member_count || 0) + 1 } : prev
      )
      notifications.show({ color: 'green', message: t('admin.projects.addMemberSuccess') })
      setShowAddMemberDialogVisible(false)
    } catch (err: any) {
      console.error('添加成员失败:', err)
      notifications.show({ color: 'red', message: err?.msg || t('admin.projects.addMemberFailed') })
    } finally {
      setAddingMember(false)
    }
  }

  // 转移负责人
  const handleTransfer = async () => {
    if (!transferForm.new_manager_id) {
      setTransferNewManagerError(t('admin.projects.rules.managerRequired'))
      return
    }
    setTransferNewManagerError('')

    // ElMessageBox.confirm → modals.openConfirmModal（确认后执行转移）
    modals.openConfirmModal({
      title: t('admin.projects.confirmTransfer'),
      children: t('admin.projects.transferConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'yellow' },
      onConfirm: async () => {
        setTransferring(true)
        try {
          await transferProjectOwnershipReq(editingProject.id, {
            to_user_id: transferForm.new_manager_id,
          })
          // 重新加载项目成员以更新数据
          await loadProjectMembers(editingProject.id)
          // 重新加载项目数据以更新负责人信息
          await loadProjects()
          notifications.show({ color: 'green', message: t('admin.projects.transferSuccess') })
          setTransferForm({ new_manager_id: '' })
          setTransferSearchKeyword('')
        } catch (err: any) {
          notifications.show({
            color: 'red',
            message: err?.msg || t('admin.projects.transferFailed'),
          })
        } finally {
          setTransferring(false)
        }
      },
    })
  }

  // 切换项目状态
  const toggleProjectStatus = async (project: any) => {
    const newStatus = project.status === 'active' ? 'archived' : 'active'
    const actionText =
      newStatus === 'archived' ? t('admin.projects.archive') : t('admin.projects.activate')

    modals.openConfirmModal({
      title: t('admin.projects.toggleStatusTitle', { action: actionText }),
      children: t('admin.projects.toggleStatusConfirm', { action: actionText, name: project.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'yellow' },
      onConfirm: async () => {
        try {
          await updateProjectReq(project.id, { status: newStatus })
          setProjects((prev) =>
            prev.map((p) => (p.id === project.id ? { ...p, status: newStatus } : p))
          )
          notifications.show({
            color: 'green',
            message: t('admin.projects.toggleStatusSuccess', { action: actionText }),
          })
        } catch (err: any) {
          console.error(`${actionText}项目失败:`, err)
          notifications.show({
            color: 'red',
            message: err?.msg || t('admin.projects.toggleStatusFailed', { action: actionText }),
          })
        }
      },
    })
  }

  // 删除项目
  const deleteProject = async (project: any) => {
    modals.openConfirmModal({
      title: t('admin.projects.deleteProject'),
      children: t('admin.projects.deleteConfirmMsg', { name: project.name }),
      labels: { confirm: t('admin.projects.confirmDelete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteProjectReq(project.id)
          setProjects((prev) => {
            const index = prev.findIndex((p) => p.id === project.id)
            if (index > -1) {
              const next = [...prev]
              next.splice(index, 1)
              setTotalCount((c) => c - 1)
              return next
            }
            return prev
          })
          notifications.show({ color: 'green', message: t('admin.projects.deleteSuccess') })
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.msg || t('admin.projects.deleteFailed') })
        }
      },
    })
  }

  // 开放设置
  const [showOpenAccessDialog, setShowOpenAccessDialog] = useState(false)
  const [openAccessProject, setOpenAccessProject] = useState<any>(null)

  const openAccessConfig = (project: any) => {
    setOpenAccessProject(project)
    setShowOpenAccessDialog(true)
  }

  const handleOpenAccessUpdated = (updatedData: any) => {
    if (openAccessProject && updatedData) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === openAccessProject.id ? { ...p, is_open: updatedData.is_open } : p
        )
      )
    }
    setShowOpenAccessDialog(false)
  }

  // 初始化（onMounted）
  useEffect(() => {
    loadRoles()
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听筛选条件变化，重新加载（watch [statusFilter, searchKeyword]）
  useEffect(() => {
    setCurrentPage(1) // 重置到第一页
    loadProjects(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, searchKeyword])

  // 状态徽章
  const statusBadge = (status: string) => (
    <span className={`${styles.statusBadge} ${styles[status] || ''}`}>
      {status === 'active' ? t('admin.projects.statusActive') : t('admin.projects.statusArchived')}
    </span>
  )

  // 更多操作下拉菜单（桌面端/移动端共用）
  const renderMoreMenu = (row: any, size?: 'small') => (
    <Menu trigger="click" position="bottom-end" width={200}>
      <Menu.Target>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.secondary} ${size === 'small' ? styles.small : ''}`}
        >
          {t('admin.projects.more')}
          <IconChevronDown size={14} className={styles.iconRight} />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconArrowsExchange size={16} />}
          onClick={() => handleMoreAction('transfer', row)}
        >
          {t('admin.projects.transferOwner')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFolderOpen size={16} />}
          onClick={() => handleMoreAction(row.status === 'active' ? 'archive' : 'activate', row)}
        >
          {row.status === 'active'
            ? t('admin.projects.archiveProject')
            : t('admin.projects.activateProject')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconTrash size={16} />}
          onClick={() => handleMoreAction('delete', row)}
        >
          <span className={styles.dangerText}>{t('admin.projects.deleteProject')}</span>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  )

  // 添加成员对话框可选用户（Select data）
  const availableUsersData = useMemo(
    () =>
      availableUsers.map((u) => ({
        value: String(u.id),
        label: u.username,
        email: u.email,
      })),
    [availableUsers]
  )

  return (
    <div className={styles.projectManagement}>
      {/* 页面头部 */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <h1>{t('admin.projects.title')}</h1>
          <p>{t('admin.projects.subtitle')}</p>
        </div>
        <div className={styles.headerRight}>
          <Button leftSection={<IconPlus size={16} />} onClick={openCreateDialog}>
            {t('admin.projects.create')}
          </Button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className={styles.contentWrapper}>
        <div className={styles.panel}>
          <div className={styles.toolbar}>
            <TextInput
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.currentTarget.value)}
              placeholder={t('admin.projects.searchPlaceholder')}
              style={{ width: 280 }}
              leftSection={<IconSearch size={16} />}
            />
            <Select
              value={statusFilter || null}
              onChange={(v) => setStatusFilter(v || '')}
              placeholder={t('admin.projects.filterStatus')}
              clearable
              style={{ width: 140 }}
              data={[
                { value: 'active', label: t('admin.projects.statusActive') },
                { value: 'archived', label: t('admin.projects.statusArchived') },
              ]}
            />
          </div>

          {/* 桌面端表格 */}
          <div className={styles.tableContainer}>
            <div className={styles.tableView} style={{ position: 'relative' }}>
              <LoadingOverlay visible={loading} />
              <Table className={styles.dataTable}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ minWidth: 280 }}>{t('admin.projects.project')}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t('admin.projects.manager')}</Table.Th>
                    <Table.Th style={{ width: 100, textAlign: 'center' }}>
                      {t('admin.projects.members')}
                    </Table.Th>
                    <Table.Th style={{ width: 100, textAlign: 'center' }}>
                      {t('admin.projects.status')}
                    </Table.Th>
                    <Table.Th style={{ width: 120, textAlign: 'center' }}>
                      {t('project.openAccess.title')}
                    </Table.Th>
                    <Table.Th style={{ width: 180 }}>{t('admin.projects.createdAt')}</Table.Th>
                    <Table.Th style={{ width: 280 }}>{t('admin.projects.actions')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filteredProjects.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <div className={styles.projectCell}>
                          <div className={styles.projectIcon}>
                            <IconFolder size={18} />
                          </div>
                          <div className={styles.projectInfo}>
                            <div className={styles.projectName}>{row.name}</div>
                            <div className={styles.projectDesc}>
                              {row.description || t('admin.projects.noDescription')}
                            </div>
                          </div>
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <span className={styles.managerName}>{row.manager_name || '-'}</span>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>
                        <span
                          className={`${styles.memberCount} ${styles.clickable}`}
                          onClick={() => goToProjectMembers(row)}
                        >
                          {row.member_count} {t('admin.projects.people')}
                        </span>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>{statusBadge(row.status)}</Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>
                        <Switch
                          checked={row.is_open || false}
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            openAccessConfig(row)
                          }}
                          readOnly
                        />
                      </Table.Td>
                      <Table.Td>
                        <span className={styles.timeText}>{formatDate(row.created_at)}</span>
                      </Table.Td>
                      <Table.Td>
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${styles.primary}`}
                          onClick={() => enterProject(row)}
                        >
                          {t('admin.projects.enter')}
                        </button>
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${styles.secondary}`}
                          onClick={() => goToProjectSettings(row)}
                        >
                          {t('admin.projects.settings')}
                        </button>
                        {renderMoreMenu(row)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>

            {/* 分页（对齐 el-pagination layout="total, sizes, prev, pager, next"） */}
            <div className={styles.paginationWrapper}>
              <span className={styles.paginationTotal}>
                {t('admin.projects.total', { total: totalCount, defaultValue: `共 ${totalCount} 条` })}
              </span>
              <Select
                value={String(pageSize)}
                onChange={(v) => v && handleSizeChange(Number(v))}
                data={[
                  { value: '10', label: '10' },
                  { value: '20', label: '20' },
                  { value: '50', label: '50' },
                ]}
                style={{ width: 90 }}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
              />
              <Pagination
                value={currentPage}
                total={Math.max(1, Math.ceil(totalCount / pageSize))}
                onChange={handleCurrentChange}
              />
            </div>
          </div>

          {/* 移动端卡片 */}
          <div className={styles.cardView} style={{ position: 'relative' }}>
            <LoadingOverlay visible={loading} />
            <div className={styles.mobileCardList}>
              {filteredProjects.map((row) => (
                <div className={styles.mobileCard} key={row.id}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardTitle}>{row.name}</span>
                    {statusBadge(row.status)}
                  </div>
                  <div className={styles.cardBody}>
                    <div className={styles.cardField}>
                      <span className={styles.fieldLabel}>{t('admin.projects.manager')}</span>
                      <span className={styles.fieldValue}>{row.manager_name || '-'}</span>
                    </div>
                    <div className={styles.cardField}>
                      <span className={styles.fieldLabel}>{t('admin.projects.members')}</span>
                      <span
                        className={`${styles.fieldValue} ${styles.memberCount} ${styles.clickable}`}
                        onClick={() => goToProjectMembers(row)}
                      >
                        {row.member_count} {t('admin.projects.people')}
                      </span>
                    </div>
                    <div className={styles.cardField}>
                      <span className={styles.fieldLabel}>{t('admin.projects.createdAt')}</span>
                      <span className={styles.fieldValue}>{formatDate(row.created_at)}</span>
                    </div>
                    <div className={styles.cardField}>
                      <span className={styles.fieldLabel}>{t('project.openAccess.title')}</span>
                      <Switch
                        checked={row.is_open || false}
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          openAccessConfig(row)
                        }}
                        readOnly
                      />
                    </div>
                  </div>
                  <div className={styles.cardFooter}>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.primary} ${styles.small}`}
                      onClick={() => enterProject(row)}
                    >
                      {t('admin.projects.enter')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.secondary} ${styles.small}`}
                      onClick={() => goToProjectSettings(row)}
                    >
                      {t('admin.projects.settings')}
                    </button>
                    {renderMoreMenu(row, 'small')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 创建项目对话框 */}
      <Modal
        opened={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        title={t('admin.projects.create')}
        size={500}
        closeOnClickOutside={false}
      >
        <div>
          <TextInput
            label={t('admin.projects.projectName')}
            value={createForm.name}
            onChange={(e) => setCreateForm((f) => ({ ...f, name: e.currentTarget.value }))}
            placeholder={t('admin.projects.projectNamePlaceholder')}
            maxLength={100}
            error={createNameError}
            mb="md"
          />
          <Textarea
            label={t('admin.projects.projectDesc')}
            value={createForm.description}
            onChange={(e) => setCreateForm((f) => ({ ...f, description: e.currentTarget.value }))}
            placeholder={t('admin.projects.projectDescPlaceholder')}
            rows={3}
            maxLength={500}
          />
        </div>
        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setShowCreateDialog(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={submitting} onClick={handleCreate}>
            {t('common.create')}
          </Button>
        </div>
      </Modal>

      {/* 转移负责人对话框 */}
      <Modal
        opened={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        title={t('admin.projects.transferTitle')}
        size={500}
        closeOnClickOutside={false}
      >
        {editingProject && (
          <div>
            <Alert color="yellow" style={{ marginBottom: 20 }}>
              {t('admin.projects.transferAlert')}
            </Alert>
            <div className={styles.formItem}>
              <div className={styles.formLabel}>{t('admin.projects.currentProject')}</div>
              <div className={styles.currentProject}>
                <IconFolder size={18} className={styles.folderIcon} />
                <span>{editingProject.name}</span>
              </div>
            </div>
            <div className={styles.formItem}>
              <div className={styles.formLabel}>{t('admin.projects.transferTo')}</div>
              <Select
                value={transferForm.new_manager_id || null}
                onChange={(v) => setTransferForm({ new_manager_id: v || '' })}
                placeholder={t('admin.projects.searchMember')}
                style={{ width: '100%' }}
                searchable
                onSearchChange={filterTransferMembers}
                error={transferNewManagerError}
                data={filteredTransferMembers.map((member) => ({
                  value: String(member.user_id),
                  label: member.user?.username,
                }))}
                renderOption={({ option }) => {
                  const member = filteredTransferMembers.find(
                    (m) => String(m.user_id) === option.value
                  )
                  return (
                    <div className={styles.userOption}>
                      <span className={styles.userOptionName}>{member?.user?.username}</span>
                      <span className={styles.userOptionRole}>
                        {getRoleName(member?.role_id)}
                      </span>
                    </div>
                  )
                }}
              />
            </div>
          </div>
        )}
        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setShowEditDialog(false)}>
            {t('common.cancel')}
          </Button>
          <Button color="yellow" loading={transferring} onClick={handleTransfer}>
            {t('admin.projects.confirmTransfer')}
          </Button>
        </div>
      </Modal>

      {/* 添加成员对话框 */}
      <Modal
        opened={showAddMemberDialogVisible}
        onClose={() => setShowAddMemberDialogVisible(false)}
        title={t('admin.projects.addMember')}
        size={480}
        closeOnClickOutside={false}
      >
        <div>
          <div className={styles.formItem}>
            <div className={styles.formLabel}>{t('admin.projects.selectUser')}</div>
            <Select
              value={addMemberForm.user_id || null}
              onChange={(v) => setAddMemberForm((f) => ({ ...f, user_id: v || '' }))}
              placeholder={t('admin.projects.searchUserPlaceholder')}
              style={{ width: '100%' }}
              searchable
              onSearchChange={(q) => searchUsers(q)}
              rightSection={searchingUsers ? <Loader size="xs" /> : undefined}
              data={availableUsersData}
              renderOption={({ option }) => {
                const u = availableUsers.find((x) => String(x.id) === option.value)
                return (
                  <div className={styles.userOption}>
                    <span className={styles.userOptionName}>{u?.username}</span>
                    <span className={styles.userOptionEmail}>{u?.email}</span>
                  </div>
                )
              }}
            />
          </div>
          <div className={styles.formItem}>
            <div className={styles.formLabel}>{t('admin.projects.assignRole')}</div>
            <Select
              value={addMemberForm.role_id || null}
              onChange={(v) => setAddMemberForm((f) => ({ ...f, role_id: v || '' }))}
              placeholder={t('admin.projects.selectRole')}
              style={{ width: '100%' }}
              data={projectRoles.map((role) => ({ value: String(role.id), label: role.name }))}
              renderOption={({ option }) => {
                const role = projectRoles.find((r) => String(r.id) === option.value)
                return (
                  <div className={styles.roleOption}>
                    <span className={styles.roleOptionName}>{role?.name}</span>
                    <span className={styles.roleOptionDesc}>{role?.description}</span>
                  </div>
                )
              }}
            />
          </div>
        </div>
        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setShowAddMemberDialogVisible(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={addingMember} onClick={handleAddMember}>
            {t('common.add')}
          </Button>
        </div>
      </Modal>

      {/* 开放设置对话框 */}
      <Modal
        opened={showOpenAccessDialog}
        onClose={() => setShowOpenAccessDialog(false)}
        title={
          t('project.openAccess.title') +
          (openAccessProject ? ' - ' + openAccessProject.name : '')
        }
        size={1200}
        closeOnClickOutside={false}
      >
        {openAccessProject && (
          <OpenAccessConfig project={openAccessProject} onUpdated={handleOpenAccessUpdated} />
        )}
      </Modal>
    </div>
  )
}

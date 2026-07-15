import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Center,
  Group,
  LoadingOverlay,
  Modal,
  Select,
  Table,
  Text,
  TextInput
} from '@mantine/core'
import { DateTimePicker } from '@mantine/dates'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import ProjectMembersTable from '@/components/ProjectMembersTable'
import RoleSelect from '@/components/RoleSelect'
import { copyToClipboard } from '@/utils/clipboard'
import {
  getProjectMembersReq,
  updateMemberRoleReq,
  removeProjectMemberReq,
  addProjectMemberReq,
  getRolesCachedReq,
  createInviteLinkReq,
  getInviteLinksReq,
  revokeInviteLinkReq,
  deleteInviteLinkReq
} from '@/api/project'
import styles from './MemberManagement.module.scss'

// 对应 Vue defineProps
interface MemberManagementProps {
  projectId?: string
}

export default function MemberManagement({ projectId = '' }: MemberManagementProps) {
  const { t } = useTranslation()

  // 成员列表
  const [members, setMembers] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  // 角色列表
  const [roles, setRoles] = useState<any[]>([])

  // 管理员角色ID（computed）
  const adminRoleId = useMemo(() => {
    const adminRole = roles.find((r) => r.code === 'project_admin')
    return adminRole?.id || ''
  }, [roles])

  // 邀请对话框
  const [inviteDialogVisible, setInviteDialogVisible] = useState(false)
  const [creating, setCreating] = useState(false)
  const [generatedLink, setGeneratedLink] = useState('')
  // reactive(inviteForm) → useState 对象
  const [inviteForm, setInviteForm] = useState<{
    role_id: string
    expires_at: Date | null
    max_uses: number | null
  }>({
    role_id: '',
    expires_at: null,
    max_uses: null
  })

  // 邀请链接管理
  const [linksDialogVisible, setLinksDialogVisible] = useState(false)
  const [linksLoading, setLinksLoading] = useState(false)
  const [inviteLinks, setInviteLinks] = useState<any[]>([])

  // 加载成员列表
  const loadMembers = async () => {
    if (!projectId) return

    setLoading(true)
    try {
      const res: any = await getProjectMembersReq(projectId)
      const memberList = (res.data?.items || []).map((m: any) => ({
        ...m,
        // 展开 user 对象的属性到顶层
        username: m.user?.username,
        full_name: m.user?.full_name,
        avatar: m.user?.avatar_url,
        joined_at: m.created_at,
        // 映射 is_owner 到 is_manager
        is_manager: m.is_owner,
        // 确保 is_removed 字段存在
        is_removed: m.is_removed || false
      }))

      // 标记最后一个管理员
      const admins = memberList.filter((m: any) => m.role_id === adminRoleId)
      memberList.forEach((m: any) => {
        m.is_last_admin = admins.length === 1 && m.role_id === adminRoleId
      })

      setMembers(memberList)
    } catch (err) {
      console.error('Load members failed:', err)
      notifications.show({ color: 'red', message: t('project.members.loadMembersFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 加载角色列表（使用缓存）
  const loadRoles = async () => {
    try {
      const res: any = await getRolesCachedReq()
      setRoles(res.data || [])
    } catch (err) {
      console.error('加载角色失败:', err)
    }
  }

  // 加载邀请链接
  const loadInviteLinks = async () => {
    if (!projectId) return
    setLinksLoading(true)
    try {
      const res: any = await getInviteLinksReq(projectId)
      setInviteLinks(res.data || [])
    } catch (err) {
      console.error('加载邀请链接失败:', err)
    } finally {
      setLinksLoading(false)
    }
  }

  // 显示生成邀请链接对话框
  const showInviteDialog = () => {
    setInviteForm({ role_id: '', expires_at: null, max_uses: null })
    setGeneratedLink('')
    setInviteDialogVisible(true)
  }

  // 重置邀请表单（继续生成）
  const resetInviteForm = () => {
    setInviteForm({ role_id: '', expires_at: null, max_uses: null })
    setGeneratedLink('')
  }

  // 复制生成的链接
  const copyGeneratedLink = async () => {
    const success = await copyToClipboard(generatedLink)
    if (success) {
      notifications.show({ color: 'green', message: t('project.members.linkCopied') })
    } else {
      notifications.show({ color: 'red', message: t('project.members.copyFailed') })
    }
  }

  // 显示邀请链接管理对话框
  const showLinksDialog = () => {
    loadInviteLinks()
    setLinksDialogVisible(true)
  }

  // 创建邀请链接
  const handleCreateInvite = async () => {
    if (!inviteForm.role_id) {
      notifications.show({ color: 'yellow', message: t('project.members.pleaseSelectRole') })
      return
    }

    setCreating(true)
    try {
      const res: any = await createInviteLinkReq(projectId, {
        role_id: inviteForm.role_id,
        expires_at: inviteForm.expires_at || null,
        max_uses: inviteForm.max_uses
      })
      setInviteLinks((prev) => [res.data, ...prev])
      // 生成完整链接并显示
      setGeneratedLink(`${window.location.origin}/project/join/${res.data.code}`)
      notifications.show({ color: 'green', message: t('project.members.inviteLinkCreated') })
    } catch (err: any) {
      console.error('Create invite link failed:', err)
      notifications.show({
        color: 'red',
        message: err?.msg || t('project.members.createInviteFailed')
      })
    } finally {
      setCreating(false)
    }
  }

  // 撤销邀请链接
  const handleRevokeInvite = (link: any) => {
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('project.members.revokeInvite'),
      children: t('project.members.revokeConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await revokeInviteLinkReq(projectId, link.id)
          setInviteLinks((prev) =>
            prev.map((l) =>
              l.id === link.id ? { ...l, is_active: false, status: 'revoked' } : l
            )
          )
          notifications.show({ color: 'green', message: t('project.members.inviteLinkRevoked') })
        } catch (err: any) {
          console.error('Revoke invite link failed:', err)
          notifications.show({
            color: 'red',
            message: err?.msg || t('project.members.revokeFailed')
          })
        }
      }
    })
  }

  // 删除邀请链接
  const handleDeleteInvite = (link: any) => {
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('project.members.deleteInviteLink'),
      children: t('project.members.deleteConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteInviteLinkReq(projectId, link.id)
          setInviteLinks((prev) => prev.filter((l) => l.id !== link.id))
          notifications.show({ color: 'green', message: t('project.members.inviteLinkDeleted') })
        } catch (err: any) {
          console.error('Delete invite link failed:', err)
          const errorMessage =
            err?.response?.data?.message ||
            err?.response?.data?.msg ||
            err?.message ||
            err?.msg
          if (!errorMessage) {
            notifications.show({ color: 'red', message: t('project.members.deleteFailed') })
          }
        }
      }
    })
  }

  // 复制邀请链接
  const copyInviteLink = async (code: string) => {
    const url = `${window.location.origin}/project/join/${code}`
    const success = await copyToClipboard(url)
    if (success) {
      notifications.show({ color: 'green', message: t('project.members.linkCopied') })
    } else {
      notifications.show({ color: 'red', message: t('project.members.copyFailed') })
    }
  }

  // 格式化过期时间
  const formatExpireTime = (dateStr: any) => {
    if (!dateStr) return t('project.members.neverExpire')
    const expiresAt = new Date(dateStr)
    const now = new Date()

    if (expiresAt <= now) return t('project.members.expired')

    const diffMs = expiresAt.getTime() - now.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)

    if (diffDays > 0) return t('project.members.expireInDays', { count: diffDays })
    if (diffHours > 0) return t('project.members.expireInHours', { count: diffHours })
    return t('project.members.expiringSoon')
  }

  // 获取状态类型 → Mantine Badge color
  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      active: 'green',
      expired: 'gray',
      exhausted: 'yellow',
      revoked: 'red'
    }
    return colors[status] || 'gray'
  }

  // 获取状态文本
  const getStatusText = (status: string) => {
    const texts: Record<string, string> = {
      active: t('project.members.statusActive'),
      expired: t('project.members.statusExpired'),
      exhausted: t('project.members.statusExhausted'),
      revoked: t('project.members.statusRevoked')
    }
    return texts[status] || status
  }

  // 修改角色
  const handleRoleChange = async (member: any) => {
    try {
      const res: any = await updateMemberRoleReq(projectId, member.user_id, {
        role_id: member.role_id
      })
      // 更新本地数据
      setMembers((prev) => {
        const next = prev.map((m) =>
          m.user_id === member.user_id ? { ...m, ...res.data } : m
        )
        // 更新最后管理员标记
        const admins = next.filter((m) => m.role_id === adminRoleId)
        return next.map((m) => ({
          ...m,
          is_last_admin: admins.length === 1 && m.role_id === adminRoleId
        }))
      })
      notifications.show({ color: 'green', message: t('project.members.roleUpdated') })
    } catch (err: any) {
      console.error('Update role failed:', err)
      notifications.show({
        color: 'red',
        message: err?.msg || t('project.members.updateRoleFailed')
      })
      // 重新加载以恢复状态
      loadMembers()
    }
  }

  // 移除成员（保留用于兼容）
  const handleRemoveMember = async (member: any) => {
    try {
      await removeProjectMemberReq(projectId, member.user_id)
      setMembers((prev) => prev.filter((m) => m.user_id !== member.user_id))
      notifications.show({ color: 'green', message: t('project.members.memberRemoved') })
    } catch (err: any) {
      console.error('Remove member failed:', err)
      notifications.show({
        color: 'red',
        message: err?.msg || t('project.members.removeMemberFailed')
      })
    }
  }

  // 切换成员状态（移除/恢复）
  const handleToggleMember = async (member: any, isActive: boolean) => {
    try {
      if (isActive) {
        // 恢复成员：调用加入接口（add_member 在管理员操作时会自动恢复已删除的成员）
        const res: any = await addProjectMemberReq(projectId, {
          user_id: member.user_id,
          role_id: member.role_id || roles[0]?.id // 使用原来的角色，如果没有则使用第一个角色
        })
        // 更新本地数据
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id
              ? {
                  ...m,
                  ...res.data,
                  is_removed: false,
                  username: res.data.user?.username,
                  full_name: res.data.user?.full_name,
                  avatar: res.data.user?.avatar_url,
                  joined_at: res.data.created_at,
                  is_manager: res.data.is_owner
                }
              : m
          )
        )
        notifications.show({ color: 'green', message: t('project.members.memberRestored') })
      } else {
        // 移除成员：添加二次确认
        const memberName =
          member.user?.username || member.username || t('project.members.thisMember')
        // ElMessageBox.confirm → modals.openConfirmModal（异步确认）
        const confirmed = await new Promise<boolean>((resolve) => {
          modals.openConfirmModal({
            title: t('project.members.removeMember'),
            children: t('project.members.removeConfirmMsg', { name: memberName }),
            labels: {
              confirm: t('project.members.confirmRemove'),
              cancel: t('common.cancel')
            },
            confirmProps: { color: 'red' },
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
            onClose: () => resolve(false)
          })
        })
        if (!confirmed) {
          // 用户取消操作，直接返回，不执行移除
          return
        }

        // 确认后执行移除操作
        await removeProjectMemberReq(projectId, member.user_id)
        // 更新本地数据
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, is_removed: true } : m
          )
        )
        notifications.show({ color: 'green', message: t('project.members.memberRemoved') })
      }
    } catch (err: any) {
      console.error('Toggle member status failed:', err)
      notifications.show({
        color: 'red',
        message: err?.msg || t('project.members.toggleStatusFailed')
      })
      // 重新加载以恢复状态
      loadMembers()
    }
  }

  // 监听 projectId 变化（watch immediate + onMounted loadRoles）
  useEffect(() => {
    if (projectId) {
      loadMembers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 初始化
  useEffect(() => {
    loadRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 邀请链接行操作按钮（桌面/移动端复用）
  const renderLinkActions = (row: any) => (
    <>
      {row.status === 'active' && (
        <Button
          size="compact-sm"
          variant="subtle"
          onClick={() => copyInviteLink(row.code)}
        >
          {t('common.copy')}
        </Button>
      )}
      {row.status === 'active' && (
        <Button
          size="compact-sm"
          variant="subtle"
          color="red"
          onClick={() => handleRevokeInvite(row)}
        >
          {t('project.members.revoke')}
        </Button>
      )}
      {row.status !== 'active' && (
        <Button
          size="compact-sm"
          variant="subtle"
          color="gray"
          onClick={() => handleDeleteInvite(row)}
        >
          {t('common.delete')}
        </Button>
      )}
    </>
  )

  return (
    <div className={styles.memberManagement}>
      <div className={styles.sectionBody}>
        <ProjectMembersTable
          members={members}
          loading={loading}
          adminRoleId={adminRoleId}
          onAdd={showInviteDialog}
          onManageLinks={showLinksDialog}
          onRoleChange={handleRoleChange}
          onRemove={handleRemoveMember}
          onToggle={handleToggleMember}
        />
      </div>

      {/* 生成邀请链接对话框 */}
      <Modal
        opened={inviteDialogVisible}
        onClose={() => setInviteDialogVisible(false)}
        title={t('project.members.generateInviteLink')}
        size={480}
        closeOnClickOutside={false}
      >
        <div className={styles.inviteForm}>
          <Box mb={4}>
            <Text size="sm" fw={500} component="label">
              {t('project.members.roleAfterJoin')}
              <Text span c="red">
                {' *'}
              </Text>
            </Text>
          </Box>
          <RoleSelect
            value={inviteForm.role_id}
            onChange={(v) => setInviteForm((f) => ({ ...f, role_id: v }))}
            placeholder={t('project.members.selectRole')}
            style={{ width: '100%' }}
            disabled={!!generatedLink}
          />
          <div className={styles.inviteFormRow} style={{ marginTop: 12 }}>
            <div className={styles.formItem}>
              <DateTimePicker
                label={t('project.members.validity')}
                value={inviteForm.expires_at}
                onChange={(v) => setInviteForm((f) => ({ ...f, expires_at: v as any }))}
                placeholder={t('project.members.selectExpireTime')}
                style={{ width: '100%' }}
                disabled={!!generatedLink}
              />
            </div>
            <div className={styles.formItem}>
              <Select
                label={t('project.members.maxUses')}
                value={inviteForm.max_uses === null ? '' : String(inviteForm.max_uses)}
                onChange={(v) =>
                  setInviteForm((f) => ({
                    ...f,
                    max_uses: v === '' || v === null ? null : Number(v)
                  }))
                }
                style={{ width: '100%' }}
                disabled={!!generatedLink}
                data={[
                  { value: '1', label: t('project.members.useTimes', { count: 1 }) },
                  { value: '5', label: t('project.members.useTimes', { count: 5 }) },
                  { value: '10', label: t('project.members.useTimes', { count: 10 }) },
                  { value: '', label: t('project.members.unlimited') }
                ]}
              />
            </div>
          </div>
        </div>

        {/* 生成的邀请链接显示区域 */}
        {generatedLink && (
          <div className={styles.generatedLinkSection}>
            <div className={styles.linkLabel}>{t('project.members.linkGenerated')}</div>
            <div className={styles.linkBox}>
              <TextInput value={generatedLink} readOnly className={styles.linkInput} />
              <Button className={styles.linkCopyBtn} onClick={copyGeneratedLink}>
                {t('common.copy')}
              </Button>
            </div>
            <div className={styles.linkHint}>{t('project.members.linkHint')}</div>
          </div>
        )}

        {/* footer */}
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setInviteDialogVisible(false)}>
            {generatedLink ? t('common.close') : t('common.cancel')}
          </Button>
          {!generatedLink ? (
            <Button
              loading={creating}
              disabled={!inviteForm.role_id}
              onClick={handleCreateInvite}
            >
              {t('project.members.generateLink')}
            </Button>
          ) : (
            <Button color="green" onClick={resetInviteForm}>
              {t('project.members.continueGenerate')}
            </Button>
          )}
        </Group>
      </Modal>

      {/* 邀请链接管理对话框 */}
      <Modal
        opened={linksDialogVisible}
        onClose={() => setLinksDialogVisible(false)}
        title={t('project.members.inviteLinkManagement')}
        size={640}
        closeOnClickOutside={false}
      >
        <div className={styles.inviteLinksManage}>
          {/* 桌面端表格 */}
          <div className={styles.tableView}>
            <Box pos="relative" mih={120}>
              <LoadingOverlay visible={linksLoading} />
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 120 }}>{t('project.members.role')}</Table.Th>
                    <Table.Th style={{ width: 90 }}>{t('project.members.status')}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t('project.members.validity')}</Table.Th>
                    <Table.Th style={{ width: 100 }}>{t('project.members.maxUses')}</Table.Th>
                    <Table.Th style={{ width: 160, textAlign: 'right' }}>
                      {t('common.actions')}
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {inviteLinks.length === 0 && !linksLoading ? (
                    <Table.Tr>
                      <Table.Td colSpan={5}>
                        <Center py="lg">
                          <Text c="dimmed" size="sm">
                            {t('project.members.noInviteLinks')}
                          </Text>
                        </Center>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    inviteLinks.map((row) => (
                      <Table.Tr key={row.id}>
                        <Table.Td>
                          <span className={styles.linkRole}>{row.role_name}</span>
                        </Table.Td>
                        <Table.Td>
                          <Badge color={getStatusColor(row.status)} size="sm">
                            {getStatusText(row.status)}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <span className={styles.linkMeta}>
                            {row.expires_at
                              ? formatExpireTime(row.expires_at)
                              : t('project.members.neverExpire')}
                          </span>
                        </Table.Td>
                        <Table.Td>
                          <span className={styles.linkMeta}>
                            {row.used_count}
                            {row.max_uses ? `/${row.max_uses}` : ''}
                          </span>
                        </Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            {renderLinkActions(row)}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Box>
          </div>

          {/* 移动端卡片 */}
          <div className={styles.cardView}>
            <LoadingOverlay visible={linksLoading} />
            {inviteLinks.length === 0 && !linksLoading && (
              <div className={styles.emptyTip}>{t('project.members.noInviteLinks')}</div>
            )}
            <div className={styles.mobileCardList}>
              {inviteLinks.map((row) => (
                <div className={styles.mobileCard} key={row.id}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardTitle}>{row.role_name}</span>
                    <Badge color={getStatusColor(row.status)} size="sm">
                      {getStatusText(row.status)}
                    </Badge>
                  </div>
                  <div className={styles.cardBody}>
                    <div className={styles.cardField}>
                      <span className={styles.fieldLabel}>{t('project.members.validity')}</span>
                      <span className={styles.fieldValue}>
                        {row.expires_at
                          ? formatExpireTime(row.expires_at)
                          : t('project.members.neverExpire')}
                      </span>
                    </div>
                    <div className={styles.cardField}>
                      <span className={styles.fieldLabel}>{t('project.members.maxUses')}</span>
                      <span className={styles.fieldValue}>
                        {row.used_count}
                        {row.max_uses ? `/${row.max_uses}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className={styles.cardFooter}>{renderLinkActions(row)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* footer */}
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setLinksDialogVisible(false)}>
            {t('common.close')}
          </Button>
        </Group>
      </Modal>
    </div>
  )
}

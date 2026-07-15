import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Switch, Table, TextInput } from '@mantine/core'
import { IconLink, IconPlus, IconSearch, IconAlertTriangle } from '@tabler/icons-react'
import { useBasicStore } from '@/store/basic'
import RoleSelect from '@/components/RoleSelect'
import styles from './ProjectMembersTable.module.scss'

export interface ProjectMembersTableProps {
  members?: any[]
  loading?: boolean
  showToolbar?: boolean
  showLastAdminTip?: boolean
  tableHeight?: string | number
  // 项目管理员的角色ID（应由父组件传入）
  adminRoleId?: string
  // 工具栏右侧操作区具名 slot（actions）
  actions?: ReactNode
  // defineEmits 对应的回调 props
  onAdd?: () => void
  onRoleChange?: (member: any) => void
  onRemove?: (member: any) => void
  onToggle?: (member: any, isActive: boolean) => void
  onManageLinks?: () => void
}

export default function ProjectMembersTable({
  members = [],
  loading = false,
  showToolbar = true,
  showLastAdminTip = true,
  tableHeight,
  adminRoleId = '',
  actions,
  onAdd,
  onRoleChange,
  onToggle,
  onManageLinks
}: ProjectMembersTableProps) {
  const { t } = useTranslation()
  const userInfo = useBasicStore((s) => s.userInfo)

  // 筛选条件
  const [filterRole, setFilterRole] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')

  // 是否有最后一个管理员
  const hasLastAdmin = useMemo(() => {
    const admins = members.filter((m) => m.role_id === adminRoleId)
    return admins.length === 1
  }, [members, adminRoleId])

  // 过滤后的成员列表
  const filteredMembers = useMemo(() => {
    let result = members

    // 角色筛选
    if (filterRole) {
      result = result.filter((m) => m.role_id === filterRole)
    }

    // 关键词搜索
    if (searchKeyword) {
      const keyword = searchKeyword.toLowerCase()
      result = result.filter(
        (m) => m.full_name?.toLowerCase().includes(keyword) || m.username?.toLowerCase().includes(keyword)
      )
    }

    return result
  }, [members, filterRole, searchKeyword])

  // 格式化日期
  const formatDate = (dateStr: string) => {
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

  // 是否可以编辑成员
  const canEditMember = (member: any) => {
    // 负责人不能被编辑（移除或降权）
    if (member.is_manager) {
      return false
    }
    // 如果是最后一个管理员，不能编辑
    if (hasLastAdmin && member.role_id === adminRoleId) {
      return false
    }
    return true
  }

  // 修改成员角色
  const handleRoleChange = (member: any) => {
    onRoleChange?.(member)
  }

  // 切换成员状态
  const handleToggleMember = (member: any, isActive: boolean) => {
    onToggle?.(member, isActive)
  }

  return (
    <div className={styles.projectMembersTable}>
      {/* 工具栏 */}
      {showToolbar && (
        <div className={styles.membersToolbar}>
          <div className={styles.toolbarLeft}>
            <RoleSelect
              value={filterRole}
              onChange={(v) => setFilterRole(v || '')}
              placeholder={t('common.filterRole')}
              clearable
              style={{ width: 140 }}
            />
            <TextInput
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.currentTarget.value)}
              placeholder={t('common.searchMember')}
              leftSection={<IconSearch size={16} />}
              size="sm"
              style={{ width: 200 }}
            />
          </div>
          <div className={styles.toolbarRight}>
            {actions ?? (
              <>
                <Button
                  variant="default"
                  style={{ marginRight: 10 }}
                  leftSection={<IconLink size={16} />}
                  onClick={() => onManageLinks?.()}
                >
                  {t('common.manageInvites')}
                </Button>
                <Button color="blue" leftSection={<IconPlus size={16} />} onClick={() => onAdd?.()}>
                  {t('common.inviteMember')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 成员表格 - 桌面端 */}
      <div className={styles.tableView}>
        <div className={styles.tableWrapper}>
          <Table
            className={styles.membersTable}
            style={tableHeight ? { height: tableHeight } : undefined}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ minWidth: 280 }}>{t('common.member')}</Table.Th>
                <Table.Th style={{ width: 200 }}>{t('common.projectRole')}</Table.Th>
                <Table.Th style={{ width: 180 }}>{t('common.joinedAt')}</Table.Th>
                <Table.Th style={{ width: 120, textAlign: 'center' }}>{t('common.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredMembers.map((row) => (
                <Table.Tr key={row.user_id || row.user?.id}>
                  {/* 成员 */}
                  <Table.Td>
                    <div className={styles.memberInfo}>
                      <div className={styles.memberDetails}>
                        <div className={styles.memberNameRow}>
                          <span className={styles.memberName}>{row.user.username}</span>
                          {row.user.id === userInfo?.userId && (
                            <Badge color="green" size="sm" variant="light">
                              {t('common.me')}
                            </Badge>
                          )}
                          {row.is_manager && (
                            <Badge color="yellow" size="sm">
                              {t('common.owner')}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </Table.Td>

                  {/* 项目角色 */}
                  <Table.Td>
                    <RoleSelect
                      value={row.role_id}
                      onChange={(v) => {
                        row.role_id = v
                        handleRoleChange(row)
                      }}
                      disabled={!canEditMember(row) || row.is_removed}
                    />
                  </Table.Td>

                  {/* 加入时间 */}
                  <Table.Td>
                    <span className={styles.timeText}>{formatDate(row.created_at)}</span>
                  </Table.Td>

                  {/* 操作 */}
                  <Table.Td style={{ textAlign: 'center' }}>
                    {canEditMember(row) ? (
                      <div className={styles.toggleWrapper}>
                        <Switch
                          checked={!row.is_removed}
                          onLabel={t('common.joined')}
                          offLabel={t('common.removed')}
                          onChange={(e) => handleToggleMember(row, e.currentTarget.checked)}
                        />
                      </div>
                    ) : (
                      <span className={styles.textMuted}>-</span>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      </div>

      {/* 成员卡片 - 移动端 */}
      <div className={styles.cardView}>
        <div className={styles.mobileCardList}>
          {filteredMembers.map((row) => (
            <div key={row.user_id || row.user?.id} className={styles.mobileCard}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitle}>
                  <span>{row.user.username}</span>
                  {row.user.id === userInfo?.userId && (
                    <Badge color="green" size="sm" variant="light" style={{ marginLeft: 6 }}>
                      {t('common.me')}
                    </Badge>
                  )}
                  {row.is_manager && (
                    <Badge color="yellow" size="sm" style={{ marginLeft: 6 }}>
                      {t('common.owner')}
                    </Badge>
                  )}
                </div>
                <RoleSelect
                  value={row.role_id}
                  onChange={(v) => {
                    row.role_id = v
                    handleRoleChange(row)
                  }}
                  disabled={!canEditMember(row) || row.is_removed}
                  size="sm"
                  style={{ width: 120 }}
                />
              </div>
              <div className={styles.cardBody}>
                <div className={styles.cardField}>
                  <span className={styles.fieldLabel}>{t('common.joinedAt')}</span>
                  <span className={styles.fieldValue}>{formatDate(row.created_at)}</span>
                </div>
              </div>
              <div className={styles.cardFooter}>
                {canEditMember(row) ? (
                  <div className={styles.toggleWrapper}>
                    <Switch
                      checked={!row.is_removed}
                      onLabel={t('common.joined')}
                      offLabel={t('common.removed')}
                      onChange={(e) => handleToggleMember(row, e.currentTarget.checked)}
                    />
                  </div>
                ) : (
                  <span className={styles.textMuted}>-</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 提示信息 */}
      {showLastAdminTip && hasLastAdmin && (
        <div className={styles.membersTip}>
          <span className={styles.tipIcon}>
            <IconAlertTriangle size={16} />
          </span>
          <span>{t('common.lastAdminTip')}</span>
        </div>
      )}
    </div>
  )
}

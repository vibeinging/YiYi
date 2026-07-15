import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader, Select } from '@mantine/core'
import type { ComboboxItem } from '@mantine/core'
import { getRolesCachedReq } from '@/api/project'
import styles from './RoleSelect.module.scss'

/**
 * 角色选择器(对齐原 components/RoleSelect.vue)。
 * el-select + el-option → Mantine Select;自定义两行选项(名称 + 权限描述)用 renderOption。
 */
export interface RoleSelectProps {
  // React 习惯用 value;modelValue 作为兼容别名(原 Vue v-model)
  value?: string
  modelValue?: string
  placeholder?: string
  clearable?: boolean
  disabled?: boolean
  size?: string
  style?: React.CSSProperties
  // defineEmits → 回调 props
  'onUpdate:modelValue'?: (value: string) => void
  onChange?: (value: string) => void
}

export default function RoleSelect({
  value,
  modelValue = '',
  placeholder,
  clearable = false,
  disabled = false,
  size = 'default',
  style,
  'onUpdate:modelValue': onUpdateModelValue,
  onChange
}: RoleSelectProps) {
  const current = value ?? modelValue
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [roleOptions, setRoleOptions] = useState<any[]>([])

  // 权限中文名映射
  const PERMISSION_LABELS: Record<string, string> = {
    ask_data: t('common.permAskData'),
    data_manage: t('common.permDataManage'),
    model_service_manage: t('common.permModelService'),
    report_manage: t('common.permReportManage'),
    member_manage: t('common.permMemberManage')
  }

  const getPermissionText = (role: any) => {
    if (!role?.permissions) return role?.description || ''
    // permissions 可能是字符串数组或逗号分隔的字符串
    const perms = Array.isArray(role.permissions)
      ? role.permissions
      : role.permissions.split(',').map((p: string) => p.trim())
    return perms.map((p: string) => PERMISSION_LABELS[p] || p).join('、')
  }

  // 加载角色列表
  const loadRoles = async () => {
    setLoading(true)
    try {
      const res: any = await getRolesCachedReq()
      setRoleOptions(res.data || [])
    } catch (err) {
      console.error('加载角色列表失败:', err)
      setRoleOptions([])
    } finally {
      setLoading(false)
    }
  }

  // onMounted
  useEffect(() => {
    loadRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Select 的 data(value/label),并以 id 索引 role 供 renderOption 取权限描述
  const data = useMemo<ComboboxItem[]>(
    () => roleOptions.map((role) => ({ value: String(role.id), label: role.name })),
    [roleOptions]
  )
  const roleMap = useMemo(() => {
    const map: Record<string, any> = {}
    roleOptions.forEach((role) => {
      map[String(role.id)] = role
    })
    return map
  }, [roleOptions])

  // Mantine size 映射(EP 的 default → Mantine sm)
  const mantineSize = size === 'default' ? 'sm' : size

  return (
    <Select
      className={styles.roleSelect}
      style={style}
      value={current || null}
      onChange={(v) => {
        const next = v || ''
        onUpdateModelValue?.(next)
        onChange?.(next)
      }}
      placeholder={placeholder || t('common.selectRole')}
      clearable={clearable}
      disabled={disabled}
      size={mantineSize}
      rightSection={loading ? <Loader size="xs" /> : undefined}
      data={data}
      comboboxProps={{ classNames: { dropdown: 'styled-select-popper' } }}
      renderOption={({ option }) => {
        const role = roleMap[option.value]
        return (
          <div className={styles.selectOptionItem}>
            <div className={styles.optionName}>{option.label}</div>
            <div className={styles.optionDesc}>{getPermissionText(role)}</div>
          </div>
        )
      }}
    />
  )
}

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from '@mantine/core'
import type { ComboboxItem } from '@mantine/core'
import styles from './SystemRoleSelect.module.scss'

/**
 * 系统角色选择器(对齐原 components/SystemRoleSelect.vue)。
 * el-select + el-option → Mantine Select;静态选项(admin/creator/invited)来自 i18n;
 * 自定义两行选项(名称 + 描述)用 renderOption。
 */
export interface SystemRoleSelectProps {
  // defineProps
  modelValue?: string
  placeholder?: string
  clearable?: boolean
  disabled?: boolean
  size?: string
  // defineEmits → 回调 props
  'onUpdate:modelValue'?: (value: string) => void
  onChange?: (value: string) => void
}

export default function SystemRoleSelect({
  modelValue = '',
  placeholder,
  clearable = false,
  disabled = false,
  size = 'default',
  'onUpdate:modelValue': onUpdateModelValue,
  onChange
}: SystemRoleSelectProps) {
  const { t } = useTranslation()

  // 系统角色选项
  const roleOptions = useMemo(
    () => [
      {
        value: 'admin',
        label: t('common.sysRoleAdmin'),
        description: t('common.sysRoleAdminDesc')
      },
      {
        value: 'creator',
        label: t('common.sysRoleCreator'),
        description: t('common.sysRoleCreatorDesc')
      },
      {
        value: 'invited',
        label: t('common.sysRoleGuest'),
        description: t('common.sysRoleGuestDesc')
      }
    ],
    [t]
  )

  // Select 的 data(value/label),并以 value 索引 role 供 renderOption 取描述
  const data = useMemo<ComboboxItem[]>(
    () => roleOptions.map((role) => ({ value: role.value, label: role.label })),
    [roleOptions]
  )
  const roleMap = useMemo(() => {
    const map: Record<string, any> = {}
    roleOptions.forEach((role) => {
      map[role.value] = role
    })
    return map
  }, [roleOptions])

  // Mantine size 映射(EP 的 default → Mantine sm)
  const mantineSize = size === 'default' ? 'sm' : size

  return (
    <Select
      className={styles.systemRoleSelect}
      value={modelValue || null}
      onChange={(value) => {
        const next = value || ''
        onUpdateModelValue?.(next)
        onChange?.(next)
      }}
      placeholder={placeholder || t('common.filterIdentity')}
      clearable={clearable}
      disabled={disabled}
      size={mantineSize}
      data={data}
      comboboxProps={{ classNames: { dropdown: 'styled-select-popper' } }}
      renderOption={({ option }) => {
        const role = roleMap[option.value]
        return (
          <div className={styles.selectOptionItem}>
            <div className={styles.optionName}>{option.label}</div>
            <div className={styles.optionDesc}>{role?.description}</div>
          </div>
        )
      }}
    />
  )
}

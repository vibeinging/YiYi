import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { PasswordInput, Radio, Stack, TextInput, Textarea } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useTranslation } from 'react-i18next'
import { supportDatabaseReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './DatabaseConfigForm.module.scss'

// 数据库连接表单数据类型
interface DatabaseForm {
  host: string
  username: string
  password: string
  database: string
  port: string
  db_type: string
  description: string
}

interface DatabaseConfigFormProps {
  // 对应 Vue 的 defineProps({ initialData })
  initialData?: Partial<DatabaseForm> & Record<string, any>
}

// 导出给父元素使用的实例方法（对应 defineExpose）
export interface DatabaseConfigFormHandle {
  validateForm: () => Promise<DatabaseForm | undefined>
}

const DatabaseConfigForm = forwardRef<DatabaseConfigFormHandle, DatabaseConfigFormProps>(
  function DatabaseConfigForm({ initialData = {} }, ref) {
    const { t } = useTranslation()

    // currentProjectId getter（对应 projectStore.currentProjectId）
    const currentProjectId = useProjectStore(projectGetters.currentProjectId)

    // ref([]) → 支持的数据库类型列表（用 ref 保存以便在 effect/校验中读取最新值）
    const dbTypesRef = useRef<any[]>([])

    // ref({...}) + rules → @mantine/form
    const form = useForm<DatabaseForm>({
      initialValues: {
        host: '',
        username: '',
        password: '',
        database: '',
        port: '',
        db_type: '',
        description: ''
      },
      validate: {
        host: (value) => (!value ? t('database.rules.host') : null),
        username: (value) => (!value ? t('database.rules.username') : null),
        password: (value) => (!value ? t('database.rules.password') : null),
        database: (value) => (!value ? t('database.rules.database') : null),
        port: (value) => (!value ? t('database.rules.port') : null),
        db_type: (value) => (!value ? t('database.rules.type') : null)
      }
    })

    // formRef.value.validate() → form.validate()；返回校验通过后的表单值
    const validateForm = async (): Promise<DatabaseForm | undefined> => {
      const { hasErrors } = form.validate()
      if (hasErrors) return undefined
      return form.getValues()
    }

    // defineExpose({ validateForm })
    useImperativeHandle(ref, () => ({ validateForm }))

    // 获取数据库类型的默认端口（从 API 返回的数据中获取）
    const getDefaultPort = (dbType: string): string => {
      const dbTypeInfo = dbTypesRef.current.find((item: any) => item.value === dbType)
      if (dbTypeInfo && dbTypeInfo.default_port) {
        return String(dbTypeInfo.default_port)
      }
      return ''
    }

    // 获取支持的数据库类型列表
    const getSupportDatabaseOptions = async () => {
      const res = await supportDatabaseReq(currentProjectId)
      if (res.data && res.data.items) {
        dbTypesRef.current = res.data.items
      }
    }

    // onMounted：Object.assign(form, initialData) + 拉取支持的数据库类型
    useEffect(() => {
      form.setValues((prev) => ({ ...prev, ...(initialData as Partial<DatabaseForm>) }))
      getSupportDatabaseOptions()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // watch(() => form.db_type)：监听数据库类型变化，自动填充默认端口
    const dbType = form.values.db_type
    useEffect(() => {
      if (dbType) {
        form.setFieldValue('port', getDefaultPort(dbType))
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dbType])

    const dbTypes = dbTypesRef.current

    return (
      <form className={styles.demoRuleForm}>
        <Stack gap="md">
          <TextInput
            label={t('database.form.host')}
            placeholder={t('database.form.hostPlaceholder')}
            withAsterisk
            size="md"
            {...form.getInputProps('host')}
          />
          <TextInput
            label={t('database.form.username')}
            placeholder={t('database.form.usernamePlaceholder')}
            withAsterisk
            size="md"
            {...form.getInputProps('username')}
          />
          <PasswordInput
            label={t('database.form.password')}
            placeholder={t('database.form.passwordPlaceholder')}
            withAsterisk
            size="md"
            {...form.getInputProps('password')}
          />
          <TextInput
            label={t('database.form.database')}
            placeholder={t('database.form.databasePlaceholder')}
            withAsterisk
            size="md"
            {...form.getInputProps('database')}
          />
          <TextInput
            label={t('database.form.port')}
            placeholder={t('database.form.portPlaceholder')}
            withAsterisk
            size="md"
            {...form.getInputProps('port')}
          />
          <Radio.Group
            label={t('database.form.type')}
            withAsterisk
            size="md"
            {...form.getInputProps('db_type')}
          >
            <Stack gap="xs" mt="xs">
              {dbTypes.map((item: any) => (
                <Radio key={item.value} value={item.value} label={item.label} />
              ))}
            </Stack>
          </Radio.Group>
          <Textarea
            label={t('database.form.description')}
            placeholder={t('database.form.descriptionPlaceholder')}
            size="md"
            {...form.getInputProps('description')}
          />
        </Stack>
      </form>
    )
  }
)

export default DatabaseConfigForm

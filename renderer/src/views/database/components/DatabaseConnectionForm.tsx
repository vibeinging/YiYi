import {
  type InputHTMLAttributes,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Badge,
  Button,
  Divider,
  FileButton,
  Group,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Select,
  TextInput,
  Textarea
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconInfoCircleFilled, IconPlugConnected, IconTrash, IconUpload } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import {
  createDatabaseReq,
  discoverSchemasReq,
  supportDatabaseReq,
  testDatabaseConnectionReq,
  updateDatabaseReq,
  uploadDatabaseFileReq
} from '@/api/database'
import { useDatabaseStore } from '@/store/database'
import { projectGetters, useProjectStore } from '@/store/project'
import styles from './DatabaseConnectionForm.module.scss'

// 对应原 DatabaseType 接口
interface DatabaseType {
  value: string
  label: string
  description: string
  multiple_schema: string // "True" or "False"
  default_port: number | null
}

interface DatabaseConnectionFormProps {
  // defineProps({ initialData, hideSaveButton })
  initialData?: Record<string, any>
  hideSaveButton?: boolean
  // defineEmits(['saved', 'cancel'])
  onSaved?: (databaseId: string | null) => void
  onCancel?: () => void
}

// defineExpose({ handleSave, handleTestConnection, connectionTestPassed })
export interface DatabaseConnectionFormHandle {
  handleSave: () => void
  handleTestConnection: () => void
  connectionTestPassed: boolean
}

// 文件后缀校验
const ALLOWED_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.duckdb']

const DatabaseConnectionForm = forwardRef<DatabaseConnectionFormHandle, DatabaseConnectionFormProps>(
  function DatabaseConnectionForm({ initialData = {}, hideSaveButton = false, onSaved, onCancel }, ref) {
    const { t } = useTranslation()

    // projectStore.currentProjectId
    const currentProjectId = useProjectStore(projectGetters.currentProjectId)

    // databaseStore（按字段/函数选择）
    const setStoreLoading = useDatabaseStore((s) => s.setLoading)
    const setStoreError = useDatabaseStore((s) => s.setError)
    const storeSupportsMultipleSchemas = useDatabaseStore((s) => s.supportsMultipleSchemas)
    const getConnectionKey = useDatabaseStore((s) => s.getConnectionKey)
    const handleConnectionTestResponse = useDatabaseStore((s) => s.handleConnectionTestResponse)
    const saveConnectionTestResult = useDatabaseStore((s) => s.saveConnectionTestResult)

    // reactive(formData) → useState（对象，保持引用语义）。
    // 用 ref 镜像最新值，方便在异步/校验/imperative 方法里读到最新数据。
    const [formData, setFormDataState] = useState<Record<string, any>>(() => ({
      id: '',
      name: '',
      host: '',
      username: '',
      password: '',
      database: '',
      port: '',
      db_type: '',
      retrieval_mode: 'table',
      table_limit: 5, // 表召回数量限制
      oracle_conn_type: 'service_name', // Oracle 连接标识类型: service_name(默认) / sid
      selected_schemas: [], // 要同步的 schemas
      available_schemas: [], // 所有可用的 schemas
      supports_multiple_schemas: false,
      sqlite_attached_dbs: []
    }))
    const formDataRef = useRef(formData)
    formDataRef.current = formData

    // 合并式更新 formData（mutator 接受最新值返回部分字段）
    const patchFormData = useCallback((patch: Record<string, any> | ((prev: Record<string, any>) => Record<string, any>)) => {
      setFormDataState((prev) => {
        const next = typeof patch === 'function' ? { ...prev, ...patch(prev) } : { ...prev, ...patch }
        formDataRef.current = next
        return next
      })
    }, [])

    // dbTypeOptions = ref([])
    const dbTypeOptionsRef = useRef<DatabaseType[]>([])
    const [dbTypeOptions, setDbTypeOptions] = useState<DatabaseType[]>([])

    // 各类 loading / 状态
    const [uploadLoading, setUploadLoading] = useState(false)
    const [schemaLoading, setSchemaLoading] = useState(false)
    const [testLoading, setTestLoading] = useState(false)
    const connectionTestPassedRef = useRef(false)
    const [connectionTestPassed, setConnectionTestPassed] = useState(false)
    const setConnPassed = (v: boolean) => {
      connectionTestPassedRef.current = v
      setConnectionTestPassed(v)
    }

    // 表单校验错误（对应 el-form 的 prop 校验）
    const [errors, setErrors] = useState<Record<string, string>>({})
    const clearFieldErrors = useCallback((fields: string[]) => {
      setErrors((prev) => {
        const next = { ...prev }
        fields.forEach((f) => delete next[f])
        return next
      })
    }, [])

    // 是否为编辑模式：computed(() => !!props.initialData?.id)
    const isEditMode = useMemo(() => !!initialData?.id, [initialData])

    // computed：当前数据库类型是否为嵌入式数据库（不需要网络连接）
    const isEmbeddedDatabase = useMemo(
      () => ['SQLite', 'DuckDB'].includes(formData.db_type),
      [formData.db_type]
    )

    // 嵌入式数据库的标签和占位符
    const embeddedDbPathLabel = useMemo(() => {
      if (formData.db_type === 'DuckDB') return t('database.connForm.dbFilePathLabel')
      return t('database.connForm.mainDbFilePathLabel')
    }, [formData.db_type, t])

    const embeddedDbPathPlaceholder = useMemo(() => {
      if (formData.db_type === 'DuckDB') return t('database.connForm.duckdbPathPlaceholder')
      return t('database.connForm.sqlitePathPlaceholder')
    }, [formData.db_type, t])

    const embeddedDbPathTip = useMemo(() => {
      if (formData.db_type === 'DuckDB') return t('database.connForm.duckdbPathTip')
      return t('database.connForm.sqlitePathTip')
    }, [formData.db_type, t])

    // computed：当前数据库类型是否支持多Schema
    const supportsMultipleSchemas = useMemo(() => {
      // 优先使用 store 中的值
      if (storeSupportsMultipleSchemas()) {
        return true
      }
      // 从 API 返回的数据库类型配置中获取
      const selectedType = dbTypeOptions.find((item) => item.value === formData.db_type)
      if (selectedType && selectedType.multiple_schema) {
        return selectedType.multiple_schema === 'True'
      }
      return false
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formData.db_type, dbTypeOptions, storeSupportsMultipleSchemas])

    // 计算 supportsMultipleSchemas 的最新值（供 imperative 方法读取）
    const computeSupportsMultipleSchemas = useCallback(() => {
      if (storeSupportsMultipleSchemas()) return true
      const selectedType = dbTypeOptionsRef.current.find((item) => item.value === formDataRef.current.db_type)
      if (selectedType && selectedType.multiple_schema) {
        return selectedType.multiple_schema === 'True'
      }
      return false
    }, [storeSupportsMultipleSchemas])

    // 计算 isEmbeddedDatabase 的最新值
    const computeIsEmbedded = useCallback(
      () => ['SQLite', 'DuckDB'].includes(formDataRef.current.db_type),
      []
    )

    // ===== 上传数据库文件相关 =====
    const handleDatabaseFileUpload = async (file: File) => {
      setUploadLoading(true)
      try {
        const res: any = await uploadDatabaseFileReq(currentProjectId, file)
        if (res.success && res.data) {
          const patch: Record<string, any> = { database: res.data.path }
          // 如果名称为空，用文件名（去掉扩展名）自动填充
          if (!formDataRef.current.name) {
            const fileName = res.data.original_filename || file.name || ''
            patch.name = fileName.replace(/\.(db|sqlite|sqlite3|duckdb)$/i, '')
          }
          patchFormData(patch)
          // 清除表单验证错误状态
          clearFieldErrors(['database', 'name'])
          notifications.show({ color: 'green', message: t('database.connForm.uploadSuccess') })
        }
      } catch (error) {
        console.error('数据库文件上传失败:', error)
      } finally {
        setUploadLoading(false)
      }
    }

    const beforeDatabaseFileUpload = (file: File): boolean => {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        notifications.show({ color: 'red', message: t('database.connForm.invalidFileType') })
        return false
      }
      const maxSize = 500 * 1024 * 1024 // 500MB
      if (file.size > maxSize) {
        notifications.show({ color: 'red', message: t('database.connForm.fileTooLarge') })
        return false
      }
      return true
    }

    // 主数据库文件选择（el-upload 的 before-upload + http-request 串联）
    const onMainDbFileSelect = (file: File | null) => {
      if (!file) return
      if (!beforeDatabaseFileUpload(file)) return
      handleDatabaseFileUpload(file)
    }

    // 附属数据库文件上传
    const handleAttachFileUpload = async (file: File, originalIndex: number) => {
      // 标记该附属库为上传中
      patchFormData((prev) => {
        const list = [...(prev.sqlite_attached_dbs || [])]
        list[originalIndex] = { ...list[originalIndex], _uploading: true }
        return { sqlite_attached_dbs: list }
      })
      try {
        const res: any = await uploadDatabaseFileReq(currentProjectId, file)
        if (res.success && res.data) {
          patchFormData((prev) => {
            const list = [...(prev.sqlite_attached_dbs || [])]
            list[originalIndex] = { ...list[originalIndex], file_path: res.data.path }
            return { sqlite_attached_dbs: list }
          })
          notifications.show({ color: 'green', message: t('database.connForm.uploadSuccess') })
        }
      } catch (error) {
        console.error('附属数据库文件上传失败:', error)
      } finally {
        patchFormData((prev) => {
          const list = [...(prev.sqlite_attached_dbs || [])]
          list[originalIndex] = { ...list[originalIndex], _uploading: false }
          return { sqlite_attached_dbs: list }
        })
      }
    }

    const onAttachFileSelect = (file: File | null, originalIndex: number) => {
      if (!file) return
      if (!beforeDatabaseFileUpload(file)) return
      handleAttachFileUpload(file, originalIndex)
    }

    // 获取数据库类型选项
    const fetchDatabaseTypes = useCallback(async () => {
      const res: any = await supportDatabaseReq(currentProjectId)
      if (res.data && res.data.items) {
        dbTypeOptionsRef.current = res.data.items
        setDbTypeOptions(res.data.items)
      }
    }, [currentProjectId])

    // 获取数据库类型的默认端口（从 API 返回的数据中获取）
    const getDefaultPort = useCallback((dbType: string): string => {
      const dbTypeInfo = dbTypeOptionsRef.current.find((item) => item.value === dbType)
      if (dbTypeInfo && dbTypeInfo.default_port) {
        return String(dbTypeInfo.default_port)
      }
      return ''
    }, [])

    // 更新表单数据（对应 updateFormData）
    const updateFormData = useCallback(() => {
      patchFormData((prev) => {
        const next: Record<string, any> = { ...prev }
        // 保存当前数据库类型，防止被重置
        const currentDbType = next.db_type

        // 只更新确实需要变化的字段，保留用户当前状态
        Object.keys(initialData).forEach((key) => {
          // 跳过数据库类型，如果当前已经有值且新值没有意义
          if (key === 'db_type' && currentDbType && !initialData.db_type) {
            return
          }

          // 对于数组类型，确保不丢失现有数据
          if (key === 'sqlite_attached_dbs') {
            if (Array.isArray(initialData[key])) {
              next[key] = [...initialData[key]]
            }
            return
          }

          // 对于其他字段，只有在新值有意义时才更新
          if (initialData[key] !== undefined && initialData[key] !== null && initialData[key] !== '') {
            next[key] = initialData[key]
          }
        })

        // 反序列化schema_config为前端字段
        if (initialData.schema_config) {
          try {
            const schemaConfig = JSON.parse(initialData.schema_config)
            next.available_schemas = schemaConfig.available_schemas || []
            // 兼容旧格式：如果没有 selected_schemas，使用 available_schemas
            next.selected_schemas = schemaConfig.selected_schemas || schemaConfig.available_schemas || []
          } catch (e) {
            console.warn('解析schema_config失败:', e)
            next.available_schemas = []
            next.selected_schemas = []
          }
        }

        // 反序列化extra_config为前端字段
        if (initialData.extra_config) {
          try {
            const extraConfig = JSON.parse(initialData.extra_config)
            next.retrieval_mode = extraConfig.retrieval_mode || 'table'
            next.table_limit = extraConfig.table_limit || 5
            next.oracle_conn_type = extraConfig.oracle_conn_type || 'service_name'
          } catch (e) {
            console.warn('解析extra_config失败:', e)
            next.retrieval_mode = 'table'
            next.table_limit = 5
            next.oracle_conn_type = 'service_name'
          }
        }

        // 确保所有新增字段都有默认值，防止数据丢失
        if (!Array.isArray(next.available_schemas)) next.available_schemas = []
        if (!Array.isArray(next.selected_schemas)) next.selected_schemas = []
        if (!Array.isArray(next.sqlite_attached_dbs)) next.sqlite_attached_dbs = []
        if (typeof next.retrieval_mode === 'undefined') next.retrieval_mode = 'table'
        if (typeof next.oracle_conn_type === 'undefined') next.oracle_conn_type = 'service_name'

        // 设置默认值
        if (!next.db_type) {
          next.name = ''
          next.db_type = ''
          next.host = ''
          next.port = ''
          next.username = ''
          next.password = ''
          next.database = ''
          next.available_schemas = []
          next.selected_schemas = []
          next.sqlite_attached_dbs = []
        }

        // 设置默认端口
        if (next.db_type && !next.port) {
          next.port = getDefaultPort(next.db_type)
        }

        return next
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialData, patchFormData, getDefaultPort])

    // onMounted：拉取数据库类型后初始化表单数据
    useEffect(() => {
      ;(async () => {
        await fetchDatabaseTypes()
        updateFormData()
      })()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // watch(() => props.initialData, ...)：监听 initialData 变化
    useEffect(() => {
      updateFormData()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialData])

    // watch 关键字段变化，重置测试状态
    useEffect(() => {
      setConnPassed(false)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      formData.host,
      formData.port,
      formData.username,
      formData.password,
      formData.database,
      formData.db_type,
      JSON.stringify(formData.sqlite_attached_dbs)
    ])

    // ===== 数据完整性保护 =====
    const ensureFormDataIntegrity = useCallback(() => {
      patchFormData((prev) => {
        const next: Record<string, any> = { ...prev }
        if (typeof next.default_schema === 'undefined') next.default_schema = ''
        if (!Array.isArray(next.available_schemas)) next.available_schemas = []
        if (typeof next.supports_multiple_schemas === 'undefined') next.supports_multiple_schemas = false
        if (!Array.isArray(next.sqlite_attached_dbs)) next.sqlite_attached_dbs = []

        // 特殊处理嵌入式数据库（SQLite/DuckDB）
        if (next.db_type === 'SQLite') {
          // 确保SQLite有默认schema
          if (!next.default_schema) next.default_schema = 'main'
          // 确保sqlite_attached_dbs包含main数据库
          if (next.database && next.sqlite_attached_dbs.length === 0) {
            next.sqlite_attached_dbs = [
              {
                schema_name: 'main',
                file_path: next.database,
                description: '主数据库文件'
              }
            ]
          }
        }

        // DuckDB 不需要 attached_dbs 配置
        if (next.db_type === 'DuckDB') {
          if (!next.default_schema) next.default_schema = 'main'
        }
        return next
      })
    }, [patchFormData])

    // ===== 表单校验（对应 el-form rules + validate）=====
    const validateForm = useCallback((): boolean => {
      const fd = formDataRef.current
      const embedded = computeIsEmbedded()
      const nextErrors: Record<string, string> = {}

      // name
      if (!fd.name) {
        nextErrors.name = t('database.rules.name')
      } else if (fd.name.length < 2 || fd.name.length > 100) {
        nextErrors.name = t('database.rules.nameLength')
      }

      // database
      if (!fd.database) {
        nextErrors.database =
          fd.db_type === 'Oracle'
            ? fd.oracle_conn_type === 'sid'
              ? t('database.connForm.enterSID')
              : t('database.connForm.enterServiceName')
            : t('database.rules.database')
      }

      // db_type（编辑模式不验证数据库类型）
      if (!fd.id && !fd.db_type) {
        nextErrors.db_type = t('database.rules.type')
      }

      // 网络数据库需要连接字段验证
      if (!embedded) {
        if (!fd.host) nextErrors.host = t('database.rules.host')
        if (!fd.username) nextErrors.username = t('database.rules.username')
        if (!fd.port) nextErrors.port = t('database.rules.port')
      }

      setErrors(nextErrors)
      return Object.keys(nextErrors).length === 0
    }, [computeIsEmbedded, t])

    // ===== 保存数据库连接信息 =====
    const handleSave = useCallback(async () => {
      // 数据保护：确保所有必要字段都存在
      ensureFormDataIntegrity()

      // 在校验前用最新值（ensureFormDataIntegrity 是异步 setState，下面用 ref 读最新；
      // 但 setState 尚未 flush，这里手动按规则保护 main 数据库逻辑已在 ref 之外，
      // 因此先同步补一份完整性到本地副本用于发送）
      const valid = validateForm()
      if (!valid) return

      try {
        const embedded = computeIsEmbedded()
        const fd: Record<string, any> = { ...formDataRef.current }

        // 完整性保护（与 ensureFormDataIntegrity 等价，确保 payload 准确）
        if (typeof fd.default_schema === 'undefined') fd.default_schema = ''
        if (!Array.isArray(fd.available_schemas)) fd.available_schemas = []
        if (typeof fd.supports_multiple_schemas === 'undefined') fd.supports_multiple_schemas = false
        if (!Array.isArray(fd.sqlite_attached_dbs)) fd.sqlite_attached_dbs = []
        if (fd.db_type === 'SQLite') {
          if (!fd.default_schema) fd.default_schema = 'main'
          if (fd.database && fd.sqlite_attached_dbs.length === 0) {
            fd.sqlite_attached_dbs = [
              { schema_name: 'main', file_path: fd.database, description: '主数据库文件' }
            ]
          }
        }
        if (fd.db_type === 'DuckDB') {
          if (!fd.default_schema) fd.default_schema = 'main'
        }

        // 嵌入式数据库（SQLite/DuckDB）: 在保存前自动填充默认的连接参数
        if (embedded) {
          const dbTypeLower = fd.db_type.toLowerCase()
          fd.host = fd.host || dbTypeLower
          fd.username = fd.username || dbTypeLower
          fd.password = fd.password || dbTypeLower
          fd.port = fd.port || '0'
        }

        // 准备发送到后端的数据
        const payload: Record<string, any> = { ...fd }

        // 序列化Schema配置为JSON字符串
        if (computeSupportsMultipleSchemas()) {
          const schemaConfig = {
            selected_schemas:
              fd.selected_schemas.length > 0 ? fd.selected_schemas : fd.available_schemas,
            available_schemas: fd.available_schemas || []
          }
          payload.schema_config = JSON.stringify(schemaConfig)
        } else {
          payload.schema_config = null
        }

        // 序列化扩展配置为JSON字符串
        const extraConfig: Record<string, any> = {
          retrieval_mode: fd.retrieval_mode || 'table',
          table_limit: fd.table_limit || 5,
          // Oracle 配置
          ...(fd.db_type === 'Oracle' && {
            oracle_conn_type: fd.oracle_conn_type || 'service_name'
          })
        }
        payload.extra_config = JSON.stringify(extraConfig)

        // 清理前端专用字段,避免发送到后端
        delete payload.selected_schemas
        delete payload.available_schemas
        delete payload.retrieval_mode
        delete payload.table_limit
        delete payload.oracle_conn_type

        // 清理附属数据库中的运行时字段
        if (payload.sqlite_attached_dbs) {
          payload.sqlite_attached_dbs = payload.sqlite_attached_dbs.map((db: any) => {
            const cleaned = { ...db }
            delete cleaned._uploading
            return cleaned
          })
        }

        // 根据是否有ID决定是创建还是更新
        // 注意：ID 是 UUID 字符串，不是数字
        const isEdit = !!fd.id
        const saveReq = isEdit ? updateDatabaseReq : createDatabaseReq
        const res: any = await saveReq(currentProjectId, payload)

        if (res.success) {
          notifications.show({
            color: 'green',
            message: t(isEdit ? 'database.message.updateSuccess' : 'database.message.saveSuccess')
          })

          // 获取数据库ID（UUID 字符串）
          let databaseId: string | null = null

          if (isEdit) {
            // 编辑模式，使用现有ID
            databaseId = fd.id
          } else {
            // 创建模式，从API响应获取新ID
            if (res.data && res.data.id) {
              databaseId = res.data.id
            } else {
              console.error('API响应中没有找到数据库ID:', res.data)
            }
          }

          console.log('保存成功，数据库ID:', databaseId, '响应数据:', res.data)

          // 发送保存成功事件，并传递数据库ID
          onSaved?.(databaseId)
        }
      } catch (error) {
        // axios 拦截器已经显示了错误消息，这里只记录日志
        console.error('保存数据库连接失败:', error)
      }
    }, [
      ensureFormDataIntegrity,
      validateForm,
      computeIsEmbedded,
      computeSupportsMultipleSchemas,
      currentProjectId,
      onSaved,
      t
    ])

    // ===== 测试连接 =====
    const handleTestConnection = useCallback(async () => {
      const valid = validateForm()
      if (!valid) return

      setTestLoading(true)
      try {
        setStoreLoading(true)
        const fd = formDataRef.current
        // SQLite: 测试连接时自动填充默认的连接参数
        const payload: Record<string, any> = {
          host: fd.host,
          port: fd.port,
          username: fd.username,
          password: fd.password,
          database: fd.database,
          db_type: fd.db_type
        }

        // 编辑模式：传递 connection_id，后端会在密码为空时使用保存的密码
        if (fd.id) {
          payload.connection_id = fd.id
        }

        // 添加Schema相关参数
        if (computeSupportsMultipleSchemas() && fd.available_schemas && fd.available_schemas.length > 0) {
          payload.schema_filter = fd.available_schemas
        }

        // Oracle 配置：将 oracle_conn_type 序列化到 extra_config
        if (fd.db_type === 'Oracle') {
          payload.extra_config = JSON.stringify({
            oracle_conn_type: fd.oracle_conn_type || 'service_name'
          })
        }

        // 添加SQLite ATTACH数据库参数
        if (fd.db_type === 'SQLite' && fd.sqlite_attached_dbs && fd.sqlite_attached_dbs.length > 0) {
          // 清理运行时字段，后端期望的格式是 { schema_name: 'xxx', file_path: 'xxx' }
          payload.sqlite_attached_dbs = fd.sqlite_attached_dbs.map((db: any) => {
            const cleaned = { ...db }
            delete cleaned._uploading
            return cleaned
          })
        }

        // 嵌入式数据库（SQLite/DuckDB）: 自动填充默认的连接参数
        if (computeIsEmbedded()) {
          const dbTypeLower = fd.db_type.toLowerCase()
          payload.host = payload.host || dbTypeLower
          payload.username = payload.username || dbTypeLower
          payload.password = payload.password || dbTypeLower
          payload.port = payload.port || '0'
        }
        const res: any = await testDatabaseConnectionReq(currentProjectId, payload)

        if (res.data.success) {
          notifications.show({ color: 'green', message: t('database.message.connectionSuccess') })
          setConnPassed(true)

          // 使用store处理连接测试结果
          const connectionKey = getConnectionKey(payload)
          handleConnectionTestResponse(connectionKey, res)
        } else {
          // 失败:落库 + 明确弹红色提示(原实现只落库不提示 → 用户看不到失败原因),并卡住保存门
          const failMsg = res.data.message || t('database.message.connectionFailed')
          const connectionKey = getConnectionKey(payload)
          saveConnectionTestResult(connectionKey, { success: false, message: failMsg })
          setConnPassed(false)
          notifications.show({ color: 'red', message: failMsg })
        }
      } catch (error: any) {
        console.error('测试连接失败:', error)
        setConnPassed(false)
        const errMsg = error?.response?.data?.message || error.message || t('database.message.testError')
        setStoreError('connection_test', errMsg)
        notifications.show({ color: 'red', message: errMsg })
      } finally {
        setStoreLoading(false)
        setTestLoading(false)
      }
    }, [
      validateForm,
      computeSupportsMultipleSchemas,
      computeIsEmbedded,
      currentProjectId,
      getConnectionKey,
      handleConnectionTestResponse,
      saveConnectionTestResult,
      setStoreLoading,
      setStoreError,
      t
    ])

    // defineExpose({ handleSave, handleTestConnection, connectionTestPassed })
    useImperativeHandle(
      ref,
      () => ({
        handleSave,
        handleTestConnection,
        connectionTestPassed
      }),
      [handleSave, handleTestConnection, connectionTestPassed]
    )

    // 切换 Schema 选中状态
    const toggleSchema = (schema: string) => {
      patchFormData((prev) => {
        const selected = [...(prev.selected_schemas || [])]
        const index = selected.indexOf(schema)
        if (index > -1) {
          selected.splice(index, 1)
        } else {
          selected.push(schema)
        }
        return { selected_schemas: selected }
      })
    }

    // ===== Schema 列表发现 =====
    // 同步SQLite Schema发现结果
    const syncSQLiteSchemasFromDiscovery = (discoveredSchemas: string[], connectionData: any) => {
      const fd = formDataRef.current
      if (fd.db_type === 'SQLite' && discoveredSchemas.length > 0) {
        console.log('同步Schema发现结果:', discoveredSchemas)

        // 保留用户现有的所有配置，不要覆盖
        const currentAttachedDbs = [...(fd.sqlite_attached_dbs || [])]
        const existingSchemaNames = new Set(currentAttachedDbs.map((db: any) => db.schema_name))

        let hasChanges = false

        // 确保main数据库存在
        if (!existingSchemaNames.has('main')) {
          currentAttachedDbs.push({
            schema_name: 'main',
            file_path: connectionData.database || connectionData.host
          })
          hasChanges = true
        }

        // 为发现的新Schema添加配置，但保留用户已有的配置
        discoveredSchemas.forEach((schemaName) => {
          if (schemaName !== 'main' && !existingSchemaNames.has(schemaName)) {
            // 只添加全新的Schema，不覆盖已有配置
            currentAttachedDbs.push({
              schema_name: schemaName,
              file_path: '' // 用户需要手动填写文件路径
            })
            hasChanges = true
          }
        })

        // 只有在有新Schema时才更新
        if (hasChanges) {
          patchFormData({ sqlite_attached_dbs: currentAttachedDbs })
          console.log('添加新Schema后的附加数据库配置:', currentAttachedDbs)
        } else {
          console.log('没有新Schema需要添加，保持用户现有配置')
        }
      }
    }

    const initializeSQLiteSchemas = () => {
      const fd = formDataRef.current
      if (fd.db_type === 'SQLite') {
        const attachedDbs = [...(fd.sqlite_attached_dbs || [])]
        // 确保main schema存在
        const hasMain = attachedDbs.some((db: any) => db.schema_name === 'main')
        if (!hasMain) {
          attachedDbs.unshift({
            schema_name: 'main',
            file_path: fd.database || fd.host
          })
        }

        // 更新available_schemas
        const availableSchemas = attachedDbs.filter((db: any) => db.schema_name).map((db: any) => db.schema_name)

        // 如果没有选中任何schema，默认选中main
        const selectedSchemas = (fd.selected_schemas || []).length === 0 ? ['main'] : fd.selected_schemas

        patchFormData({
          sqlite_attached_dbs: attachedDbs,
          available_schemas: availableSchemas,
          selected_schemas: selectedSchemas
        })
      }
    }

    // 处理Schema发现结果
    const handleSchemaDiscoveryResult = (discoveryData: any, connectionData: any) => {
      patchFormData({ available_schemas: discoveryData || [] })

      // 如果是SQLite，处理ATTACH数据库配置
      if (connectionData.db_type === 'SQLite') {
        // 同步Schema发现结果到sqlite_attached_dbs
        syncSQLiteSchemasFromDiscovery(discoveryData.schemas || [], connectionData)
        initializeSQLiteSchemas()
      }
    }

    // 获取Schema列表
    const fetchSchemaList = async (connectionData: any) => {
      try {
        // 使用新的Schema发现API
        const schemaRes: any = await discoverSchemasReq(currentProjectId, connectionData)

        if (schemaRes.success && schemaRes.data) {
          handleSchemaDiscoveryResult(schemaRes.data, connectionData)

          const schemaCount = schemaRes.data.schemas?.length || 0
          const successMsg = t('database.connForm.schemasDetected', { count: schemaCount })
          if (schemaRes.data.warnings?.length) {
            notifications.show({ color: 'yellow', message: successMsg + t('database.connForm.hasWarnings') })
          } else if (schemaRes.data.errors?.length) {
            notifications.show({ color: 'yellow', message: successMsg + t('database.connForm.hasErrors') })
          } else {
            notifications.show({ color: 'green', message: successMsg })
          }
        } else {
          console.warn('Schema发现失败:', schemaRes.msg)
        }
      } catch (error) {
        throw error // 抛出错误供调用者处理
      }
    }

    // 手动获取Schema列表
    const handleFetchSchemas = async () => {
      const fd = formDataRef.current
      // 验证必填字段
      const requiredFields = ['host', 'port', 'username', 'database', 'db_type']
      const missingFields: string[] = []

      for (const field of requiredFields) {
        if (!fd[field]) {
          missingFields.push(field)
        }
      }

      if (missingFields.length > 0) {
        notifications.show({ color: 'yellow', message: t('database.connForm.fillConnectionFirst') })
        return
      }

      setSchemaLoading(true)

      try {
        const payload: Record<string, any> = {
          host: fd.host,
          port: fd.port,
          username: fd.username,
          password: fd.password,
          database: fd.database,
          db_type: fd.db_type
        }

        // 编辑模式：传递 connection_id，后端会在密码为空时使用保存的密码
        if (fd.id) {
          payload.connection_id = fd.id
        }

        // Oracle 配置
        if (fd.db_type === 'Oracle') {
          payload.extra_config = JSON.stringify({
            oracle_conn_type: fd.oracle_conn_type || 'service_name'
          })
        }

        await fetchSchemaList(payload)
      } catch (error) {
        console.error('获取Schema列表失败:', error)
      } finally {
        setSchemaLoading(false)
      }
    }

    // 获取仅附加数据库（排除main）
    const getAttachedDbsOnly = () => {
      const attachedDbs: { db: any; originalIndex: number }[] = []
      ;(formData.sqlite_attached_dbs || []).forEach((db: any, originalIndex: number) => {
        if (db.schema_name !== 'main') {
          attachedDbs.push({ db, originalIndex })
        }
      })
      return attachedDbs
    }

    // SQLite附加数据库管理
    const addAttachedDb = () => {
      patchFormData((prev) => ({
        sqlite_attached_dbs: [
          ...(prev.sqlite_attached_dbs || []),
          { schema_name: '', file_path: '', _uploading: false }
        ]
      }))
    }

    const removeAttachedDb = (index: number) => {
      patchFormData((prev) => {
        const list = [...(prev.sqlite_attached_dbs || [])]
        list.splice(index, 1)
        return { sqlite_attached_dbs: list }
      })
    }

    // 处理主数据库文件路径变化（blur）
    const handleMainDbPathChange = () => {
      const fd = formDataRef.current
      if (fd.db_type === 'SQLite' && fd.database) {
        patchFormData((prev) => {
          const list = Array.isArray(prev.sqlite_attached_dbs) ? [...prev.sqlite_attached_dbs] : []
          // 查找 main schema 的索引
          const mainSchemaIndex = list.findIndex((db: any) => db.schema_name === 'main')

          if (mainSchemaIndex >= 0) {
            // 如果 main schema 已存在，更新其文件路径
            list[mainSchemaIndex] = { ...list[mainSchemaIndex], file_path: prev.database }
          } else {
            // 如果 main schema 不存在，添加到数组开头
            list.unshift({ schema_name: 'main', file_path: prev.database })
          }

          // 同步更新 available_schemas
          const availableSchemas = list.filter((db: any) => db.schema_name).map((db: any) => db.schema_name)

          const next: Record<string, any> = {
            sqlite_attached_dbs: list,
            available_schemas: availableSchemas
          }
          // 确保默认 schema 设置为 main
          if (!prev.default_schema) next.default_schema = 'main'
          return next
        })
      }
    }

    // 获取数据库字段标签
    const getDatabaseFieldLabel = () => {
      const labels: Record<string, string> = {
        Oracle: t('database.form.serviceName'),
        default: t('database.form.database')
      }
      return labels[formData.db_type] || labels.default
    }

    // 获取数据库字段占位符
    const getDatabaseFieldPlaceholder = () => {
      const placeholders: Record<string, string> = {
        Oracle: t('database.form.serviceNamePlaceholder'),
        default: t('database.form.databasePlaceholder')
      }
      return placeholders[formData.db_type] || placeholders.default
    }

    const attachedDbsOnly = getAttachedDbsOnly()

    return (
      <div className={styles.connectionForm}>
        <form onSubmit={(e) => e.preventDefault()}>
          {/* 数据库名称 */}
          <TextInput
            data-testid="database-create-name"
            mb="md"
            label={`${t('database.form.name')}${t('database.form.nameHint')}`}
            placeholder={t('database.form.namePlaceholder')}
            value={formData.name}
            onChange={(e) => patchFormData({ name: e.currentTarget.value })}
            error={errors.name}
          />

          {/* 描述 */}
          <Textarea
            data-testid="database-create-description"
            mb="md"
            label={t('database.form.description')}
            placeholder={t('database.form.descriptionPlaceholder')}
            rows={5}
            value={formData.description || ''}
            onChange={(e) => patchFormData({ description: e.currentTarget.value })}
            error={errors.description}
          />

          {!isEditMode && (
            <Select
              data-testid="database-create-type"
              mb="md"
              label={t('database.form.type')}
              placeholder={t('database.form.typePlaceholder')}
              value={formData.db_type}
              data={dbTypeOptions.map((item) => ({
                value: item.value,
                label: t(`database.form.types.${String(item.value || '').toLowerCase()}`, item.label || item.value),
              }))}
              onChange={(v) => {
                const nextType = v || ''
                patchFormData({
                  db_type: nextType,
                  port: getDefaultPort(nextType),
                  host: '',
                  username: '',
                  password: '',
                  database: '',
                  default_schema: ['SQLite', 'DuckDB'].includes(nextType) ? 'main' : '',
                  available_schemas: [],
                  selected_schemas: [],
                  sqlite_attached_dbs: [],
                })
                clearFieldErrors(['db_type', 'database'])
              }}
              error={errors.db_type}
              searchable
              allowDeselect={false}
            />
          )}

          {/* SQLite/DuckDB 嵌入式数据库：路径输入 + 上传按钮 */}
          {isEmbeddedDatabase && (
            <div style={{ marginBottom: 16 }}>
              <div className={styles.pathWithUpload}>
                <TextInput
                  data-testid="database-create-path"
                  className={styles.pathInput}
                  label={embeddedDbPathLabel}
                  placeholder={embeddedDbPathPlaceholder}
                  value={formData.database}
                  onChange={(e) => patchFormData({ database: e.currentTarget.value })}
                  onBlur={handleMainDbPathChange}
                  error={errors.database}
                  style={{ flex: 1 }}
                />
                <div data-testid="database-create-file-upload">
                  <FileButton
                    onChange={onMainDbFileSelect}
                    accept=".db,.sqlite,.sqlite3,.duckdb"
                    disabled={uploadLoading}
                    inputProps={
                      { 'data-testid': 'database-create-file-input' } as InputHTMLAttributes<HTMLInputElement>
                    }
                  >
                    {(fbProps) => (
                      <Button
                        {...fbProps}
                        variant="default"
                        loading={uploadLoading}
                        leftSection={<IconUpload size={14} />}
                        className={styles.inlineUpload}
                        mt={24}
                      >
                        {t('database.connForm.uploadMode')}
                      </Button>
                    )}
                  </FileButton>
                </div>
              </div>
              <div className={styles.formItemTip}>{embeddedDbPathTip}</div>
            </div>
          )}

          {/* 网络数据库需要连接信息 */}
          {!isEmbeddedDatabase && (
            <>
              {/* 主机和端口 */}
              <Group grow align="flex-start" mb="md" gap="md">
                <div style={{ flex: 2 }}>
                  <TextInput
                    label={t('database.form.host')}
                    placeholder={t('database.form.hostPlaceholder')}
                    value={formData.host}
                    onChange={(e) => patchFormData({ host: e.currentTarget.value })}
                    error={errors.host}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextInput
                    label={t('database.form.port')}
                    placeholder={t('database.form.portPlaceholder')}
                    value={formData.port}
                    onChange={(e) => patchFormData({ port: e.currentTarget.value })}
                    error={errors.port}
                  />
                </div>
              </Group>

              {/* 数据库名、用户名、密码 */}
              <Group grow align="flex-start" mb="md" gap="md">
                {/* Oracle: 连接标识类型 + 服务名/SID */}
                {formData.db_type === 'Oracle' ? (
                  <>
                    <Select
                      label={t('database.connForm.connIdentifier')}
                      value={formData.oracle_conn_type}
                      onChange={(v) => patchFormData({ oracle_conn_type: v || 'service_name' })}
                      data={[
                        { value: 'service_name', label: t('database.connForm.serviceName') },
                        { value: 'sid', label: 'SID' }
                      ]}
                      allowDeselect={false}
                    />
                    <TextInput
                      label={formData.oracle_conn_type === 'sid' ? 'SID' : t('database.connForm.serviceName')}
                      placeholder={
                        formData.oracle_conn_type === 'sid'
                          ? t('database.connForm.enterSID')
                          : t('database.connForm.enterServiceName')
                      }
                      value={formData.database}
                      onChange={(e) => patchFormData({ database: e.currentTarget.value })}
                      error={errors.database}
                    />
                  </>
                ) : (
                  <TextInput
                    label={getDatabaseFieldLabel()}
                    placeholder={getDatabaseFieldPlaceholder()}
                    value={formData.database}
                    onChange={(e) => patchFormData({ database: e.currentTarget.value })}
                    error={errors.database}
                  />
                )}
                <TextInput
                  label={t('database.form.username')}
                  placeholder={t('database.form.usernamePlaceholder')}
                  value={formData.username}
                  onChange={(e) => patchFormData({ username: e.currentTarget.value })}
                  error={errors.username}
                />
                <PasswordInput
                  label={t('database.form.password')}
                  placeholder={t('database.form.passwordPlaceholder')}
                  value={formData.password}
                  onChange={(e) => patchFormData({ password: e.currentTarget.value })}
                  error={errors.password}
                />
              </Group>
            </>
          )}

          {/* SQLite 附加数据库配置 */}
          {formData.db_type === 'SQLite' && (
            <>
              <Divider
                my="md"
                label={<span className={styles.dividerLabel}>{t('database.connForm.attachConfig')}</span>}
                labelPosition="center"
              />

              <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
                  {t('database.connForm.attachedDb')}
                </div>
                <div className={styles.sqliteAttachContainer}>
                  {attachedDbsOnly.map((attachDb) => (
                    <div key={attachDb.originalIndex} className={styles.attachDbItem}>
                      <Group align="center" gap="xs" wrap="nowrap">
                        <div style={{ flex: 6 }}>
                          <TextInput
                            placeholder={t('database.connForm.schemaName')}
                            value={attachDb.db.schema_name || ''}
                            onChange={(e) => {
                              const val = e.currentTarget.value
                              patchFormData((prev) => {
                                const list = [...(prev.sqlite_attached_dbs || [])]
                                list[attachDb.originalIndex] = {
                                  ...list[attachDb.originalIndex],
                                  schema_name: val
                                }
                                return { sqlite_attached_dbs: list }
                              })
                            }}
                          />
                        </div>
                        <div style={{ flex: 14 }}>
                          <div className={styles.pathWithUpload}>
                            <TextInput
                              className={styles.pathInput}
                              style={{ flex: 1 }}
                              placeholder={t('database.connForm.dbFilePath')}
                              value={attachDb.db.file_path || ''}
                              onChange={(e) => {
                                const val = e.currentTarget.value
                                patchFormData((prev) => {
                                  const list = [...(prev.sqlite_attached_dbs || [])]
                                  list[attachDb.originalIndex] = {
                                    ...list[attachDb.originalIndex],
                                    file_path: val
                                  }
                                  return { sqlite_attached_dbs: list }
                                })
                              }}
                            />
                            <FileButton
                              onChange={(file) => onAttachFileSelect(file, attachDb.originalIndex)}
                              accept=".db,.sqlite,.sqlite3"
                              disabled={attachDb.db._uploading}
                            >
                              {(fbProps) => (
                                <Button
                                  {...fbProps}
                                  variant="default"
                                  size="xs"
                                  loading={attachDb.db._uploading}
                                  className={styles.inlineUpload}
                                >
                                  <IconUpload size={14} />
                                </Button>
                              )}
                            </FileButton>
                          </div>
                        </div>
                        <div style={{ flex: 4 }}>
                          <Button
                            color="red"
                            variant="subtle"
                            size="xs"
                            onClick={() => removeAttachedDb(attachDb.originalIndex)}
                          >
                            <IconTrash size={14} />
                          </Button>
                        </div>
                      </Group>
                    </div>
                  ))}

                  <Button variant="filled" size="xs" onClick={addAttachedDb} mt="xs">
                    + {t('database.connForm.addAttachedDb')}
                  </Button>

                  <div className={styles.formItemTip} style={{ marginTop: 8 }}>
                    {t('database.connForm.sqliteAttachTip')}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Schema 配置（仅支持多Schema的数据库显示，排除嵌入式数据库） */}
          {supportsMultipleSchemas && !isEmbeddedDatabase && (
            <>
              <Divider
                my="md"
                label={<span className={styles.dividerLabel}>{t('database.connForm.schemaConfig')}</span>}
                labelPosition="center"
              />

              {/* 获取Schema列表按钮 */}
              <div style={{ marginBottom: 16 }}>
                <Button
                  variant="light"
                  size="xs"
                  loading={schemaLoading}
                  onClick={handleFetchSchemas}
                >
                  <svg
                    className={styles.spinIcon}
                    style={{ width: 14, height: 14, marginRight: 4 }}
                    viewBox="0 0 1024 1024"
                  >
                    <path
                      d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"
                      fill="currentColor"
                    />
                    <path
                      d="M686.7 638.6L544.1 535.5V288c0-4.4-3.6-8-8-8h-48c-4.4 0-8 3.6-8 8v275.4c0 2.6 1.2 5 3.3 6.5l165.4 120.6c3.6 2.6 8.6 1.8 11.2-1.7l28.6-39c2.6-3.7 1.8-8.7-1.9-11.2z"
                      fill="currentColor"
                    />
                  </svg>
                  {t('database.connForm.fetchSchemaList')}
                </Button>
                <div className={styles.formItemTip}>{t('database.connForm.fetchSchemaTip')}</div>
              </div>

              {/* 选择要同步的 Schemas */}
              {formData.available_schemas.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <MultiSelect
                    label={t('database.connForm.selectSchema')}
                    placeholder={t('database.connForm.selectSchemaPlaceholder')}
                    data={formData.available_schemas.map((schema: string) => ({ value: schema, label: schema }))}
                    value={formData.selected_schemas}
                    onChange={(vals) => patchFormData({ selected_schemas: vals })}
                    searchable
                    clearable
                    style={{ width: '100%' }}
                  />
                  <div className={styles.formItemTip}>{t('database.connForm.selectSchemaTip')}</div>
                </div>
              )}

              {/* 可用 Schema 展示 */}
              {formData.available_schemas.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
                    {t('database.connForm.availableSchema')}
                  </div>
                  <div>
                    {formData.available_schemas.map((schema: string) => {
                      const selected = formData.selected_schemas.includes(schema)
                      return (
                        <Badge
                          key={schema}
                          color={selected ? 'green' : 'gray'}
                          variant={selected ? 'filled' : 'light'}
                          size="lg"
                          className={styles.schemaTag}
                          onClick={() => toggleSchema(schema)}
                        >
                          {schema}
                        </Badge>
                      )
                    })}
                  </div>
                  <div className={styles.formItemTip}>{t('database.connForm.clickTagTip')}</div>
                </div>
              )}
            </>
          )}

          {/* 召回模式：编辑时显示 */}
          {isEditMode && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
                {t('database.connForm.retrievalMode')}
              </div>
              <div className={styles.retrievalModeContainer}>
                <div className={styles.retrievalModeGroup}>
                  {(['table', 'column'] as const).map((mode) => {
                    const checked = formData.retrieval_mode === mode
                    const title =
                      mode === 'table'
                        ? t('database.connForm.tableRetrieval')
                        : t('database.connForm.columnRetrieval')
                    const desc =
                      mode === 'table'
                        ? t('database.connForm.tableRetrievalDesc')
                        : t('database.connForm.columnRetrievalDesc')
                    return (
                      <div
                        key={mode}
                        className={`${styles.retrievalRadioCard} ${checked ? styles.checked : ''}`}
                        onClick={() => patchFormData({ retrieval_mode: mode })}
                      >
                        <div className={styles.radioContent}>
                          <div className={styles.radioTitle}>{title}</div>
                          <div className={styles.radioDesc}>{desc}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className={styles.retrievalModeTip}>
                  <IconInfoCircleFilled size={14} style={{ marginRight: 4 }} />
                  <span>{t('database.connForm.retrievalModeTip')}</span>
                </div>
              </div>
            </div>
          )}

          {/* 表召回数量：仅在表召回模式下显示 */}
          {isEditMode && formData.retrieval_mode === 'table' && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
                {t('database.connForm.tableLimit')}
              </div>
              <NumberInput
                min={1}
                max={50}
                step={1}
                placeholder={t('database.connForm.tableLimitDefault')}
                value={formData.table_limit}
                onChange={(v) => patchFormData({ table_limit: v })}
                style={{ width: '100%' }}
              />
              <div className={styles.formItemTip}>{t('database.connForm.tableLimitTip')}</div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className={styles.formActions}>
            <Button variant="default" loading={testLoading} onClick={handleTestConnection}>
              <Group gap={4} wrap="nowrap">
                <IconPlugConnected size={16} />
                <span>{t('database.action.testConnection')}</span>
              </Group>
            </Button>
            {!hideSaveButton && (
              <div className={styles.formActionsRight}>
                {/* <Button variant="default" onClick={() => onCancel?.()}>{t('database.action.cancel')}</Button> */}
                <Button data-testid="database-create-save" variant="filled" onClick={handleSave}>
                  {t('database.action.save')}
                </Button>
              </div>
            )}
          </div>
        </form>
      </div>
    )
  }
)

export default DatabaseConnectionForm

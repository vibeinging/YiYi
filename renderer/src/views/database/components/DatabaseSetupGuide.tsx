import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconCheck, IconX } from '@tabler/icons-react'

import GuideStepSelectType from './guide/GuideStepSelectType'
import GuideStepConnection from './guide/GuideStepConnection'
import GuideStepSync from './guide/GuideStepSync'
import GuideStepMetadata from './guide/GuideStepMetadata'
import GuideStepEntity from './guide/GuideStepEntity'
import GuideStepRelationship from './guide/GuideStepRelationship'

import { getCachedTablesReq, getDatabaseDetailReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'

import styles from './DatabaseSetupGuide.module.scss'

export interface DatabaseSetupGuideProps {
  projectId: string
  database?: any
  // 初始步骤，用于从特定步骤开始
  initialStep?: string
  // 可配置的可见步骤列表，如果不提供则显示所有步骤
  visibleStepKeys?: string[] | null
  // defineEmits(['finish', 'back', 'database-created', 'database-updated'])
  onFinish?: (database: any) => void
  onBack?: () => void
  onDatabaseCreated?: (database: any) => void
  onDatabaseUpdated?: (database: any) => void
}

interface StepDef {
  key: string
  label: string
  component: React.ComponentType<any>
}

export default function DatabaseSetupGuide({
  projectId,
  database = null,
  initialStep = 'select-type',
  visibleStepKeys = null,
  onFinish,
  onBack,
  onDatabaseCreated
}: DatabaseSetupGuideProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // 所有步骤定义
  const allSteps = useMemo<StepDef[]>(
    () => [
      { key: 'select-type', label: t('database.guide.steps.selectType'), component: GuideStepSelectType },
      { key: 'connection', label: t('database.guide.steps.connection'), component: GuideStepConnection },
      { key: 'sync', label: t('database.guide.steps.sync'), component: GuideStepSync },
      { key: 'metadata', label: t('database.guide.steps.metadata'), component: GuideStepMetadata },
      { key: 'entity', label: t('database.guide.steps.entity'), component: GuideStepEntity },
      { key: 'relationship', label: t('database.guide.steps.relationship'), component: GuideStepRelationship }
    ],
    [t]
  )

  // 当前数据库信息
  const [currentDatabase, setCurrentDatabase] = useState<any>(null)
  const [currentDatabaseId, setCurrentDatabaseId] = useState<any>(null)

  // 选中的数据库类型信息
  const [selectedDbType, setSelectedDbType] = useState('')
  const [selectedDefaultPort, setSelectedDefaultPort] = useState<any>('')

  // 可见的步骤（根据配置的步骤列表过滤）
  const visibleSteps = useMemo<StepDef[]>(() => {
    return allSteps.filter((step) => {
      // 如果指定了可见步骤列表，只显示列表中的步骤
      if (visibleStepKeys && visibleStepKeys.length > 0) {
        if (!visibleStepKeys.includes(step.key)) {
          return false
        }
      }
      return true
    })
  }, [allSteps, visibleStepKeys])

  // 当前步骤索引（基于 visibleSteps）
  const [currentStepIndex, setCurrentStepIndex] = useState(0)

  // 当前步骤（从 visibleSteps 取）
  const currentStep = useMemo(() => visibleSteps[currentStepIndex], [visibleSteps, currentStepIndex])

  // 当前步骤组件
  const CurrentStepComponent = currentStep?.component

  // 是否是第一步
  const isFirstStep = currentStepIndex === 0

  // 步骤完成状态（用于步骤指示器的点击跳转判断）
  const [stepCompletionStatus, setStepCompletionStatus] = useState<{ sync: boolean; metadata: boolean }>({
    sync: false,
    metadata: false
  })

  // 检查步骤完成状态
  const checkStepCompletion = async (dbId: any = currentDatabaseId) => {
    if (!dbId) {
      setStepCompletionStatus({ sync: false, metadata: false })
      return
    }

    try {
      const res: any = await getCachedTablesReq(currentProjectId, dbId)
      if (res.success && res.data) {
        const tableList = res.data.items || res.data || []
        const syncDone = tableList.length > 0

        let metadataDone = false

        if (tableList.length > 0) {
          let columnsWithDescription = 0
          let tablesWithDescription = 0
          let totalColumns = 0
          let databaseWithDescription = false

          for (const table of tableList) {
            if (table.description && table.description.trim()) {
              tablesWithDescription++
            }
            if (table.column_count !== undefined) {
              totalColumns += table.column_count || 0
            }
            if (table.columns_with_description !== undefined) {
              columnsWithDescription += table.columns_with_description || 0
            }
          }

          try {
            const dbRes: any = await getDatabaseDetailReq(currentProjectId, dbId)
            if (dbRes.success && dbRes.data) {
              databaseWithDescription = !!(dbRes.data.description && dbRes.data.description.trim())
            }
          } catch (error) {
            console.error('获取数据库详情失败:', error)
          }

          const columnDescCompleted = columnsWithDescription === totalColumns && totalColumns > 0
          const tableDescCompleted = tablesWithDescription === tableList.length && tableList.length > 0

          metadataDone = columnDescCompleted && tableDescCompleted && databaseWithDescription
        }

        setStepCompletionStatus({ sync: syncDone, metadata: metadataDone })
      } else {
        setStepCompletionStatus({ sync: false, metadata: false })
      }
    } catch (error) {
      console.error('检查步骤完成状态失败:', error)
      setStepCompletionStatus({ sync: false, metadata: false })
    }
  }

  // 获取步骤在 visibleSteps 中的索引
  const getVisibleStepIndex = (stepKey: string) => {
    return visibleSteps.findIndex((s) => s.key === stepKey)
  }

  // 是否可以跳转到某个步骤（点击步骤指示器时）
  const canGoToStep = (stepKey: string) => {
    const targetIndex = getVisibleStepIndex(stepKey)

    // 允许跳转到当前步骤或之前的步骤
    if (targetIndex <= currentStepIndex) {
      return true
    }

    // sync 及之后的步骤：需要数据库已创建
    if (['sync', 'metadata', 'entity', 'relationship'].includes(stepKey)) {
      if (!currentDatabaseId) {
        return false
      }
    }

    // metadata 及之后的步骤：需要 sync 完成
    if (['metadata', 'entity', 'relationship'].includes(stepKey)) {
      return stepCompletionStatus.sync
    }

    return true
  }

  // 判断步骤是否已锁定
  const isStepLocked = (stepKey: string) => {
    return !canGoToStep(stepKey)
  }

  // 跳转到指定步骤
  const goToStep = (stepKey: string) => {
    const targetIndex = getVisibleStepIndex(stepKey)
    if (targetIndex >= 0) {
      setCurrentStepIndex(targetIndex)
    }
  }

  // 下一步
  const handleNext = () => {
    setCurrentStepIndex((idx) => (idx < visibleSteps.length - 1 ? idx + 1 : idx))
  }

  // 上一步
  const handlePrev = () => {
    setCurrentStepIndex((idx) => (idx > 0 ? idx - 1 : idx))
  }

  // 完成向导
  const handleFinish = () => {
    onFinish?.(currentDatabase)
  }

  // 返回列表（从第一步返回）
  const handleBack = () => {
    onBack?.()
  }

  // 数据库类型选择完成
  const handleTypeSelected = (typeInfo: any) => {
    setSelectedDbType(typeInfo.db_type)
    setSelectedDefaultPort(typeInfo.default_port)
    handleNext()
  }

  // 数据库创建完成
  const handleDatabaseCreated = async (db: any) => {
    setCurrentDatabase(db)
    setCurrentDatabaseId(db.id)
    onDatabaseCreated?.(db)
    // 等价于原 await nextTick() 后 handleNext()
    handleNext()
  }

  // 同步完成
  const handleSyncCompleted = (_result?: any) => {
    checkStepCompletion()
  }

  // 初始化（对应 onMounted）
  useEffect(() => {
    if (database) {
      setCurrentDatabase(database)
      setCurrentDatabaseId(database.id)

      // 根据初始步骤设置当前步骤（在 visibleSteps 中查找）
      const initialIndex = getVisibleStepIndex(initialStep)
      if (initialIndex >= 0) {
        setCurrentStepIndex(initialIndex)
      }

      checkStepCompletion(database.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听 database prop 变化（跳过首次挂载，避免与 onMounted 重复）
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (database) {
      setCurrentDatabase(database)
      setCurrentDatabaseId(database.id)
      checkStepCompletion(database.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database])

  // 监听当前步骤变化，更新完成状态
  useEffect(() => {
    checkStepCompletion()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStepIndex])

  // 监听数据库ID变化，更新完成状态
  useEffect(() => {
    checkStepCompletion()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDatabaseId])

  // 传递给步骤组件的 props（对应 computed stepProps）
  const stepProps = useMemo(() => {
    const baseProps: any = {
      projectId,
      database: currentDatabase,
      databaseId: currentDatabaseId,
      isFirstStep
    }

    // 为连接步骤添加数据库类型信息
    if (currentStep?.key === 'connection') {
      return {
        ...baseProps,
        selectedDbType,
        defaultPort: selectedDefaultPort
      }
    }

    return baseProps
  }, [projectId, currentDatabase, currentDatabaseId, isFirstStep, currentStep, selectedDbType, selectedDefaultPort])

  return (
    <div className={styles['setup-guide']}>
      {/* 关闭按钮 */}
      <div className={styles['guide-close-header']}>
        <button type="button" className={styles['close-button']} onClick={handleBack}>
          <IconX size={18} />
        </button>
      </div>
      {/* 步骤指示器 */}
      <div className={styles['guide-header']}>
        <div className={styles['guide-steps']}>
          {visibleSteps.map((step, index) => {
            const clickable = canGoToStep(step.key)
            const itemClass = [
              styles['step-item'],
              index === currentStepIndex ? styles.active : '',
              index < currentStepIndex ? styles.completed : '',
              isStepLocked(step.key) ? styles.locked : '',
              clickable ? styles.clickable : ''
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <div key={step.key} style={{ display: 'contents' }}>
                <div className={itemClass} onClick={() => clickable && goToStep(step.key)}>
                  <div className={styles['step-number']}>
                    {index < currentStepIndex ? <IconCheck size={16} /> : <span>{index + 1}</span>}
                  </div>
                  <div className={styles['step-label']}>{step.label}</div>
                </div>
                {index < visibleSteps.length - 1 && <div className={styles['step-connector']} />}
              </div>
            )
          })}
        </div>
      </div>

      {/* 步骤内容 */}
      <div className={styles['guide-content']}>
        {CurrentStepComponent && (
          <CurrentStepComponent
            {...stepProps}
            onStepCompleted={handleNext}
            onPrev={handlePrev}
            onFinish={handleFinish}
            onBack={handleBack}
            onTypeSelected={handleTypeSelected}
            onDatabaseCreated={handleDatabaseCreated}
            onSyncCompleted={handleSyncCompleted}
          />
        )}
      </div>
    </div>
  )
}

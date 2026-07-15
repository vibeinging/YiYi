// 项目级模型配置（源：views/project/settings/components/ModelConfig.vue）
// 默认项目用系统级模型（管理员配的主/副/向量单槽）。本页展示当前生效的系统默认模型；
// 点「自定义」复用管理员模型管理 UI 为本项目单独配置（项目级 LLMModel，project_id 命中）。
// 项目级模型优先生效，删除某角色的项目模型即恢复该角色的系统默认。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Badge, Box, Button, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { llmModelsReq } from '@/api/models'
import { getProjectModelsReq } from '@/api/project'
import ElSvgIcon from '@/components/ElSvgIcon'
import ModelManagement from '@/views/models'
import styles from './ModelConfig.module.scss'

interface ModelConfigProps {
  projectId?: string
}

const ROLE_KEYS = ['PRIMARY', 'SECONDARY', 'EMBEDDING'] as const
type RoleKey = (typeof ROLE_KEYS)[number]

type ModelMap = Record<RoleKey, any>
type SourceMap = Record<RoleKey, 'project' | 'system'>

export default function ModelConfig({ projectId = '' }: ModelConfigProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)

  // 展示态 / 编辑态切换；hasProjectCustom：本项目是否已有任意项目级自定义模型
  const [customizing, setCustomizing] = useState(false)
  const [hasProjectCustom, setHasProjectCustom] = useState(false)

  const categoryLabels = useMemo<Record<RoleKey, string>>(
    () => ({
      PRIMARY: t('project.modelConfig.chatModel'),
      SECONDARY: t('project.modelConfig.operatorChatModel'),
      EMBEDDING: t('project.modelConfig.embeddingModel'),
    }),
    [t]
  )

  // 当前实际生效模型（项目自定义优先，否则系统默认）
  const [defaultModels, setDefaultModels] = useState<ModelMap>({
    PRIMARY: null,
    SECONDARY: null,
    EMBEDDING: null,
  })

  // 各角色当前生效模型的来源：'project'（项目自定义）/ 'system'（系统默认）
  const [modelSource, setModelSource] = useState<SourceMap>({
    PRIMARY: 'system',
    SECONDARY: 'system',
    EMBEDDING: 'system',
  })

  // 主标题用显示名，副标题用模型标识（两者不同时才展示模型标识）
  const modelName = (key: RoleKey) => {
    const m = defaultModels[key]
    return m?.display_name || m?.model_name || ''
  }
  const subName = (key: RoleKey) => {
    const m = defaultModels[key]
    return m && m.model_name && m.model_name !== m.display_name ? m.model_name : ''
  }

  // 是否已配置「关闭思考」（extra_config 可能是 JSON 字符串）。新格式 disable_thinking 是布尔，
  // 旧格式是 {enabled, params}，两者都兼容。
  const thinkingDisabled = (key: RoleKey) => {
    const m = defaultModels[key]
    if (!m) return false
    let ec = m.extra_config
    if (typeof ec === 'string') {
      try {
        ec = JSON.parse(ec)
      } catch {
        return false
      }
    }
    // 新格式 thinking={param, value}：value===false 视为已关闭思考（enable_thinking 语义）
    const th = ec && ec.thinking
    if (th && typeof th === 'object' && th.param) return th.value === false
    // 旧格式 disable_thinking：{enabled} 或布尔
    const dt = ec && ec.disable_thinking
    return typeof dt === 'object' && dt !== null ? !!dt.enabled : !!dt
  }

  // 加载每个角色「当前实际生效」的模型：项目自定义优先，否则系统默认。
  // 解析逻辑精确镜像后端 resolve：项目层主/副互为兜底 → 全局默认层主/副互为兜底。
  const loadEffectiveModels = async () => {
    setLoading(true)
    try {
      // 系统级（不传 project_id）
      const [pRes, sRes, eRes] = await Promise.all([
        llmModelsReq({ category: 'PRIMARY', per_page: 100 }),
        llmModelsReq({ category: 'SECONDARY', per_page: 100 }),
        llmModelsReq({ category: 'EMBEDDING', per_page: 100 }),
      ])
      const sys: ModelMap = {
        PRIMARY: pRes.data?.items?.[0] || null,
        SECONDARY: sRes.data?.items?.[0] || null,
        EMBEDDING: eRes.data?.items?.[0] || null,
      }

      // 项目自定义（项目级，按 category 取）
      const proj: ModelMap = { PRIMARY: null, SECONDARY: null, EMBEDDING: null }
      if (projectId) {
        try {
          const projRes = await getProjectModelsReq(projectId, { per_page: 100 })
          const items = projRes.data?.items || []
          setHasProjectCustom(items.length > 0)
          for (const m of items) {
            if (proj[m.category as RoleKey] == null) proj[m.category as RoleKey] = m
          }
        } catch (err) {
          console.error('加载项目自定义模型失败:', err)
        }
      }

      // 单角色独立解析：配了项目模型 → 项目自定义；否则显示该角色自己的系统默认。
      // 不做主/副跨角色兜底展示——只配主模型时，副模型仍按它自己的状态显示（避免“副变成主”的误导）。
      const nextModels: ModelMap = { PRIMARY: null, SECONDARY: null, EMBEDDING: null }
      const nextSource: SourceMap = { PRIMARY: 'system', SECONDARY: 'system', EMBEDDING: 'system' }
      for (const key of ROLE_KEYS) {
        if (proj[key]) {
          nextModels[key] = proj[key]
          nextSource[key] = 'project'
        } else {
          nextModels[key] = sys[key]
          nextSource[key] = 'system'
        }
      }
      setDefaultModels(nextModels)
      setModelSource(nextSource)
    } catch (err) {
      console.error('加载模型失败:', err)
      notifications.show({ color: 'red', message: t('project.modelConfig.loadModelsFailed') })
    } finally {
      setLoading(false)
    }
  }

  const enterCustomize = () => {
    setCustomizing(true)
  }

  const exitCustomize = async () => {
    setCustomizing(false)
    // 退出时刷新：重算各角色实际生效模型 + 来源（可能在编辑态新增/删除了项目模型）
    await loadEffectiveModels()
  }

  useEffect(() => {
    // 展示态始终作为落地页：进来先看各角色当前生效模型 + 来源 + 重置提示，
    // 点「管理」再进编辑态（不自动跳，确保提示在前面页面可见）
    loadEffectiveModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles['model-config']}>
      {/* 编辑态：复用管理员「模型管理」UI，但作用域为本项目（项目级 LLMModel） */}
      {customizing ? (
        <>
          <div className={styles['custom-bar']}>
            <Button
              variant="subtle"
              onClick={exitCustomize}
              leftSection={<ElSvgIcon name="ArrowLeft" size={16} />}
            >
              {t('project.modelConfig.backToSystem')}
            </Button>
          </div>
          <Alert
            color="yellow"
            withCloseButton={false}
            title={t('project.modelConfig.customizingTitle')}
            className={styles['customizing-hint']}
          >
            {t('project.modelConfig.customizingDesc')}
          </Alert>
          <ModelManagement projectId={projectId} showHeader={false} />
        </>
      ) : (
        /* 展示态：当前生效的系统默认模型（只读）+ 自定义入口 */
        <>
          <Alert
            color={hasProjectCustom ? 'yellow' : 'blue'}
            withCloseButton={false}
            title={
              hasProjectCustom
                ? t('project.modelConfig.hasCustomTitle')
                : t('project.modelConfig.adminManagedTitle')
            }
            className={styles['admin-hint']}
          >
            {hasProjectCustom
              ? t('project.modelConfig.customizingDesc')
              : t('project.modelConfig.adminManagedDesc')}
          </Alert>

          <Box className={styles['model-list']} pos="relative">
            <LoadingOverlay visible={loading} />
            {ROLE_KEYS.map((key) => (
              <div key={key} className={styles['model-row']}>
                <div className={styles['role-label']}>{categoryLabels[key]}</div>

                {defaultModels[key] ? (
                  <div className={styles['model-card']}>
                    {/* 名称 + 标签 */}
                    <div className={styles['model-head']}>
                      <span className={styles['model-name']}>{modelName(key)}</span>
                      {subName(key) && <span className={styles['model-id']}>{subName(key)}</span>}
                      <div className={styles['model-tags']}>
                        <Badge
                          size="sm"
                          variant="light"
                          color={modelSource[key] === 'project' ? 'blue' : 'gray'}
                        >
                          {modelSource[key] === 'project'
                            ? t('project.modelConfig.sourceProject')
                            : t('project.modelConfig.sourceSystem')}
                        </Badge>
                        {key === 'EMBEDDING' && defaultModels[key].dimension ? (
                          <Badge size="sm" variant="light" color="gray">
                            {t('project.modelCard.dimension')}: {defaultModels[key].dimension}
                          </Badge>
                        ) : defaultModels[key].supports_streaming ? (
                          <Badge size="sm" variant="light" color="green">
                            {t('project.modelCard.streaming')}
                          </Badge>
                        ) : null}
                        {thinkingDisabled(key) && (
                          <Badge size="sm" variant="light" color="yellow">
                            {t('project.modelConfig.thinkingDisabled')}
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* 详情字段：端点 */}
                    {defaultModels[key].api_base && (
                      <div className={styles['model-meta']}>
                        <div className={styles['meta-item']}>
                          <span className={styles['meta-label']}>
                            {t('project.modelConfig.endpoint')}
                          </span>
                          <span className={styles['meta-value']}>{defaultModels[key].api_base}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  !loading && (
                    <div className={styles['model-empty']}>
                      {t('project.modelConfig.notConfigured')}
                    </div>
                  )
                )}
              </div>
            ))}
          </Box>

          {/* 自定义入口 */}
          <div className={styles['customize-entry']}>
            <Button
              variant="light"
              onClick={enterCustomize}
              leftSection={<ElSvgIcon name="Setting" size={16} />}
            >
              {hasProjectCustom
                ? t('project.modelConfig.manageCustomBtn')
                : t('project.modelConfig.customizeBtn')}
            </Button>
            <span className={styles['customize-hint']}>
              {hasProjectCustom
                ? t('project.modelConfig.hasCustomHint')
                : t('project.modelConfig.customizeHint')}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

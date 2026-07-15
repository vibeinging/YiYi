import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Group,
  NumberInput,
  Switch,
  Tabs,
  Textarea,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import ElSvgIcon from '@/components/ElSvgIcon'
import CodeBlock from './CodeBlock'
import { copyToClipboard } from '@/utils/clipboard'
import {
  getPublishConfig,
  createOrUpdatePublishConfig,
  regenerateApiKey,
  togglePublishStatus
} from '@/api/business_publish'
import styles from './PublishSettings.module.scss'

// 对应 Vue defineProps
interface PublishSettingsProps {
  projectId: string
  businessId: string
}

// 发布配置类型
interface PublishConfig {
  id: string
  is_published: boolean
  server_name: string
  server_description: string
  api_key: string
  api_key_masked: string
  api_key_prefix: string
  rate_limit: number
  total_requests: number
  last_request_at: string | null
}

interface FormData {
  server_name: string
  server_description: string
  rate_limit: number
}

const defaultPublishConfig: PublishConfig = {
  id: '',
  is_published: false,
  server_name: '',
  server_description: '',
  api_key: '',
  api_key_masked: '',
  api_key_prefix: '',
  rate_limit: 100,
  total_requests: 0,
  last_request_at: null
}

export default function PublishSettings({ projectId, businessId }: PublishSettingsProps) {
  const { t } = useTranslation()

  // 状态（reactive → useState）
  const [publishConfig, setPublishConfig] = useState<PublishConfig>({ ...defaultPublishConfig })
  const [formData, setFormData] = useState<FormData>({
    server_name: '',
    server_description: '',
    rate_limit: 100
  })

  const [, setLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toggleLoading, setToggleLoading] = useState(false)
  const [regenerateLoading, setRegenerateLoading] = useState(false)
  const [activeGuideTab, setActiveGuideTab] = useState<string | null>('mcp')
  const [activeCodeTab, setActiveCodeTab] = useState<string | null>('js')
  const [showKeyWarning, setShowKeyWarning] = useState(false)

  // 警告自动关闭定时器
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 计算属性（computed → useMemo）
  const displayKey = useMemo(() => {
    return publishConfig.api_key || publishConfig.api_key_masked || ''
  }, [publishConfig.api_key, publishConfig.api_key_masked])

  const baseUrl = useMemo(() => {
    return window.location.origin
  }, [])

  // 代码示例（computed → useMemo）
  const mcpConfigExample = useMemo(
    () => `{
  "mcpServers": {
    "${formData.server_name || 'my-business-mcp'}": {
      "url": "${baseUrl}/mcp/v1",
      "headers": {
        "X-API-Key": "${publishConfig.api_key || 'YOUR_API_KEY'}"
      }
    }
  }
}`,
    [formData.server_name, baseUrl, publishConfig.api_key]
  )

  const apiExample1 = useMemo(
    () => `curl -X GET "${baseUrl}/api/public/v1/business/info" \\
  -H "X-API-Key: ${publishConfig.api_key || 'YOUR_API_KEY'}"`,
    [baseUrl, publishConfig.api_key]
  )

  const apiExample2 = useMemo(
    () => `curl -X POST "${baseUrl}/api/public/v1/ask" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${publishConfig.api_key || 'YOUR_API_KEY'}" \\
  -d '{
    "question": "${t('project.publish2.chatExampleUser')}",
    "stream": false
  }'`,
    [baseUrl, publishConfig.api_key, t]
  )

  const apiResponseExample = useMemo(
    () => `{
  "success": true,
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "question": "${t('project.publish2.chatExampleUser')}",
    "answer": "${t('project.publish2.sampleAnswer')}",
    "sql": "SELECT SUM(amount) FROM sales WHERE ...",
    "data": {...}
  }
}`,
    [t]
  )

  const apiStreamExample = useMemo(
    () => `curl -X POST "${baseUrl}/api/public/v1/ask" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${publishConfig.api_key || 'YOUR_API_KEY'}" \\
  -d '{
    "question": "${t('project.publish2.sampleTrendQuestion')}",
    "stream": true
  }'`,
    [baseUrl, publishConfig.api_key, t]
  )

  const apiHistoryExample = useMemo(
    () => `curl -X GET "${baseUrl}/api/public/v1/sessions/{session_id}/history" \\
  -H "X-API-Key: ${publishConfig.api_key || 'YOUR_API_KEY'}"`,
    [baseUrl, publishConfig.api_key]
  )

  const jsExample = useMemo(
    () => `const response = await fetch('${baseUrl}/api/public/v1/ask', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': '${publishConfig.api_key || 'YOUR_API_KEY'}'
  },
  body: JSON.stringify({
    question: '${t('project.publish2.chatExampleUser')}',
    stream: false
  })
})

const data = await response.json()
console.log(data)`,
    [baseUrl, publishConfig.api_key, t]
  )

  const pythonExample = useMemo(
    () => `import requests

response = requests.post(
    '${baseUrl}/api/public/v1/ask',
    headers={
        'Content-Type': 'application/json',
        'X-API-Key': '${publishConfig.api_key || 'YOUR_API_KEY'}'
    },
    json={
        'question': '${t('project.publish2.chatExampleUser')}',
        'stream': False
    }
)

data = response.json()
print(data)`,
    [baseUrl, publishConfig.api_key, t]
  )

  const curlExample = useMemo(() => apiExample2, [apiExample2])

  // 方法
  const formatTime = (time: any) => {
    return dayjs(time).format('YYYY-MM-DD HH:mm:ss')
  }

  const loadConfig = async () => {
    if (!projectId || !businessId) {
      setPublishConfig({ ...defaultPublishConfig })
      return
    }
    setLoading(true)
    try {
      const res: any = await getPublishConfig(businessId, projectId)
      if (res.data) {
        setPublishConfig((prev) => ({ ...prev, ...res.data }))
        setFormData({
          server_name: res.data.server_name || '',
          server_description: res.data.server_description || '',
          rate_limit: res.data.rate_limit || 100
        })
      }
    } catch (error) {
      console.error('加载发布配置失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!projectId || !businessId) return
    if (!formData.server_name) {
      notifications.show({ color: 'yellow', message: t('project.publish2.msg.enterServerName') })
      return
    }

    setSaveLoading(true)
    try {
      const res: any = await createOrUpdatePublishConfig(businessId, projectId, formData)

      setPublishConfig((prev) => ({ ...prev, ...res.data }))

      // 如果是首次创建且返回了完整 API Key，显示警告
      if (res.data.api_key && !res.data.api_key_masked) {
        setShowKeyWarning(true)
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
        warningTimerRef.current = setTimeout(() => {
          setShowKeyWarning(false)
        }, 10000)
      }

      notifications.show({ color: 'green', message: t('project.publish2.msg.saveSuccess') })
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message:
          t('project.publish2.msg.saveFailed') +
          ': ' +
          (error.message || t('common.unknownError'))
      })
    } finally {
      setSaveLoading(false)
    }
  }

  const handleTogglePublish = async (value: boolean) => {
    if (!projectId || !businessId) return
    setToggleLoading(true)
    try {
      const res: any = await togglePublishStatus(businessId, projectId, value)
      setPublishConfig((prev) => ({ ...prev, ...res.data }))
      notifications.show({
        color: 'green',
        message: value
          ? t('project.publish2.msg.publishSuccess')
          : t('project.publish2.msg.unpublishSuccess')
      })
    } catch (error: any) {
      // 恢复开关状态
      setPublishConfig((prev) => ({ ...prev, is_published: !value }))
      notifications.show({
        color: 'red',
        message:
          t('project.publish2.msg.toggleFailed') +
          ': ' +
          (error.message || t('common.unknownError'))
      })
    } finally {
      setToggleLoading(false)
    }
  }

  const handleRegenerateKey = () => {
    if (!projectId || !businessId) return
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('project.publish2.msg.regenerateConfirmTitle'),
      children: t('project.publish2.msg.regenerateConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        setRegenerateLoading(true)
        try {
          const res: any = await regenerateApiKey(businessId, projectId)

          setPublishConfig((prev) => ({
            ...prev,
            api_key: res.data.api_key,
            api_key_prefix: res.data.api_key_prefix,
            api_key_masked: ''
          }))

          setShowKeyWarning(true)
          if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
          warningTimerRef.current = setTimeout(() => {
            setShowKeyWarning(false)
          }, 10000)

          notifications.show({ color: 'green', message: t('project.publish2.msg.keyRegenerated') })
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message:
              t('project.publish2.msg.regenerateFailed') +
              ': ' +
              (error.message || t('common.unknownError'))
          })
        } finally {
          setRegenerateLoading(false)
        }
      }
    })
  }

  const handleCopyKey = async () => {
    const key = publishConfig.api_key || publishConfig.api_key_masked
    if (!key) return

    const success = await copyToClipboard(key)
    if (success) {
      notifications.show({ color: 'green', message: t('project.publish2.msg.keyCopied') })
    } else {
      notifications.show({ color: 'red', message: t('common.copyFailed') })
    }
  }

  const generateFullDocumentation = () => {
    return `# ${formData.server_name} ${t('project.publish2.docsTitle')}

## ${t('project.publish2.docsOverview')}

${formData.server_description || t('project.publish2.docsOverviewFallback')}

**Base URL**: ${baseUrl}
**API Key**: ${publishConfig.api_key || 'YOUR_API_KEY'}

---

## ${t('project.publish2.docsMcpIntegration')}

### ${t('project.publish2.step1Title')}

${t('project.publish2.docsEditConfig')}: \`~/Library/Application Support/Claude/claude_desktop_config.json\`

\`\`\`json
${mcpConfigExample}
\`\`\`

### ${t('project.publish2.mcpEndpoints')}

- \`POST /mcp/v1/tools/list\` - ${t('project.publish2.endpointListTools')}
- \`POST /mcp/v1/tools/call\` - ${t('project.publish2.endpointCallTool')}
- \`GET /mcp/v1/server/info\` - ${t('project.publish2.endpointServerInfo')}

---

## REST API

### ${t('project.publish.authTitle')}

${t('project.publish.authDesc')}

\`\`\`
X-API-Key: ${publishConfig.api_key || 'YOUR_API_KEY'}
\`\`\`

### ${t('project.publish.endpointsTitle')}

#### 1. ${t('project.publish2.apiGetBusinessInfo')}

\`\`\`bash
${apiExample1}
\`\`\`

#### 2. ${t('project.publish2.apiQueryNonStream')}

\`\`\`bash
${apiExample2}
\`\`\`

**${t('project.publish2.responseExample')}**

\`\`\`json
${apiResponseExample}
\`\`\`

#### 3. ${t('project.publish2.apiQueryStream')}

\`\`\`bash
${apiStreamExample}
\`\`\`

#### 4. ${t('project.publish2.apiSessionHistory')}

\`\`\`bash
${apiHistoryExample}
\`\`\`

---

## ${t('project.publish2.codeExamples')}

### JavaScript

\`\`\`javascript
${jsExample}
\`\`\`

### Python

\`\`\`python
${pythonExample}
\`\`\`

---

## ${t('project.publish2.rateLimit')}

${t('project.publish2.currentRateLimit')}: ${formData.rate_limit} ${t('project.publish2.requestsPerHour')}

---

${t('project.publish2.generatedAt')}: ${new Date().toLocaleString()}
`
  }

  const handleDownloadDocs = () => {
    // 生成完整文档内容
    const docContent = generateFullDocumentation()

    const blob = new Blob([docContent], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${formData.server_name || 'business'}-api-docs.md`
    a.click()
    URL.revokeObjectURL(url)

    notifications.show({ color: 'green', message: t('project.publish2.msg.docsDownloaded') })
  }

  // 生命周期：onMounted + watch([projectId, businessId], { immediate: true })
  // 合并为对 projectId/businessId 变化的 effect（immediate 等价于挂载即执行）
  useEffect(() => {
    if (projectId && businessId) {
      loadConfig()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, businessId])

  // 卸载时清理警告定时器
  useEffect(() => {
    return () => {
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
    }
  }, [])

  return (
    <div className={styles.publishSettings}>
      {/* 页面标题 */}
      <div className={styles.pageHeader}>
        <h2>{t('project.publish2.title')}</h2>
        <p className={styles.description}>{t('project.publish2.description')}</p>
      </div>

      {/* 发布状态卡片 */}
      <Card className={styles.card} shadow="none" withBorder padding="lg">
        <Card.Section className={styles.rowBC} withBorder inheritPadding py="md">
          <span className={styles.cardTitle}>
            <ElSvgIcon name="Connection" />
            {t('project.publish2.publishStatus')}
          </span>
          <Switch
            checked={publishConfig.is_published}
            onChange={(e) => handleTogglePublish(e.currentTarget.checked)}
            disabled={toggleLoading || !publishConfig.api_key}
            onLabel={t('project.publish2.published')}
            offLabel={t('project.publish2.unpublished')}
          />
        </Card.Section>

        <div className={styles.statusContent} style={{ marginTop: 16 }}>
          {!publishConfig.api_key ? (
            <Alert
              color="yellow"
              withCloseButton={false}
              className={styles.alert}
              title={t('project.publish2.alertConfigFirst')}
            />
          ) : (
            <>
              <Alert
                color={publishConfig.is_published ? 'green' : 'blue'}
                withCloseButton={false}
                className={styles.alert}
                title={
                  publishConfig.is_published
                    ? t('project.publish2.alertPublished')
                    : t('project.publish2.alertUnpublished')
                }
              />

              {publishConfig.is_published && (
                <div className={styles.statsRow}>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>
                      {t('project.publish2.totalRequests')}
                    </span>
                    <span className={styles.statValue}>{publishConfig.total_requests || 0}</span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>
                      {t('project.publish2.lastRequestAt')}
                    </span>
                    <span className={styles.statValue}>
                      {publishConfig.last_request_at
                        ? formatTime(publishConfig.last_request_at)
                        : t('project.publish2.none')}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {/* MCP 服务配置 */}
      <Card className={styles.card} shadow="none" withBorder padding="lg">
        <Card.Section className={styles.rowBC} withBorder inheritPadding py="md">
          <span className={styles.cardTitle}>
            <ElSvgIcon name="Setting" />
            {t('project.publish2.mcpConfig')}
          </span>
          <Button size="xs" onClick={handleSaveConfig} loading={saveLoading}>
            {t('project.publish2.saveConfig')}
          </Button>
        </Card.Section>

        <div style={{ marginTop: 16 }}>
          <TextInput
            label={t('project.publish2.serverName')}
            withAsterisk
            value={formData.server_name}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, server_name: e.currentTarget.value }))
            }
            placeholder={t('project.publish2.serverNamePlaceholder')}
            maxLength={100}
          />
          <div className={styles.formTip}>{t('project.publish2.serverNameTip')}</div>

          <Textarea
            label={t('project.publish2.serverDescription')}
            value={formData.server_description}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, server_description: e.currentTarget.value }))
            }
            rows={3}
            placeholder={t('project.publish2.serverDescriptionPlaceholder')}
            maxLength={500}
            mt="md"
          />

          <div style={{ marginTop: 16 }}>
            <NumberInput
              label={t('project.publish2.rateLimit')}
              min={1}
              max={10000}
              step={10}
              value={formData.rate_limit}
              onChange={(val) =>
                setFormData((prev) => ({ ...prev, rate_limit: Number(val) || 0 }))
              }
              style={{ display: 'inline-block', width: 200 }}
            />
            <span className={`${styles.formTip} ${styles.ml2}`}>
              {t('project.publish2.requestsPerHour')}
            </span>
          </div>
        </div>
      </Card>

      {/* API Key 管理 */}
      <Card className={styles.card} shadow="none" withBorder padding="lg">
        <Card.Section className={styles.rowBC} withBorder inheritPadding py="md">
          <span className={styles.cardTitle}>
            <ElSvgIcon name="Key" />
            {t('project.publish2.apiKeyManagement')}
          </span>
          {publishConfig.api_key_masked && (
            <Button
              color="red"
              size="xs"
              onClick={handleRegenerateKey}
              loading={regenerateLoading}
            >
              {t('project.publish2.regenerateKey')}
            </Button>
          )}
        </Card.Section>

        <div className={styles.apiKeyContent} style={{ marginTop: 16 }}>
          {!publishConfig.api_key && !publishConfig.api_key_masked ? (
            <Alert
              color="blue"
              withCloseButton={false}
              title={t('project.publish2.alertAutoGenerateKey')}
            />
          ) : (
            <>
              <div className={styles.keyDisplay}>
                <label className={styles.keyLabel}>{t('project.publish2.currentApiKey')}</label>
                <Group gap={0} align="flex-end" wrap="nowrap">
                  <TextInput
                    value={displayKey}
                    readOnly
                    className={styles.keyInput}
                    style={{ flex: 1 }}
                  />
                  {publishConfig.api_key && (
                    <Button
                      variant="default"
                      leftSection={<ElSvgIcon name="CopyDocument" />}
                      onClick={handleCopyKey}
                    >
                      {t('common.copy')}
                    </Button>
                  )}
                </Group>
              </div>

              {showKeyWarning && (
                <Alert
                  color="yellow"
                  withCloseButton={false}
                  className={styles.mt3}
                  title={t('project.publish2.keyWarning')}
                />
              )}

              <Alert
                color="red"
                withCloseButton={false}
                className={styles.mt3}
                title={t('project.publish2.regenerateWarning')}
              />
            </>
          )}
        </div>
      </Card>

      {/* 使用指南 */}
      <Card className={styles.card} shadow="none" withBorder padding="lg">
        <Card.Section className={styles.rowBC} withBorder inheritPadding py="md">
          <span className={styles.cardTitle}>
            <ElSvgIcon name="Document" />
            {t('project.publish2.usageGuide')}
          </span>
          <Button
            size="xs"
            leftSection={<ElSvgIcon name="Download" />}
            onClick={handleDownloadDocs}
          >
            {t('project.publish2.downloadDocs')}
          </Button>
        </Card.Section>

        <Tabs value={activeGuideTab} onChange={setActiveGuideTab} mt="md">
          <Tabs.List>
            <Tabs.Tab value="mcp">{t('project.publish2.tabMcp')}</Tabs.Tab>
            <Tabs.Tab value="api">REST API</Tabs.Tab>
          </Tabs.List>

          {/* MCP 协议使用 */}
          <Tabs.Panel value="mcp">
            <div className={styles.guideContent}>
              <h3>{t('project.publish2.mcpWhatTitle')}</h3>
              <p className={styles.guideText}>{t('project.publish2.mcpWhatDesc')}</p>

              <h3>{t('project.publish2.quickStart')}</h3>
              <div className={styles.steps}>
                <div className={styles.step}>
                  <div className={styles.stepNumber}>1</div>
                  <div className={styles.stepContent}>
                    <h4>{t('project.publish2.step1Title')}</h4>
                    <p>
                      {t('project.publish2.step1Desc')}{' '}
                      <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
                    </p>
                    <CodeBlock code={mcpConfigExample} language="json" />
                  </div>
                </div>

                <div className={styles.step}>
                  <div className={styles.stepNumber}>2</div>
                  <div className={styles.stepContent}>
                    <h4>{t('project.publish2.step2Title')}</h4>
                    <p>{t('project.publish2.step2Desc')}</p>
                  </div>
                </div>

                <div className={styles.step}>
                  <div className={styles.stepNumber}>3</div>
                  <div className={styles.stepContent}>
                    <h4>{t('project.publish2.step3Title')}</h4>
                    <p>{t('project.publish2.step3Desc')}</p>
                    <div className={styles.chatExample}>
                      <div className={`${styles.chatBubble} ${styles.user}`}>
                        {t('project.publish2.chatExampleUser')}
                      </div>
                      <div className={`${styles.chatBubble} ${styles.assistant}`}>
                        {/* ElSvgIcon 不支持 className，用 span 承载旋转动画 */}
                        <span className={styles.loadingIcon}>
                          <ElSvgIcon name="Loading" />
                        </span>
                        {t('project.publish2.chatExampleAssistant')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <h3>{t('project.publish2.mcpEndpoints')}</h3>
              <div className={styles.endpointList}>
                <div className={styles.endpointItem}>
                  <span className={styles.method}>POST</span>
                  <code>/mcp/v1/tools/list</code>
                  <span className={styles.desc}>{t('project.publish2.endpointListTools')}</span>
                </div>
                <div className={styles.endpointItem}>
                  <span className={styles.method}>POST</span>
                  <code>/mcp/v1/tools/call</code>
                  <span className={styles.desc}>{t('project.publish2.endpointCallTool')}</span>
                </div>
                <div className={styles.endpointItem}>
                  <span className={styles.method}>GET</span>
                  <code>/mcp/v1/server/info</code>
                  <span className={styles.desc}>{t('project.publish2.endpointServerInfo')}</span>
                </div>
              </div>
            </div>
          </Tabs.Panel>

          {/* REST API 使用 */}
          <Tabs.Panel value="api">
            <div className={styles.guideContent}>
              <h3>{t('project.publish2.apiEndpoints')}</h3>

              <div className={styles.apiSection}>
                <h4>1. {t('project.publish2.apiGetBusinessInfo')}</h4>
                <CodeBlock code={apiExample1} language="bash" />
              </div>

              <div className={styles.apiSection}>
                <h4>2. {t('project.publish2.apiQueryNonStream')}</h4>
                <CodeBlock code={apiExample2} language="bash" />

                <p className={styles.mt3}>
                  <strong>{t('project.publish2.responseExample')}</strong>
                </p>
                <CodeBlock code={apiResponseExample} language="json" />
              </div>

              <div className={styles.apiSection}>
                <h4>3. {t('project.publish2.apiQueryStream')}</h4>
                <p className={styles.guideText}>{t('project.publish2.apiStreamDesc')}</p>
                <CodeBlock code={apiStreamExample} language="bash" />
              </div>

              <div className={styles.apiSection}>
                <h4>4. {t('project.publish2.apiSessionHistory')}</h4>
                <CodeBlock code={apiHistoryExample} language="bash" />
              </div>

              <h3>{t('project.publish2.codeExamples')}</h3>
              <Tabs
                value={activeCodeTab}
                onChange={setActiveCodeTab}
                variant="outline"
                className={styles.codeTabs}
              >
                <Tabs.List>
                  <Tabs.Tab value="js">JavaScript</Tabs.Tab>
                  <Tabs.Tab value="py">Python</Tabs.Tab>
                  <Tabs.Tab value="curl">cURL</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="js" pt="md">
                  <CodeBlock code={jsExample} language="javascript" />
                </Tabs.Panel>
                <Tabs.Panel value="py" pt="md">
                  <CodeBlock code={pythonExample} language="python" />
                </Tabs.Panel>
                <Tabs.Panel value="curl" pt="md">
                  <CodeBlock code={curlExample} language="bash" />
                </Tabs.Panel>
              </Tabs>
            </div>
          </Tabs.Panel>
        </Tabs>
      </Card>
    </div>
  )
}

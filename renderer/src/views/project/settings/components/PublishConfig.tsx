import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Accordion, Badge, Button, Table, Tabs } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { copyToClipboard } from '@/utils/clipboard'
import { mapFrontendOriginToBackendOrigin } from '@/utils/url-helper'
import ApiKeyManagement from './ApiKeyManagement'
import styles from './PublishConfig.module.scss'

interface PublishConfigProps {
  projectId: string
  businessId: string
}

export default function PublishConfig({ projectId, businessId }: PublishConfigProps) {
  const { t } = useTranslation()

  const [activeDocTab, setActiveDocTab] = useState<string>('keys')
  const [activeApiExamples, setActiveApiExamples] = useState<string[]>(['ask'])

  // API base URL (based on current environment)
  const apiBaseUrl = useMemo(() => {
    const baseUrl = mapFrontendOriginToBackendOrigin(window.location.origin)
    return `${baseUrl}/api/public/businesses/${businessId}`
  }, [businessId])

  // Ask interface parameters
  const askParams = useMemo(
    () => [
      { name: 'question', type: 'string', required: true, description: t('project.publish.askParamQuestion') },
      { name: 'session_id', type: 'string', required: false, description: t('project.publish.askParamSessionId') },
      { name: 'stream', type: 'boolean', required: false, description: t('project.publish.askParamStream') }
    ],
    [t]
  )

  // Sessions interface parameters
  const sessionsParams = useMemo(
    () => [
      { name: 'page', type: 'integer', required: false, description: t('project.publish.sessionsParamPage') },
      { name: 'per_page', type: 'integer', required: false, description: t('project.publish.sessionsParamPerPage') },
      { name: 'order_by', type: 'string', required: false, description: t('project.publish.sessionsParamOrderBy') },
      { name: 'order_desc', type: 'boolean', required: false, description: t('project.publish.sessionsParamOrderDesc') }
    ],
    [t]
  )

  // MCP 配置示例
  const mcpConfig = useMemo(() => {
    const serverUrl = mapFrontendOriginToBackendOrigin(window.location.origin)
    return `{
  "mcpServers": {
    "yiw-${businessId}": {
      "command": "npx",
      "args": [
        "-y",
        "@yiw/mcp-server"
      ],
      "env": {
        "SERVER_URL": "${serverUrl}",
        "API_KEY": "your_api_key_here",
        "BUSINESS_ID": "${businessId}"
      }
    }
  }
}`
  }, [businessId])

  // 认证头示例
  const authHeader = useMemo(() => {
    return `X-API-Key: your_api_key_here`
  }, [])

  // Ask API 示例
  const askApiExample = useMemo(() => {
    return `curl -X POST '${apiBaseUrl}/ask' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: your_api_key_here' \\
  -d '{
    "question": "${t('project.publish.chatExampleQuery')}",
    "session_id": "optional_session_id"
  }'`
  }, [apiBaseUrl, t])

  // Ask response example
  const askResponseExample = useMemo(() => {
    return `{
  "success": true,
  "message": "${t('project.publish.responseSuccess')}",
  "data": {
    "session_id": "06950f01-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "answer": "${t('project.publish.responseAnswer')}",
    "sql": "SELECT ...",
    "chart_config": { ... }
  }
}`
  }, [t])

  // Sessions API 示例
  const sessionsApiExample = useMemo(() => {
    return `curl -X GET '${apiBaseUrl}/sessions?page=1&per_page=10' \\
  -H 'X-API-Key: your_api_key_here'`
  }, [apiBaseUrl])

  // Session 详情示例
  const sessionDetailExample = useMemo(() => {
    return `curl -X GET '${apiBaseUrl}/sessions/06950f01-xxxx-xxxx' \\
  -H 'X-API-Key: your_api_key_here'`
  }, [apiBaseUrl])

  // 删除 Session 示例
  const deleteSessionExample = useMemo(() => {
    return `curl -X DELETE '${apiBaseUrl}/sessions/06950f01-xxxx-xxxx' \\
  -H 'X-API-Key: your_api_key_here'`
  }, [apiBaseUrl])

  // Copy text
  const copyText = async (text: string) => {
    const success = await copyToClipboard(text)
    if (success) {
      notifications.show({ color: 'green', message: t('project.publish.copySuccess') })
    } else {
      notifications.show({ color: 'red', message: t('project.publish.copyFailed') })
    }
  }

  // 请求参数表格(askParams / sessionsParams 复用)
  const renderParamsTable = (params: Array<{ name: string; type: string; required: boolean; description: string }>) => (
    <div className={styles.paramsTable}>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 150 }}>{t('project.publish.paramName')}</Table.Th>
            <Table.Th style={{ width: 100 }}>{t('project.publish.paramType')}</Table.Th>
            <Table.Th style={{ width: 80 }}>{t('project.publish.paramRequired')}</Table.Th>
            <Table.Th>{t('project.publish.paramDesc')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {params.map((row) => (
            <Table.Tr key={row.name}>
              <Table.Td>{row.name}</Table.Td>
              <Table.Td>{row.type}</Table.Td>
              <Table.Td>
                <Badge color={row.required ? 'red' : 'gray'} size="sm" variant="light">
                  {row.required ? t('project.publish.yes') : t('project.publish.no')}
                </Badge>
              </Table.Td>
              <Table.Td>{row.description}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  )

  return (
    <div className={styles.publishConfig}>
      {/* API Doc Tabs */}
      <div className={styles.docWrapper}>
        <Tabs value={activeDocTab} onChange={(v) => setActiveDocTab(v || 'keys')} className={styles.docTabs}>
          <Tabs.List>
            <Tabs.Tab value="keys">{t('project.publish.tabApiKeys')}</Tabs.Tab>
            <Tabs.Tab value="mcp">{t('project.publish.tabMcp')}</Tabs.Tab>
            <Tabs.Tab value="rest">{t('project.publish.tabRest')}</Tabs.Tab>
          </Tabs.List>

          {/* API Key Management */}
          <Tabs.Panel value="keys" pt="md">
            <ApiKeyManagement projectId={projectId} businessId={businessId} />
          </Tabs.Panel>

          {/* MCP Interface */}
          <Tabs.Panel value="mcp" pt="md">
            <div className={styles.docContent}>
              <div className={styles.docSection}>
                <h4>{t('project.publish.mcpAccessMethod')}</h4>
                <p>{t('project.publish.mcpAccessDesc')}</p>
                <div className={styles.codeBlock}>
                  <Button
                    className={styles.copyBtn}
                    size="xs"
                    leftSection={<ElSvgIcon name="CopyDocument" size={14} />}
                    onClick={() => copyText(mcpConfig)}
                  >
                    {t('project.publish.copy')}
                  </Button>
                  <pre>
                    <code>{mcpConfig}</code>
                  </pre>
                </div>
              </div>
              <div className={styles.docSection}>
                <h4>{t('project.publish.mcpConfigDesc')}</h4>
                <ul>
                  <li>
                    <code>server_url</code>: {t('project.publish.mcpServerUrl')}
                  </li>
                  <li>
                    <code>api_key</code>: {t('project.publish.mcpApiKey')}
                  </li>
                  <li>
                    <code>business_id</code>: {t('project.publish.mcpBusinessId')}{' '}
                    <code className={styles.highlight}>{businessId}</code>
                  </li>
                </ul>
              </div>
            </div>
          </Tabs.Panel>

          {/* REST API Interface */}
          <Tabs.Panel value="rest" pt="md">
            <div className={styles.docContent}>
              <div className={styles.docSection}>
                <h4>{t('project.publish.restBaseUrl')}</h4>
                <div className={styles.codeBlock}>
                  <Button
                    className={styles.copyBtn}
                    size="xs"
                    leftSection={<ElSvgIcon name="CopyDocument" size={14} />}
                    onClick={() => copyText(apiBaseUrl)}
                  >
                    {t('project.publish.copy')}
                  </Button>
                  <pre>
                    <code>{apiBaseUrl}</code>
                  </pre>
                </div>
              </div>

              <div className={styles.docSection}>
                <h4>{t('project.publish.restAuth')}</h4>
                <p>{t('project.publish.restAuthDesc')}</p>
                <div className={styles.codeBlock}>
                  <Button
                    className={styles.copyBtn}
                    size="xs"
                    leftSection={<ElSvgIcon name="CopyDocument" size={14} />}
                    onClick={() => copyText(authHeader)}
                  >
                    {t('project.publish.copy')}
                  </Button>
                  <pre>
                    <code>{authHeader}</code>
                  </pre>
                </div>
              </div>

              <div className={styles.docSection}>
                <h4>{t('project.publish.restApiList')}</h4>
                <Accordion
                  multiple
                  value={activeApiExamples}
                  onChange={setActiveApiExamples}
                  className={styles.apiList}
                >
                  {/* Data Query Interface */}
                  <Accordion.Item value="ask">
                    <Accordion.Control>{t('project.publish.askTitle')}</Accordion.Control>
                    <Accordion.Panel>
                      <div className={styles.apiExample}>
                        <p className={styles.desc}>{t('project.publish.askDesc')}</p>

                        <h5>{t('project.publish.requestParams')}</h5>
                        {renderParamsTable(askParams)}

                        <h5>{t('project.publish.requestExample')}</h5>
                        <div className={styles.codeExample}>
                          <pre>{askApiExample}</pre>
                          <Button size="xs" onClick={() => copyText(askApiExample)}>
                            {t('project.publish.copy')}
                          </Button>
                        </div>

                        <h5>{t('project.publish.responseExample')}</h5>
                        <div className={styles.codeExample}>
                          <pre>{askResponseExample}</pre>
                          <Button size="xs" onClick={() => copyText(askResponseExample)}>
                            {t('project.publish.copy')}
                          </Button>
                        </div>
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>

                  {/* Session List Interface */}
                  <Accordion.Item value="sessions">
                    <Accordion.Control>{t('project.publish.sessionsTitle')}</Accordion.Control>
                    <Accordion.Panel>
                      <div className={styles.apiExample}>
                        <p className={styles.desc}>{t('project.publish.sessionsDesc')}</p>

                        <h5>{t('project.publish.requestParams')}</h5>
                        {renderParamsTable(sessionsParams)}

                        <h5>{t('project.publish.requestExample')}</h5>
                        <div className={styles.codeExample}>
                          <pre>{sessionsApiExample}</pre>
                          <Button size="xs" onClick={() => copyText(sessionsApiExample)}>
                            {t('project.publish.copy')}
                          </Button>
                        </div>
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>

                  {/* Session Detail Interface */}
                  <Accordion.Item value="session-detail">
                    <Accordion.Control>{t('project.publish.sessionDetailTitle')}</Accordion.Control>
                    <Accordion.Panel>
                      <div className={styles.apiExample}>
                        <p className={styles.desc}>{t('project.publish.sessionDetailDesc')}</p>

                        <h5>{t('project.publish.requestExample')}</h5>
                        <div className={styles.codeExample}>
                          <pre>{sessionDetailExample}</pre>
                          <Button size="xs" onClick={() => copyText(sessionDetailExample)}>
                            {t('project.publish.copy')}
                          </Button>
                        </div>
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>

                  {/* Delete Session Interface */}
                  <Accordion.Item value="delete-session">
                    <Accordion.Control>{t('project.publish.deleteSessionTitle')}</Accordion.Control>
                    <Accordion.Panel>
                      <div className={styles.apiExample}>
                        <p className={styles.desc}>{t('project.publish.deleteSessionDesc')}</p>

                        <h5>{t('project.publish.requestExample')}</h5>
                        <div className={styles.codeExample}>
                          <pre>{deleteSessionExample}</pre>
                          <Button size="xs" onClick={() => copyText(deleteSessionExample)}>
                            {t('project.publish.copy')}
                          </Button>
                        </div>
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              </div>
            </div>
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>
  )
}

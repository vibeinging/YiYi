import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './ModelTestResult.module.scss'

export interface ModelTestResultProps {
  result?: any
  showResult?: boolean
  category?: string
  // defineEmits(['copy-raw-response']) → 回调 prop
  onCopyRawResponse?: (rawResponse: any) => void
}

export default function ModelTestResult({
  result = null,
  showResult = false,
  category = 'PRIMARY',
  onCopyRawResponse,
}: ModelTestResultProps) {
  const { t } = useTranslation()

  // el-tag type → Mantine Badge color
  const tagTypeColorMap: Record<string, string> = {
    success: 'green',
    warning: 'yellow',
    danger: 'red',
    info: 'gray',
    primary: 'blue',
  }

  const getTagType = (testResult: any) => {
    if (testResult.success) return 'success'
    switch (testResult.test_type) {
      case 'format_error':
        return 'warning'
      case 'connection_error':
        return 'danger'
      case 'config_validation':
        return 'info'
      default:
        return 'danger'
    }
  }

  const getTypeText = (testType: string) => {
    const typeTexts: Record<string, string> = {
      config_validation: t('models.test.typeConfigValidation'),
      connection_test: t('models.test.typeConnectionTest'),
      // 后端实际返回 llm_test / embedding_test（embed.py），均属连接测试
      llm_test: t('models.test.typeConnectionTest'),
      embedding_test: t('models.test.typeConnectionTest'),
      format_error: t('models.test.typeFormatError'),
      connection_error: t('models.test.typeConnectionError'),
      request_error: t('models.test.typeRequestError'),
    }
    return typeTexts[testType] || t('models.test.typeUnknown')
  }

  const copyRawResponse = async () => {
    if (!result || !result.raw_response) return
    onCopyRawResponse?.(result.raw_response)
  }

  if (!showResult || !result) return null

  return (
    <div className={styles.testResult}>
      <div className={`${styles.resultCard} ${result.success ? styles.success : styles.error}`}>
        <div className={styles.resultHeader}>
          <span className={styles.resultIcon}>
            <ElSvgIcon name={result.success ? 'SuccessFilled' : 'CircleCloseFilled'} size={20} />
          </span>
          <span className={styles.resultTitle}>
            {result.success ? t('models.test.success') : t('models.test.failure')}
          </span>
          <Badge
            className={styles.headerTag}
            size="sm"
            color={tagTypeColorMap[getTagType(result)] || 'gray'}
          >
            {getTypeText(result.test_type)}
          </Badge>
        </div>

        <div className={styles.resultContent}>
          <div className={styles.resultMessage}>{result.message}</div>

          {/* 成功时显示响应预览 */}
          {result.success && result.response_preview && (
            <div className={styles.responsePreview}>
              <div className={styles.previewHeader}>
                <ElSvgIcon name="Document" size={16} />
                <span>{t('models.test.responsePreview')}</span>
                <Badge className={styles.headerTag} size="sm" color="gray">
                  {result.response_length} {t('models.test.chars')}
                </Badge>
              </div>
              <div className={styles.previewContent}>{result.response_preview}</div>
            </div>
          )}

          {/* Embedding测试结果显示向量信息 */}
          {result.success &&
            result.test_type === 'embedding_test' &&
            result.vector_preview && (
              <div className={styles.vectorInfo}>
                <div className={styles.vectorHeader}>
                  <span className={styles.vectorHeaderIcon}>
                    <ElSvgIcon name="DataAnalysis" size={16} />
                  </span>
                  <span>{t('models.test.vectorInfo')}</span>
                  <Badge className={styles.headerTag} size="sm" color="gray">
                    {result.dimension} {t('models.test.dimensions')}
                  </Badge>
                </div>
                <div className={styles.vectorContent}>
                  <div className={styles.vectorPreview}>
                    <div className={styles.previewLabel}>
                      {t('models.test.vectorPreview')}:
                    </div>
                    <div className={styles.vectorValues}>
                      {result.vector_preview
                        .map((v: number) => v.toFixed(4))
                        .join(', ')}
                    </div>
                  </div>
                </div>
              </div>
            )}

          {/* 显示原始响应数据（格式问题时） */}
          {result.raw_response && (
            <div className={styles.rawResponse}>
              <div className={styles.rawHeader}>
                <ElSvgIcon name="Files" size={16} />
                <span>{t('models.test.rawResponse')}</span>
                <Button
                  className={styles.headerBtn}
                  size="compact-xs"
                  variant="subtle"
                  color="blue"
                  leftSection={<ElSvgIcon name="DocumentCopy" size={14} />}
                  onClick={copyRawResponse}
                >
                  {t('common.copy')}
                </Button>
              </div>
              <div className={styles.rawContent}>
                <pre>{result.raw_response}</pre>
              </div>
            </div>
          )}

          {/* 失败时显示错误详情 */}
          {!result.success && result.error_details && (
            <div className={styles.errorDetails}>
              <div className={styles.detailsHeader}>
                <ElSvgIcon name="Warning" size={16} />
                <span>
                  {result.format_issue
                    ? t('models.test.formatErrorDetails')
                    : t('models.test.errorDetails')}
                </span>
              </div>
              <div className={styles.detailsContent}>{result.error_details}</div>

              {/* 格式错误的修复建议 */}
              {result.format_issue && (
                <div className={styles.formatSuggestions}>
                  <div className={styles.suggestionsHeader}>
                    <ElSvgIcon name="InfoFilled" size={16} />
                    <span>{t('models.test.fixSuggestions')}</span>
                  </div>
                  <div className={styles.suggestionsContent}>
                    <p>
                      <strong>{t('models.test.possibleSolutions')}</strong>
                    </p>
                    <ul>
                      <li>{t('models.test.checkApiUrl')}</li>
                      {result.raw_response && (
                        <li>
                          <strong>{t('models.test.checkRawResponse')}</strong>
                        </li>
                      )}
                      <li>{t('models.test.confirmFormat')}</li>
                      {category === 'PRIMARY' && (
                        <li>
                          {t('models.test.chatFormatHint')}
                          <br />
                          • OpenAI:{' '}
                          <code>{'{"choices": [{"message": {"content": "text"}}]}'}</code>
                          <br />
                          • Ollama: <code>{'{"response": "text"}'}</code>
                          <br />
                          • Simple: <code>{'{"content": "text"}'}</code> /{' '}
                          <code>{'{"text": "text"}'}</code>
                        </li>
                      )}
                      {category === 'EMBEDDING' && (
                        <li>
                          {t('models.test.embeddingFormatHint')}
                          <br />
                          • OpenAI:{' '}
                          <code>{'{"data": [{"embedding": [0.1, 2, ...]}]}'}</code>
                          <br />
                          • Ollama: <code>{'{"embedding": [0.1, 2, ...]}'}</code>
                          <br />
                          • Simple: <code>{'{"embedding": [0.1, 2, ...]}'}</code> /{' '}
                          <code>{'{"vector": [0.1, 2, ...]}'}</code>
                        </li>
                      )}
                      <li>{t('models.test.trySwitchCustom')}</li>
                      {result.raw_response && <li>{t('models.test.adjustApiFormat')}</li>}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

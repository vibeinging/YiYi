import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  Button,
  Center,
  LoadingOverlay,
  Modal,
  NumberInput,
  Progress,
  Text,
  Textarea,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconColumns3, IconListSearch, IconSearch, IconTable, IconTargetArrow } from '@tabler/icons-react'
import { formatTableDisplayName } from '@/utils/tableDisplay'
import styles from './SchemaRetrievalTestDialog.module.scss'

interface SchemaRetrievalTestDialogProps {
  opened: boolean
  title: string
  queryPlaceholder: string
  onClose: () => void
  onSearch: (question: string, topK: number) => Promise<any>
}

interface NormalizedColumn {
  column_name: string
  data_type?: string
  description?: string
  [key: string]: any
}

interface NormalizedResult {
  id: string
  schema_name: string
  table_name: string
  displayName: string
  description: string
  similarity: number | null
  retrieval_method: string
  methods: string[]
  columns: NormalizedColumn[]
  raw: any
}

const isRecord = (value: any): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const toFiniteNumber = (value: any): number | null => {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const clampScore = (score: number | null) => {
  if (score == null) return 0
  return Math.min(100, Math.max(0, score * 100))
}

const normalizeMethods = (value: any): string[] => {
  const raw = String(value || '').trim()
  if (!raw) return ['unknown']
  const methods = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return methods.length ? methods : ['unknown']
}

const normalizeColumns = (value: any): NormalizedColumn[] => {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return { column_name: item }
    }
    if (!isRecord(item)) {
      return { column_name: `column_${index + 1}` }
    }
    return {
      ...item,
      column_name: item.column_name || item.name || item.field_name || item.field || `column_${index + 1}`,
      data_type: item.data_type || item.type || item.column_type || '',
      description: item.description || item.comment || item.column_comment || ''
    }
  })
}

const normalizeSimilarity = (row: Record<string, any>, tableInfo: Record<string, any>) => {
  const direct = toFiniteNumber(row.similarity ?? row.score ?? tableInfo.similarity ?? tableInfo.score)
  if (direct != null) return direct

  const distance = toFiniteNumber(row.distance ?? tableInfo.distance)
  if (distance != null) return Math.max(0, Math.min(1, 1 - distance))

  return null
}

const normalizeResult = (row: any, index: number): NormalizedResult => {
  const source = isRecord(row) ? row : {}
  const tableInfo = isRecord(source.table_info) ? source.table_info : isRecord(source.table) ? source.table : source
  const schemaName = String(tableInfo.schema_name || source.schema_name || '').trim()
  const tableName = String(
    tableInfo.table_name || tableInfo.name || source.table_name || source.name || source.table || '-'
  ).trim()
  const columns = normalizeColumns(source.columns || source.matched_columns || tableInfo.columns)
  const methods = normalizeMethods(source.retrieval_method || tableInfo.retrieval_method || source.method)
  const id = String(tableInfo.id || source.table_id || source.id || `${schemaName || 'schema'}-${tableName}-${index}`)

  return {
    id,
    schema_name: schemaName,
    table_name: tableName || '-',
    displayName: formatTableDisplayName({ schema_name: schemaName, table_name: tableName }) || tableName || '-',
    description: String(source.description || tableInfo.description || source.table_description || '').trim(),
    similarity: normalizeSimilarity(source, tableInfo),
    retrieval_method: methods.join(','),
    methods,
    columns,
    raw: row
  }
}

const extractItems = (data: any) => {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.rows)) return data.rows
  return []
}

export default function SchemaRetrievalTestDialog({
  opened,
  title,
  queryPlaceholder,
  onClose,
  onSearch
}: SchemaRetrievalTestDialogProps) {
  const { t } = useTranslation()
  const [question, setQuestion] = useState('')
  const [topK, setTopK] = useState<number>(5)
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [results, setResults] = useState<NormalizedResult[]>([])

  const bestScore = useMemo(() => {
    const scores = results.map((item) => item.similarity).filter((score): score is number => score != null)
    return scores.length ? Math.max(...scores) : null
  }, [results])

  const methodStats = useMemo<Record<string, number>>(() => {
    const stats: Record<string, number> = {}
    results.forEach((item) => {
      item.methods.forEach((method) => {
        stats[method] = (stats[method] || 0) + 1
      })
    })
    return {
      ...stats,
      mixed: results.filter((item) => item.methods.length > 1).length
    }
  }, [results])

  const scoreText = (score: number | null) => (score == null ? '-' : `${(score * 100).toFixed(1)}%`)
  const resultCountText = hasSearched ? String(results.length) : '-'
  const bestScoreText = hasSearched ? scoreText(bestScore) : '-'

  const getMethodText = (method: string) => {
    if (method === 'vector') return t('unstructuredData.search.methodVector')
    if (method === 'keyword') return t('unstructuredData.search.methodKeyword')
    if (method === 'high_recall') return t('database.retrievalTest.highPriorityLabel')
    if (method === 'relationship_expansion') return t('database.retrievalTest.relationshipExpansion')
    if (method === 'entity') return t('database.retrievalTest.entityRecall')
    if (method === 'unknown') return t('database.retrievalTest.unknownMethod')
    return method
  }

  const getMethodClass = (method: string) => {
    if (method === 'vector') return styles.methodPillVector
    if (method === 'high_recall') return styles.methodPillHigh
    if (method === 'relationship_expansion') return styles.methodPillRelationship
    if (method === 'entity') return styles.methodPillEntity
    if (method === 'keyword') return styles.methodPillKeyword
    return styles.methodPillUnknown
  }

  const handleSearch = async () => {
    const trimmed = question.trim()
    if (!trimmed) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.search.inputRequired') })
      return
    }

    setSearching(true)
    try {
      const res: any = await onSearch(trimmed, topK)
      if (res?.success) {
        const list = extractItems(res.data).map(normalizeResult)
        setResults(list)
        setHasSearched(true)
        if (!list.length) {
          notifications.show({ color: 'blue', message: t('unstructuredData.search.noResults') })
        }
      } else {
        setResults([])
        setHasSearched(true)
        notifications.show({ color: 'red', message: res?.message || t('unstructuredData.search.failed') })
      }
    } catch (error) {
      console.error('Schema retrieval test failed:', error)
      setResults([])
      setHasSearched(true)
      notifications.show({ color: 'red', message: t('unstructuredData.search.failed') })
    } finally {
      setSearching(false)
    }
  }

  const renderMethodStats = () => {
    const statKeys = ['vector', 'keyword', 'high_recall', 'relationship_expansion', 'entity']
    const visibleStats = statKeys.filter((key) => methodStats[key])
    if (!hasSearched || (!visibleStats.length && !methodStats.mixed)) return null

    return (
      <div className={styles.methodStats}>
        {visibleStats.map((key) => (
          <span key={key} className={`${styles.methodStat} ${getMethodClass(key)}`}>
            {getMethodText(key)} <strong>{methodStats[key]}</strong>
          </span>
        ))}
        {methodStats.mixed ? (
          <span className={styles.methodStat}>
            {t('database.retrievalTest.mixedRecall')} <strong>{methodStats.mixed}</strong>
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className={styles.modalScope}>
      <Modal
        opened={opened}
        onClose={onClose}
        title={title}
        size="min(1120px, calc(100vw - 32px))"
        closeOnClickOutside={false}
        classNames={{
          content: styles.dialogContent,
          header: styles.dialogHeader,
          title: styles.dialogTitle,
          body: styles.dialogBody
        }}
      >
        <div className={styles.schemaRetrieval}>
          <div className={styles.searchWorkbench}>
            <section className={styles.queryPanel}>
              <div className={styles.queryHeader}>
                <span className={styles.queryIcon}>
                  <IconListSearch size={19} />
                </span>
                <div className={styles.queryTitleBlock}>
                  <h3>{title}</h3>
                  <div className={styles.queryStats} aria-label={t('unstructuredData.search.stats')}>
                    <span>
                      {t('unstructuredData.search.resultCount')} <strong>{resultCountText}</strong>
                    </span>
                    <span>
                      {t('unstructuredData.search.bestScore')} <strong>{bestScoreText}</strong>
                    </span>
                  </div>
                </div>
              </div>

              <label className={styles.queryLabel}>{t('unstructuredData.search.queryLabel')}</label>
              <Textarea
                value={question}
                onChange={(event) => setQuestion(event.currentTarget.value)}
                placeholder={queryPlaceholder || t('unstructuredData.search.placeholder')}
                autosize
                minRows={5}
                maxRows={8}
                maxLength={500}
                className={styles.searchInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    handleSearch()
                  }
                }}
              />

              {renderMethodStats()}

              <div className={styles.queryControls}>
                <NumberInput
                  label={t('unstructuredData.search.topK')}
                  value={topK}
                  onChange={(value) => setTopK(typeof value === 'number' ? value : Number(value) || 1)}
                  min={1}
                  max={100}
                  size="sm"
                  className={styles.topkInput}
                />
                <Button
                  leftSection={<IconSearch size={16} />}
                  loading={searching}
                  disabled={!question.trim()}
                  onClick={handleSearch}
                  className={styles.searchButton}
                >
                  {t('unstructuredData.search.run')}
                </Button>
              </div>
            </section>

            <section className={styles.resultsPanel}>
              <LoadingOverlay visible={searching} />

              <div className={styles.resultsHeader}>
                <div>
                  <h3>{t('unstructuredData.search.resultLabel')}</h3>
                  <span>{t('unstructuredData.search.resultSummary', { count: results.length, score: bestScoreText })}</span>
                </div>
                <span className={styles.resultHeaderIcon}>
                  <IconTargetArrow size={18} />
                </span>
              </div>

              {results.length > 0 && (
                <div className={styles.resultList}>
                  {results.map((row, index) => (
                    <article key={`${row.id}-${index}`} className={styles.resultItem}>
                      <div className={styles.resultRank}>
                        <strong>{index + 1}</strong>
                        <span>{scoreText(row.similarity)}</span>
                      </div>

                      <div className={styles.resultMain}>
                        <div className={styles.resultMeta}>
                          <Tooltip label={row.displayName} withArrow>
                            <span className={styles.tableName}>
                              <IconTable size={15} />
                              {row.displayName}
                            </span>
                          </Tooltip>
                          <span className={styles.scorePill}>
                            {t('unstructuredData.search.similarity')} {scoreText(row.similarity)}
                          </span>
                          {row.methods.map((method) => (
                            <span key={method} className={`${styles.methodPill} ${getMethodClass(method)}`}>
                              {getMethodText(method)}
                            </span>
                          ))}
                        </div>

                        <Progress
                          value={clampScore(row.similarity)}
                          size={5}
                          radius="xl"
                          className={styles.scoreBar}
                        />

                        <div className={styles.resultContent}>
                          {row.description || t('database.retrievalTest.noTableDesc')}
                        </div>

                        <div className={styles.columnPreview}>
                          <div className={styles.columnPreviewHeader}>
                            <IconColumns3 size={14} />
                            <span>
                              {row.columns.length} {t('structuredData.columns')}
                            </span>
                          </div>
                          {row.columns.length ? (
                            <div className={styles.columnChips}>
                              {row.columns.slice(0, 10).map((column, columnIndex) => (
                                <span key={`${column.column_name}-${columnIndex}`} className={styles.columnChip}>
                                  <strong>{column.column_name}</strong>
                                  {column.data_type ? <em>{column.data_type}</em> : null}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className={styles.emptyColumns}>{t('database.retrievalTest.noColumnInfo')}</span>
                          )}
                        </div>

                        <Accordion variant="contained" className={styles.resultAccordion}>
                          <Accordion.Item value="columns">
                            <Accordion.Control>{t('database.retrievalTest.columnDetails')}</Accordion.Control>
                            <Accordion.Panel>
                              {row.columns.length ? (
                                <div className={styles.columnDetailList}>
                                  {row.columns.map((column, columnIndex) => (
                                    <div key={`${column.column_name}-detail-${columnIndex}`} className={styles.columnDetailItem}>
                                      <div>
                                        <strong>{column.column_name}</strong>
                                        {column.data_type ? <span>{column.data_type}</span> : null}
                                      </div>
                                      <p>{column.description || '-'}</p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <Center className={styles.noDetail}>{t('database.retrievalTest.noColumnInfo')}</Center>
                              )}
                            </Accordion.Panel>
                          </Accordion.Item>
                          <Accordion.Item value="json">
                            <Accordion.Control>{t('database.retrievalTest.viewRawJson')}</Accordion.Control>
                            <Accordion.Panel>
                              <pre className={styles.jsonDisplay}>{JSON.stringify(row.raw, null, 2)}</pre>
                            </Accordion.Panel>
                          </Accordion.Item>
                        </Accordion>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {!searching && results.length === 0 && (
                <Center className={styles.searchEmpty}>
                  <div className={styles.emptyState}>
                    <span>
                      <IconSearch size={22} />
                    </span>
                    <Text>
                      {hasSearched ? t('unstructuredData.search.noResults') : t('unstructuredData.search.emptyHint')}
                    </Text>
                  </div>
                </Center>
              )}
            </section>
          </div>
        </div>
      </Modal>
    </div>
  )
}

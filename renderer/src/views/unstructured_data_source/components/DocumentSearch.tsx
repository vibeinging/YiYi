import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Center,
  LoadingOverlay,
  NumberInput,
  Progress,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconFileText, IconListSearch, IconSearch, IconTargetArrow } from '@tabler/icons-react'
import { searchDataSourceReq } from '@/api/unstructured_data_source'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './DocumentSearch.module.scss'

export interface DocumentSearchProps {
  dataSourceId: string
}

interface SearchResultItem {
  score: number
  content: string
  document?: { file_name?: string }
  [k: string]: any
}

export default function DocumentSearch({ dataSourceId }: DocumentSearchProps) {
  const { t } = useTranslation()
  const projectId = useProjectStore(projectGetters.currentProjectId)

  const [searchValue, setSearchValue] = useState('')
  const [topK, setTopK] = useState<number>(5)
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResultItem[]>([])
  const bestScore = useMemo(() => {
    if (!searchResult.length) return 0
    return Math.max(...searchResult.map((item) => Number(item.score || 0)))
  }, [searchResult])
  const scoreText = (score: number) => `${(Number(score || 0) * 100).toFixed(1)}%`
  const resultCountText = searchResult.length ? String(searchResult.length) : '-'
  const bestScoreText = searchResult.length ? scoreText(bestScore) : '-'
  const getMethodText = (method: any) => {
    if (method === 'vector') return t('unstructuredData.search.methodVector')
    if (method === 'keyword') return t('unstructuredData.search.methodKeyword')
    return ''
  }

  const handleSearch = async () => {
    if (!searchValue.trim()) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.search.inputRequired') })
      return
    }

    setSearching(true)
    try {
      const res: any = await searchDataSourceReq(projectId, dataSourceId, searchValue, topK)
      if (res.success) {
        // 确保 searchResult 始终是数组
        const data = res.data
        const list: SearchResultItem[] = Array.isArray(data) ? data : []
        setSearchResult(list)
        if (list.length === 0) {
          notifications.show({ color: 'blue', message: t('unstructuredData.search.noResults') })
        }
      } else {
        notifications.show({ color: 'red', message: t('unstructuredData.search.failed') })
        setSearchResult([])
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.search.failed') })
      setSearchResult([])
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className={styles.documentSearch}>
      <div className={styles.searchWorkbench}>
        <section className={styles.queryPanel}>
          <div className={styles.queryHeader}>
            <span className={styles.queryIcon}>
              <IconListSearch size={19} />
            </span>
            <div className={styles.queryTitleBlock}>
              <h3>{t('unstructuredData.search.title')}</h3>
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
            value={searchValue}
            onChange={(e) => setSearchValue(e.currentTarget.value)}
            placeholder={t('unstructuredData.search.placeholder')}
            autosize
            minRows={5}
            maxRows={8}
            className={styles.searchInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSearch()
              }
            }}
          />

          <div className={styles.queryControls}>
            <NumberInput
              label={t('unstructuredData.search.topK')}
              value={topK}
              onChange={(val) => setTopK(typeof val === 'number' ? val : Number(val) || 1)}
              min={1}
              max={100}
              size="sm"
              className={styles.topkInput}
            />
            <Button
              leftSection={<IconSearch size={16} />}
              loading={searching}
              disabled={!searchValue.trim()}
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
              <span>{t('unstructuredData.search.resultSummary', { count: searchResult.length, score: bestScoreText })}</span>
            </div>
            <span className={styles.resultHeaderIcon}>
              <IconTargetArrow size={18} />
            </span>
          </div>

          {searchResult.length > 0 && (
            <div className={styles.resultList}>
              {searchResult.map((row, index) => (
                <article key={index} className={styles.resultItem}>
                  <div className={styles.resultRank}>
                    <strong>{index + 1}</strong>
                    <span>{scoreText(row.score)}</span>
                  </div>
                  <div className={styles.resultMain}>
                    <div className={styles.resultMeta}>
                      <Tooltip label={row.document?.file_name || t('unstructuredData.search.unknownDoc')} withArrow>
                        <span className={styles.documentName}>
                          <IconFileText size={15} />
                          {row.document?.file_name || t('unstructuredData.search.unknownDoc')}
                        </span>
                      </Tooltip>
                      <span className={styles.scorePill}>
                        {t('unstructuredData.search.similarity')} {scoreText(row.score)}
                      </span>
                      {row.retrieval_method && (
                        <span className={styles.methodPill}>{getMethodText(row.retrieval_method)}</span>
                      )}
                    </div>
                    <Progress
                      value={Math.min(100, Math.max(0, Number(row.score || 0) * 100))}
                      size={5}
                      radius="xl"
                      className={styles.scoreBar}
                    />
                    <div className={styles.resultContent}>{row.content || '-'}</div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {!searching && searchResult.length === 0 && (
            <Center className={styles.searchEmpty}>
              <div className={styles.emptyState}>
                <span>
                  <IconSearch size={22} />
                </span>
                <Text>{t('unstructuredData.search.emptyHint')}</Text>
              </div>
            </Center>
          )}
        </section>
      </div>
    </div>
  )
}

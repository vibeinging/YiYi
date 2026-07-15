import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Switch, Badge, Button } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './MetricCard.module.scss'

export interface MetricCardProps {
  metric: any
  active?: boolean
  loading?: string | null
  generating?: string | null
  onToggleActive?: (metric: any, val: boolean) => void
  onGenerateEmbeddings?: (metric: any) => void
  onEdit?: (metric: any) => void
  onDelete?: (metric: any) => void
  onCopy?: (metric: any) => void
}

export default function MetricCard({
  metric,
  loading = null,
  generating = null,
  onToggleActive,
  onGenerateEmbeddings,
  onEdit,
  onDelete,
  onCopy,
}: MetricCardProps) {
  const { t } = useTranslation()

  const hasRelations = useMemo(() => {
    return (
      (metric.related_tables && metric.related_tables.length > 0) ||
      (metric.related_columns && Object.keys(metric.related_columns).length > 0)
    )
  }, [metric.related_tables, metric.related_columns])

  const cleanSqlTemplate = useMemo(() => {
    if (!metric.sql_template) return ''
    // Remove newlines and extra spaces
    return metric.sql_template
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }, [metric.sql_template])

  const copyMetric = () => {
    onCopy?.(metric)
  }

  const handleCardClick = () => {
    onEdit?.(metric)
  }

  return (
    <Card
      className={styles.metricCard}
      shadow="sm"
      padding={0}
      withBorder
      onClick={handleCardClick}
    >
      <div className={styles.cardHeader}>
        <div className={styles.metricCardHeader}>
          <div className={styles.metricTitle}>
            <Switch
              checked={!!metric.is_active}
              size="xs"
              onChange={(e) => onToggleActive?.(metric, e.currentTarget.checked)}
              disabled={loading === metric.id}
              onClick={(e) => e.stopPropagation()}
            />
            <h4>{metric.name}</h4>
            <Badge
              color={metric.has_embedding ? 'green' : 'yellow'}
              size="sm"
              className={styles.titleTag}
            >
              {metric.has_embedding
                ? t('business.metric.vectorized')
                : t('business.metric.notVectorized')}
            </Badge>
          </div>
          <div className={styles.metricActions}>
            <Button
              size="compact-xs"
              variant="subtle"
              className={styles.actionBtn}
              loading={generating === metric.id}
              title={
                metric.has_embedding
                  ? t('business.metric.reVectorize')
                  : t('business.metric.vectorize')
              }
              onClick={(e) => {
                e.stopPropagation()
                onGenerateEmbeddings?.(metric)
              }}
            >
              <ElSvgIcon name="Connection" size={16} />
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              className={styles.actionBtn}
              title={t('business.metric.copyMetric')}
              onClick={(e) => {
                e.stopPropagation()
                copyMetric()
              }}
            >
              <ElSvgIcon name="DocumentCopy" size={16} />
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              className={styles.actionBtn}
              title={t('business.metric.edit')}
              onClick={(e) => {
                e.stopPropagation()
                onEdit?.(metric)
              }}
            >
              <ElSvgIcon name="Edit" size={16} />
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              className={`${styles.actionBtn} ${styles.deleteBtn}`}
              title={t('business.metric.delete')}
              onClick={(e) => {
                e.stopPropagation()
                onDelete?.(metric)
              }}
            >
              <ElSvgIcon name="Delete" size={16} />
            </Button>
          </div>
        </div>
      </div>
      <div className={styles.cardBody}>
        <div className={styles.metricContent}>
          {metric.description && (
            <div className={styles.metricDescription} title={metric.description}>
              <span className={styles.descIcon}>📝</span>
              <span className={styles.descText}>{metric.description}</span>
            </div>
          )}
          <div className={styles.metricSql} title={cleanSqlTemplate}>
            <span className={styles.sqlIcon}>🧮</span>
            <span className={styles.sqlText}>{cleanSqlTemplate}</span>
          </div>
          {hasRelations && (
            <div className={styles.metricRelations}>
              {metric.related_tables && metric.related_tables.length > 0 && (
                <div className={styles.relationItem}>
                  <span className={styles.relationLabel}>
                    {t('business.metric.table')}:
                  </span>
                  {metric.related_tables.map((table: string) => (
                    <Badge key={table} size="sm" className={styles.relationTag}>
                      {table}
                    </Badge>
                  ))}
                </div>
              )}
              {metric.related_columns &&
                Object.keys(metric.related_columns).length > 0 && (
                  <div className={styles.relationItem}>
                    <span className={styles.relationLabel}>
                      {t('business.metric.column')}:
                    </span>
                    {Object.entries(metric.related_columns).map(
                      ([table, cols]: [string, any]) => (
                        <Badge
                          key={table}
                          size="sm"
                          color="gray"
                          className={styles.relationTag}
                        >
                          {table}: {Array.isArray(cols) ? cols.join(', ') : cols}
                        </Badge>
                      ),
                    )}
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

import { notifications } from '@mantine/notifications'
import styles from './PayloadSchemaPanel.module.scss'

interface SchemaField {
  path: string
  binding: string
  example: string
}

interface SchemaGroup {
  key: string
  label: string
  fields: SchemaField[]
}

export interface PayloadSchemaPanelProps {}

const schemaGroups: SchemaGroup[] = [
  {
    key: 'report',
    label: 'report',
    fields: [
      { path: 'report.title', binding: '{{report.title}}', example: '报告标题' },
      { path: 'report.summary', binding: '{{report.summary}}', example: '摘要内容' }
    ]
  },
  {
    key: 'metrics',
    label: 'metrics',
    fields: [
      { path: 'metrics', binding: '{{metrics}}', example: '核心指标数组' }
    ]
  },
  {
    key: 'tables',
    label: 'tables',
    fields: [
      { path: 'tables.sales_detail.columns', binding: '{{tables.sales_detail.columns}}', example: '表格列定义' },
      { path: 'tables.sales_detail.rows', binding: '{{tables.sales_detail.rows}}', example: '表格数据行' }
    ]
  },
  {
    key: 'charts',
    label: 'charts',
    fields: [
      { path: 'charts.sales_trend', binding: '{{charts.sales_trend}}', example: '图表数据对象' }
    ]
  },
  {
    key: 'insights',
    label: 'insights / recommendations',
    fields: [
      { path: 'insights', binding: '{{insights}}', example: '洞察条目列表' },
      { path: 'recommendations', binding: '{{recommendations}}', example: '建议条目列表' }
    ]
  },
  {
    key: 'appendix',
    label: 'appendix',
    fields: [
      { path: 'appendix.notes', binding: '{{appendix.notes}}', example: '附注说明' },
      { path: 'appendix.custom_html', binding: '{{appendix.custom_html}}', example: '自定义 HTML' }
    ]
  }
]

export default function PayloadSchemaPanel(_props: PayloadSchemaPanelProps) {
  const copyBinding = async (binding: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(binding)
      }
      notifications.show({ color: 'green', message: `已复制 ${binding}` })
    } catch {
      notifications.show({ color: 'yellow', message: `复制失败，请手动使用 ${binding}` })
    }
  }

  return (
    <div className={styles.payloadSchemaPanel}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>标准 Payload 字段</span>
        <span className={styles.panelDesc}>点击可复制绑定表达式</span>
      </div>

      <div className={styles.schemaGroups}>
        {schemaGroups.map((group) => (
          <div key={group.key} className={styles.schemaGroup}>
            <div className={styles.groupName}>{group.label}</div>
            <div className={styles.groupList}>
              {group.fields.map((field) => (
                <button
                  key={field.binding}
                  type="button"
                  className={styles.fieldChip}
                  onClick={() => copyBinding(field.binding)}
                >
                  <span className={styles.fieldPath}>{field.path}</span>
                  <span className={styles.fieldExample}>{field.example}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

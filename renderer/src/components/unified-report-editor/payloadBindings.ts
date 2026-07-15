export const COMMON_BINDING_OPTIONS = {
  title: [
    { label: 'report.title', value: '{{report.title}}' },
    { label: 'report.summary', value: '{{report.summary}}' }
  ],
  content: [
    { label: 'report.summary', value: '{{report.summary}}' },
    { label: 'appendix.notes', value: '{{appendix.notes}}' },
    { label: 'appendix.custom_html', value: '{{appendix.custom_html}}' }
  ],
  text: [
    { label: 'report.title', value: '{{report.title}}' },
    { label: 'report.summary', value: '{{report.summary}}' }
  ],
  visibleWhen: [
    { label: '始终显示', value: '' },
    { label: '有指标时显示', value: '{{metrics}}' },
    { label: '有图表时显示', value: '{{charts.sales_trend}}' },
    { label: '有洞察时显示', value: '{{insights}}' },
    { label: '有建议时显示', value: '{{recommendations}}' },
    { label: '有表格数据时显示', value: '{{tables.sales_detail.rows}}' },
    { label: '有附注时显示', value: '{{appendix.notes}}' }
  ],
  metrics: [
    { label: 'metrics', value: '{{metrics}}' }
  ],
  tableColumns: [
    { label: 'tables.sales_detail.columns', value: '{{tables.sales_detail.columns}}' }
  ],
  tableRows: [
    { label: 'tables.sales_detail.rows', value: '{{tables.sales_detail.rows}}' }
  ],
  chartData: [
    { label: 'charts.sales_trend', value: '{{charts.sales_trend}}' }
  ],
  insights: [
    { label: 'insights', value: '{{insights}}' }
  ],
  recommendations: [
    { label: 'recommendations', value: '{{recommendations}}' }
  ]
}

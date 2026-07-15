// nodeCatalog.ts — 节点工具箱卡片元信息(前端静态 fallback)
//
// 后端 GET /superagent-orchestrable-tools 接口扩展 business 字段后(handover Phase B),
// editor 应优先用接口返回的 business 字段;接口缺失/字段为 null 时 fallback 到本文件。
//
// 卡片字段契约 与 后端 BusinessMeta dataclass 对齐:
//   category / icon / name / description / hint / costLevel / costNote / costWarning /
//   capability / typicalScenarios / suggestion
//
// icon 字段是图标 ID 字符串;为了避免在卡片定义里耦合具体图标组件,
// 这里卡片只存 icon ID 字符串,实际渲染在 NodeCard 里 ICON_MAP 映射到组件。

import {
  IconCoin, //            database
  IconChartHistogram, //  bar-chart / chart-bar
  IconSearch, //          search / rag_operator
  IconCompass, //         search-check / agentic_search (DAG 自动导航搜索)
  IconFileText, //        document
  IconPlugConnected, //   globe / web search
  IconFilter, //          filter
  IconPlus, //            plus-square / extract
  IconLink, //            link / join
  IconArrowsExchange, //  git-branch / condition
  IconLayoutGrid, //      layout-grid / metric view
  IconTarget, //          target / align_entity
  IconWand, //            sparkles / agent_condition (LLM 判断)
  type IconProps,
} from '@tabler/icons-react'
import type { FC } from 'react'

// icon ID → 图标组件(渲染时 NodeCard 据此映射)
// 原 Vue 工程存的是 @element-plus/icons-vue 组件;迁移后改存对应的 Tabler 组件,
// EP→Tabler 的取值与 @/lib/icon-map 的 EP_ICON_MAP 一致。
export const ICON_MAP: Record<string, FC<IconProps>> = {
  database: IconCoin,
  'bar-chart': IconChartHistogram,
  'chart-bar': IconChartHistogram, // align_metric 用,跟 bar-chart 同 icon 不同 ID
  search: IconSearch,
  'search-check': IconCompass, // agentic_search 用 — DAG 专用全自动搜索(Compass 跟 rag_operator 的 Search 视觉区分)
  document: IconFileText,
  globe: IconPlugConnected,
  filter: IconFilter,
  'plus-square': IconPlus,
  link: IconLink,
  'git-branch': IconArrowsExchange,
  'layout-grid': IconLayoutGrid,
  target: IconTarget,
  sparkles: IconWand,
}

// 节点族 → 视觉色 / emoji 标签(NodeGroup 标题用)
// label/sublabel 存 i18n key(模块常量在 import 期求值一次,不能直接 t();
// 由 NodeGroup 用 t(meta.label) 渲染,才能响应语言切换)
export const CATEGORY_META: Record<string, any> = {
  tool: {
    emoji: '🔵',
    label: 'workflow.node.types.tool',
    sublabel: 'workflow.category.toolSub',
    accent: '#3b82f6',
  },
  condition: {
    emoji: '🟡',
    label: 'workflow.node.types.condition',
    sublabel: 'workflow.category.conditionSub',
    accent: '#f59e0b',
  },
  operator: {
    emoji: '🟣',
    label: 'workflow.node.types.operator',
    sublabel: 'workflow.category.operatorSub',
    accent: '#ffc943',
  },
}

// 10 张卡片完整定义(对应后端 9 工具 + 1 condition)
// 修改时务必同步后端 tool_registry.py 的 BusinessMeta(handover §2 文案表)
export const NODE_CATALOG: any[] = [
  // ============ 🔵 工具(6)============
  {
    toolName: 'agentic_search',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'search-check',
      name: '全自动数据搜索',
      description: '输入自然语言问题,LLM 多轮自评召回 schema/实体/指标,拆成 sql_scan 可直接消费的 4 路参数',
      hint: '⚠ DAG 专用 — 失败可短路下游(配 fallback_skip_nodes)',
      costLevel: 4,
      costNote: 'LLM 多轮自评(最多 max_rounds 轮)+ fallback promote',
      costWarning: null,
      capability: 'has_structured',
      typicalScenarios: [
        '"某机构的某项指标" → 自动找到表/字段/实体对齐',
        '"某机构某业务的指标值" → 自动召回所需 schema + 实体值',
      ],
      suggestion: 'fallback_skip_nodes 配下游 sql/format 节点 id,失败时短路跳过',
    },
  },
  {
    toolName: 'sql_scan_operator',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'database',
      name: '从数据库拿数据',
      description: '用自然语言查询数据库,结果落中间表',
      hint: null,
      costLevel: 3,
      costNote: 'LLM 1 次(SQL 生成)+ DB 查询',
      costWarning: null,
      capability: 'has_structured',
      typicalScenarios: ['查 5 月销售', '统计每个分行的活跃用户'],
      suggestion: 'question 必须包含已对齐的字面量与业务口径',
    },
  },
  {
    toolName: 'format_result',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'bar-chart',
      name: '出最终图表',
      description: 'workflow 末端,把数据渲染成图表 / 表格 / markdown',
      hint: null,
      costLevel: 2,
      costNote: 'LLM 1 次(选可视化样式)',
      costWarning: null,
      capability: null, // 永远可用
      typicalScenarios: ['所有 workflow 末端必备'],
      suggestion: null,
    },
  },
  {
    toolName: 'metric_view_query',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'layout-grid',
      name: '拿预定义看板结果',
      description: '匹配业务已配置的视图,直接出确定性查询',
      hint: null,
      costLevel: 1,
      costNote: 'LLM 1 次(视图召回)',
      costWarning: null,
      capability: 'has_metric_views',
      typicalScenarios: ['看 5 月销售视图', '看分行业绩看板'],
      suggestion: null,
    },
  },
  {
    toolName: 'rag_operator',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'search',
      name: '在知识库里搜信息',
      description: '跨整个知识库 RAG 检索,适合不知道在哪个文档里',
      hint: '⚠ 不是"扫描指定文件"—— 那个用「处理指定文件」',
      costLevel: 2,
      costNote: 'LLM N 次(向量检索 + summary)',
      costWarning: null,
      capability: 'has_unstructured',
      typicalScenarios: [
        '公司关于报销的最新政策',
        '产品 X 的设计文档说了什么',
      ],
      suggestion: null,
    },
  },
  {
    toolName: 'semantic_scan_operator',
    nodeType: 'tool',
    business: {
      category: 'operator', // 算子族入口:切片文件入中间表,供下游 filter/extract/join 消费(对齐后端)
      icon: 'document',
      name: '处理指定文件',
      description: '把指定文件全量切片入中间表,供下游算子继续处理',
      hint: '⚠ 不是"模糊搜索"—— 那个用「在知识库里搜信息」',
      costLevel: 0,
      costNote: '0 LLM(只切片入表)',
      costWarning: null,
      capability: 'has_unstructured',
      typicalScenarios: ['这份合同/年报全文加载,后续逐段处理'],
      suggestion: null,
    },
  },
  {
    toolName: 'web_search_operator',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'globe',
      name: '搜外网',
      description: '调外部搜索引擎,获取实时信息',
      hint: null,
      costLevel: 1,
      costNote: '外部 API 调用',
      costWarning: null,
      capability: 'has_web_search',
      typicalScenarios: ['时事查询', '跨企业信息', '内部知识库覆盖不到的信息'],
      suggestion: null,
    },
  },
  {
    toolName: 'free_llm',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'sparkles',
      name: '自由增强节点',
      description: '在 workflow 链路中插入 LLM 增强点:按预写 prompt 生成业务指导写入 ctx.guidance(str,多节点 \\n\\n 拼接),下游用 {{ctx.guidance}} 引用,模板零转换。主数据流不变。',
      hint: '⚠ 不同于「AI 判断分支」:本节点不分流,而是把业务指导写进 ctx.guidance 供下游 {{ctx.guidance}} 取;限 1 个上游',
      costLevel: 2,
      costNote: 'LLM 1 次(单轮调用,无重试)',
      costWarning: null,
      capability: null, // 永远可用
      typicalScenarios: [
        '指标兜底:agentic_search 未命中指标 → free_llm 按预写 prompt 指导 sql_scan 去明细表聚合',
        '口径补充:用户问『销售额』但有多种口径 → free_llm 按业务规则提示 sql_scan 用哪个',
        '异常处理:上游节点失败时 free_llm 写『降级查询』指导,下游 sql_scan 改路径',
      ],
      suggestion: 'prompt 越具体越好(写『去 xx 表 sum(y)/10000 算万元』比『查相关数据』更有效);prompt 内可引用 {{user_query}} / {{ctx.metrics}} / {{n1.output.x}}',
    },
  },

  // ============ 🟡 条件(1)============
  {
    toolName: 'condition',
    nodeType: 'condition',
    business: {
      category: 'condition',
      icon: 'git-branch',
      name: '如果...就...否则...',
      description: '按条件分支,不同情况走不同后续节点',
      hint: null,
      costLevel: 0,
      costNote: null,
      costWarning: null,
      capability: null,
      typicalScenarios: [
        '上游 metric_view 命中 → 走 A 分支;没命中 → 走 B 分支',
      ],
      suggestion: '支持的语法:算术 / 比较 / 布尔 / 三元 / 索引;禁止函数调用',
    },
  },

  // ============ 🟣 算子(3)============
  {
    toolName: 'semantic_filter_operator',
    nodeType: 'tool', // ← 底层仍是 tool 节点,UI 上分类成"算子"
    business: {
      category: 'operator',
      icon: 'filter',
      name: '给上游表逐行过滤',
      description: '对中间表每行做 LLM 判断,留下符合条件的(可同时抽字段)',
      hint: null,
      costLevel: 3,
      costNote: 'N 次并发 LLM(N = 上游行数)',
      costWarning: null,
      capability: null,
      typicalScenarios: [
        '保留所有讨论 XX 主题的段落',
        '留下金额 > 1000 的交易并标注异常原因',
      ],
      suggestion: '先用 sql 把行数压到 < 100',
    },
  },
  {
    toolName: 'semantic_extract_operator',
    nodeType: 'tool',
    business: {
      category: 'operator',
      icon: 'plus-square',
      name: '给上游表逐行加字段',
      description: '从某列文本里 LLM 抽出结构化字段,给表加新列',
      hint: null,
      costLevel: 3,
      costNote: 'N 次并发 LLM',
      costWarning: null,
      capability: null,
      typicalScenarios: [
        '从合同正文抽出 甲方/乙方/合同金额/签订日期',
        '从客服记录抽出 投诉类型/紧急程度',
      ],
      suggestion: '先用 sql 把行数压到 < 100',
    },
  },
  {
    toolName: 'semantic_join_operator',
    nodeType: 'tool',
    business: {
      category: 'operator',
      icon: 'link',
      name: '让两个表按语义合并',
      description: '两表无明确 join 键时,靠 LLM 判断是否匹配',
      hint: null,
      costLevel: 6, // 最高警告级
      costNote: '|L|×|R| 次 LLM(笛卡尔放大)',
      costWarning: '⚠ 笛卡尔放大,务必先双侧 Limit 到 ≤ 30',
      capability: null,
      typicalScenarios: ['用户反馈表 × 产品功能表,按"是否描述同一功能"关联'],
      suggestion: '双侧 Limit ≤ 30 才可用',
    },
  },

  // ============ 对齐族(2 张,workflow 三件套):后端 category=tool,UI 归「工具」组(非算子)============
  {
    toolName: 'align_metric',
    nodeType: 'tool', // 底层是 tool 节点
    business: {
      category: 'tool',
      icon: 'chart-bar',
      name: '业务对齐指标',
      description: '把用户原文里的业务术语(如 "DAU"、"小企业贷款不良率")对齐到业务指标库的标准定义',
      hint: null,
      costLevel: 2,
      costNote: 'LLM 召回 + 排序',
      costWarning: null,
      capability: 'has_metrics',
      typicalScenarios: [
        '用户问 "DAU" → 对齐到 "日活跃用户数" 指标',
        '用户问 "不良率" → 对齐到 "信贷不良贷款率" 指标',
      ],
      suggestion: '业务先在指标库录入指标 + embedding,本工具才能命中',
    },
  },
  {
    toolName: 'align_entity',
    nodeType: 'tool',
    business: {
      category: 'tool',
      icon: 'target',
      name: '业务对齐实体',
      description: '接 keyword 自动从业务实体配置跨表找对齐,workflow 编辑者免去手动配 table/column',
      hint: '⚠ 跟 align_value 的差别:全自动跨表 vs 已知列点对点',
      costLevel: 2,
      costNote: '跨表 LLM 召回',
      costWarning: null,
      capability: 'has_structured',
      typicalScenarios: [
        '用户问 "华南区" → 自动查所有有"区域"字段的表,找到对齐值',
        '用户问 "招商银行" → 自动查"银行/机构/客户"等所有相关表',
      ],
      suggestion: '业务先在实体映射配置里登记表+列,才能跨表找对齐',
    },
  },

  // ============ 🟡 条件族 — AI 判断(1 张,workflow 三件套)============
  {
    toolName: 'agent_condition',
    nodeType: 'agent_condition', // 新 node 类型,跟 condition 并列
    business: {
      category: 'condition', // UI 上跟 condition 同分组
      icon: 'sparkles',
      name: 'AI 判断分支',
      description: '用 LLM 语义判断条件分支,prompt 里可引用上游节点 {{node_id.field}} 模板',
      hint: '⚠ 跟普通条件的差别:不是表达式 eval,而是 LLM 推理 true/false',
      costLevel: 2,
      costNote: 'LLM 1 次(强制 true/false 输出)',
      costWarning: null,
      capability: null,
      typicalScenarios: [
        '判断用户输入是否含有时间范围',
        '判断上游 SQL 结果是否符合业务预期',
      ],
      suggestion: 'prompt 越具体越好;成本可控但比普通 condition 慢一拍',
    },
  },
]

// 工具方法:按 category 分组
export function groupCatalogByCategory(catalog: any[] = NODE_CATALOG): Record<string, any[]> {
  const groups: Record<string, any[]> = { tool: [], condition: [], operator: [] }
  for (const card of catalog) {
    const cat = card.business?.category
    if (cat && groups[cat]) groups[cat].push(card)
  }
  return groups
}

// 工具方法:用后端 business 字段(若有)合并 / 覆盖本地 catalog
// 后端字段优先,本地字段作为缺失字段的 fallback
export function mergeCatalogWithBackend(backendItems: any[] = []): any[] {
  const merged: any[] = []
  const backendMap = new Map<any, any>(backendItems.map((it) => [it.name, it]))
  // 1. 先放本地 catalog(给业务字段)
  for (const local of NODE_CATALOG) {
    const remote = backendMap.get(local.toolName)
    if (!remote) {
      // 后端没这个工具(可能未注册)→ 用本地但标记不可用
      merged.push({
        ...local,
        registered: false,
        spec: null,
      })
      continue
    }
    // 后端有 → 合并 business(后端优先)
    const business = remote.business
      ? { ...local.business, ...convertSnakeToCamel(remote.business) }
      : local.business
    merged.push({
      toolName: local.toolName,
      nodeType: local.nodeType,
      business,
      registered: remote.registered !== false,
      spec: remote.spec || null,
    })
  }
  // 2. 后端有但本地没声明的工具(防漏)
  for (const remote of backendItems) {
    if (NODE_CATALOG.some((c) => c.toolName === remote.name)) continue
    if (!remote.business) continue
    // nodeType 推断:condition / agent_condition 用同名 node 类型;其余都是 tool
    const nodeType = remote.name === 'condition' || remote.name === 'agent_condition'
      ? remote.name
      : 'tool'
    merged.push({
      toolName: remote.name,
      nodeType,
      business: convertSnakeToCamel(remote.business),
      registered: remote.registered !== false,
      spec: remote.spec || null,
    })
  }
  return merged
}

// 后端 snake_case → 前端 camelCase
function convertSnakeToCamel(obj: any): any {
  if (!obj) return obj
  return {
    category: obj.category,
    icon: obj.icon,
    name: obj.name,
    description: obj.description,
    hint: obj.hint,
    costLevel: obj.cost_level ?? 0,
    costNote: obj.cost_note,
    costWarning: obj.cost_warning,
    capability: obj.capability,
    typicalScenarios: obj.typical_scenarios || [],
    suggestion: obj.suggestion,
  }
}

// 工具方法:判断卡片是否可用(根据当前 business capabilities)
export function isCardAvailable(card: any, capabilities: any): boolean {
  if (!card.business?.capability) return true // 无 capability 要求
  if (!capabilities) return true // 没拿到 capabilities 默认可用(乐观)
  return capabilities[card.business.capability] === true
}

// 工具方法:卡片搜索匹配
export function cardMatchesQuery(card: any, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase().trim()
  const b = card.business
  return (
    card.toolName.toLowerCase().includes(q) ||
    (b?.name || '').toLowerCase().includes(q) ||
    (b?.description || '').toLowerCase().includes(q)
  )
}

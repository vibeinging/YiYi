import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Popover, Tooltip } from '@mantine/core'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorSelection, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { sql, StandardSQL } from '@codemirror/lang-sql'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { bracketMatching, indentOnInput, foldGutter } from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import { format as formatSql } from 'sql-formatter'
import ElSvgIcon from './ElSvgIcon'
import styles from './SqlEditor.module.scss'

// TODO(migration): el-button-group 无 Mantine 直接等价物,用 Button.Group 风格 div 包裹(Mantine 的 Button.Group 需共享 props,这里手动 -ml 拼接)

export interface SqlEditorProps {
  // defineProps → props + interface
  modelValue?: string
  tables?: any[]
  columns?: Record<string, any>
  placeholder?: string
  height?: string
  showToolbar?: boolean
  showStatusBar?: boolean
  showSelectionPreview?: boolean
  /** 使用高对比选区高亮（深绿），适合深色编辑器 / 元数据查询多段 SQL */
  vividSelection?: boolean
  isRunning?: boolean
  // 外部传入的错误信息（如后端返回的语法错误）
  externalErrors?: any[]
  // defineEmits(['update:modelValue', 'run', 'cancel']) → 回调 props
  'onUpdate:modelValue'?: (val: string) => void
  onRun?: (sql: string) => void
  onCancel?: () => void
}

// 内部错误项类型
interface SqlError {
  line: number
  message: string
}

// defineExpose → forwardRef + useImperativeHandle 暴露的实例方法
export interface SqlEditorHandle {
  focus: () => void
  getValue: () => string
  setValue: (val: string) => void
  format: () => void
  clear: () => void
  hasErrors: () => boolean
  getErrors: () => SqlError[]
  getSelectedSql: () => string
  hasSelection: () => boolean
  getSqlToRun: () => string
}

/** 默认选区（灰底，与其它浅色页面一致） */
const defaultSelectionTheme = EditorView.theme({
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(100, 100, 100, 0.4) !important'
  },
  '.cm-editor.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(100, 100, 100, 0.45) !important',
    outline: '2px solid var(--el-color-primary)',
    outlineOffset: '-2px'
  },
  '.cm-editor:not(.cm-focused) .cm-selectionBackground': {
    backgroundColor: 'rgba(100, 100, 100, 0.35) !important',
    outline: '1px solid rgba(100, 100, 100, 0.6)'
  },
  '.cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'rgba(100, 100, 100, 0.4) !important'
  }
})

/**
 * 高对比深绿选区：偏 yiw / 深绿，与「运行已选择」按钮同系，避免灰蓝发脏
 */
const vividSelectionTheme = EditorView.theme({
  '.cm-selectionBackground': {
    background:
      'linear-gradient(105deg, rgba(23, 72, 62, 0.42) 0%, rgba(47, 111, 96, 0.5) 55%, rgba(255, 201, 67, 0.38) 100%) !important',
    boxShadow:
      'inset 0 0 0 1px rgba(220, 232, 226, 0.55), inset 3px 0 0 0 rgba(255, 211, 78, 0.9), 0 0 14px rgba(47, 111, 96, 0.18)',
    outline: 'none'
  },
  '.cm-editor.cm-focused .cm-selectionBackground': {
    background:
      'linear-gradient(105deg, rgba(23, 72, 62, 0.52) 0%, rgba(47, 111, 96, 0.58) 50%, rgba(255, 201, 67, 0.45) 100%) !important',
    boxShadow:
      'inset 0 0 0 1px rgba(235, 228, 214, 0.65), inset 3px 0 0 0 rgba(220, 232, 226, 1), 0 0 18px rgba(47, 111, 96, 0.28)',
    outline: 'none'
  },
  '.cm-editor:not(.cm-focused) .cm-selectionBackground': {
    background:
      'linear-gradient(105deg, rgba(23, 72, 62, 0.32) 0%, rgba(39, 99, 84, 0.4) 100%) !important',
    boxShadow: 'inset 0 0 0 1px rgba(255, 211, 78, 0.45), inset 3px 0 0 0 rgba(47, 111, 96, 0.65)',
    outline: 'none'
  },
  '.cm-selectionLayer .cm-selectionBackground': {
    background:
      'linear-gradient(105deg, rgba(23, 72, 62, 0.5) 0%, rgba(47, 111, 96, 0.55) 100%) !important',
    boxShadow:
      'inset 0 0 0 1px rgba(220, 232, 226, 0.5), inset 3px 0 0 0 rgba(255, 211, 78, 0.85)'
  }
})

// ============ 以下纯函数逻辑与原文件保持一致 ============

// 查找关键字位置
const findKeywordPosition = (code: string, keyword: string, startFrom = 0): number => {
  const regex = new RegExp(`\\b${keyword}\\b`, 'i')
  const match = code.substring(startFrom).match(regex)
  if (match) {
    return startFrom + (match.index as number)
  }
  return -1
}

// 检查括号匹配
const checkBrackets = (code: string, doc: any): any[] => {
  const diagnostics: any[] = []
  const stack: any[] = []
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const opening = Object.keys(pairs)
  const closing = Object.values(pairs)

  for (let i = 0; i < code.length; i++) {
    const char = code[i]
    if (opening.includes(char)) {
      stack.push({ char, pos: i })
    } else if (closing.includes(char)) {
      if (stack.length === 0) {
        diagnostics.push({
          from: i,
          to: i + 1,
          severity: 'error',
          message: `Unmatched closing bracket '${char}'`,
          actions: [
            {
              name: 'Remove',
              apply(view: any) {
                view.dispatch({ changes: { from: i, to: i + 1 } })
              }
            }
          ]
        })
      } else {
        const last = stack.pop()
        if (pairs[last.char] !== char) {
          diagnostics.push({
            from: i,
            to: i + 1,
            severity: 'error',
            message: `Mismatched brackets: expected '${pairs[last.char]}' but found '${char}'`
          })
        }
      }
    }
  }

  // 未闭合的括号
  stack.forEach(({ char, pos }: any) => {
    diagnostics.push({
      from: pos,
      to: pos + 1,
      severity: 'error',
      message: `Unclosed bracket '${char}'`
    })
  })

  return diagnostics
}

// 检查引号匹配
const checkQuotes = (code: string, _doc: any): any[] => {
  const diagnostics: any[] = []
  const singleQuotes: number[] = []
  const doubleQuotes: number[] = []
  const backticks: number[] = []

  let i = 0
  while (i < code.length) {
    const char = code[i]

    // 跳过转义字符
    if (char === '\\' && i + 1 < code.length) {
      i += 2
      continue
    }

    if (char === "'") {
      singleQuotes.push(i)
    } else if (char === '"') {
      doubleQuotes.push(i)
    } else if (char === '`') {
      backticks.push(i)
    }

    // 处理注释
    if (char === '-' && code[i + 1] === '-') {
      // 单行注释，跳到行尾
      const nextNewline = code.indexOf('\n', i)
      i = nextNewline === -1 ? code.length : nextNewline
      continue
    }
    if (char === '/' && code[i + 1] === '*') {
      // 多行注释，跳到结束
      const endPos = code.indexOf('*/', i + 2)
      i = endPos === -1 ? code.length : endPos + 2
      continue
    }

    i++
  }

  // 检查未闭合的引号
  if (singleQuotes.length % 2 !== 0) {
    const pos = singleQuotes[singleQuotes.length - 1]
    diagnostics.push({
      from: pos,
      to: pos + 1,
      severity: 'error',
      message: "Unclosed single quote (')"
    })
  }

  if (doubleQuotes.length % 2 !== 0) {
    const pos = doubleQuotes[doubleQuotes.length - 1]
    diagnostics.push({
      from: pos,
      to: pos + 1,
      severity: 'error',
      message: 'Unclosed double quote (")'
    })
  }

  if (backticks.length % 2 !== 0) {
    const pos = backticks[backticks.length - 1]
    diagnostics.push({
      from: pos,
      to: pos + 1,
      severity: 'error',
      message: 'Unclosed backtick (`)'
    })
  }

  return diagnostics
}

// 检查SQL结构
const checkSqlStructure = (code: string, _doc: any): any[] => {
  const diagnostics: any[] = []
  const upperCode = code.toUpperCase().trim()

  // 检查是否以SELECT开头（元数据查询只允许SELECT）
  if (upperCode && !upperCode.startsWith('SELECT') && !upperCode.startsWith('WITH')) {
    const firstWord = code.trim().split(/\s+/)[0]
    const startPos = code.indexOf(firstWord)
    diagnostics.push({
      from: startPos,
      to: startPos + firstWord.length,
      severity: 'warning',
      message: 'Only SELECT queries are allowed for metadata queries'
    })
  }

  // 检查SELECT后面是否有FROM
  const selectMatch = upperCode.match(/\bSELECT\b/)
  if (selectMatch) {
    const selectEnd = (selectMatch.index as number) + 6
    const afterSelect = upperCode.substring(selectEnd).trim()

    // 如果没有FROM（可能是计算或简单表达式）
    if (!afterSelect.includes('FROM') && !afterSelect.includes(';')) {
      // 检查是否是简单的SELECT表达式（如 SELECT 1, SELECT NOW()）
      if (!/^[\d\s\+\-\*\/\(\)\.\w]+\s*$/i.test(afterSelect)) {
        const fromPos = findKeywordPosition(code, 'FROM')
        if (fromPos === -1) {
          diagnostics.push({
            from: selectMatch.index,
            to: (selectMatch.index as number) + 6,
            severity: 'warning',
            message: 'SELECT statement should have a FROM clause'
          })
        }
      }
    }
  }

  // 检查JOIN是否有ON条件
  const joinMatch = upperCode.match(/\bJOIN\b/g)
  if (joinMatch) {
    let searchPos = 0
    for (let i = 0; i < joinMatch.length; i++) {
      const joinIndex = upperCode.indexOf('JOIN', searchPos)
      const afterJoin = upperCode.substring(joinIndex + 4)

      // 检查是否有ON关键字
      if (!afterJoin.includes('ON') && !afterJoin.includes('USING')) {
        // 查找下一个关键字
        const nextKeyword = afterJoin.match(/\b(WHERE|GROUP|ORDER|LIMIT|JOIN|UNION)\b/)
        if (!nextKeyword || (nextKeyword.index as number) > 50) {
          // 可能缺少ON条件
          const joinPos = findKeywordPosition(code, 'JOIN', searchPos)
          if (joinPos !== -1) {
            diagnostics.push({
              from: joinPos,
              to: joinPos + 4,
              severity: 'warning',
              message: 'JOIN should have an ON or USING clause'
            })
          }
        }
      }
      searchPos = joinIndex + 4
    }
  }

  return diagnostics
}

// 检查常见语法错误
const checkCommonErrors = (code: string, _doc: any): any[] => {
  const diagnostics: any[] = []
  const upperCode = code.toUpperCase()

  // 检查是否有连续的关键字（如 SELECT SELECT）
  const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'GROUP', 'ORDER', 'HAVING', 'LIMIT']
  const keywordPattern = new RegExp(`\\b(${keywords.join('|')})\\s+(${keywords.join('|')})\\b`, 'gi')
  let match: RegExpExecArray | null
  while ((match = keywordPattern.exec(code)) !== null) {
    // 排除合法的组合，如 ORDER BY, GROUP BY
    const first = match[1].toUpperCase()
    const second = match[2].toUpperCase()
    if (!['ORDER', 'GROUP', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL'].includes(first)) {
      if (!(first === 'GROUP' && second === 'BY') && !(first === 'ORDER' && second === 'BY')) {
        diagnostics.push({
          from: match.index,
          to: match.index + match[0].length,
          severity: 'warning',
          message: `Possible duplicate keyword: '${match[0]}'`
        })
      }
    }
  }

  // 检查是否有尾随逗号（在FROM之前）
  const trailingCommaMatch = upperCode.match(/,\s*FROM/)
  if (trailingCommaMatch) {
    const pos = upperCode.indexOf(trailingCommaMatch[0])
    diagnostics.push({
      from: pos,
      to: pos + 1,
      severity: 'error',
      message: 'Trailing comma before FROM'
    })
  }

  // 检查ORDER BY后面是否有列名
  const orderByMatch = upperCode.match(/\bORDER\s+BY\s*$/)
  if (orderByMatch) {
    const pos = upperCode.indexOf(orderByMatch[0])
    diagnostics.push({
      from: pos,
      to: pos + orderByMatch[0].length,
      severity: 'error',
      message: 'ORDER BY clause is incomplete'
    })
  }

  // 检查GROUP BY后面是否有列名
  const groupByMatch = upperCode.match(/\bGROUP\s+BY\s*$/)
  if (groupByMatch) {
    const pos = upperCode.indexOf(groupByMatch[0])
    diagnostics.push({
      from: pos,
      to: pos + groupByMatch[0].length,
      severity: 'error',
      message: 'GROUP BY clause is incomplete'
    })
  }

  return diagnostics
}

// SQL关键字
const sqlKeywords = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
  'IS', 'NULL', 'AS', 'DISTINCT', 'ALL', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'OUTER', 'FULL', 'CROSS', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC',
  'DESC', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'WITH',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'ANY', 'SOME',
  'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA', 'INTO', 'VALUES',
  'SET', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST',
  'CONCAT', 'SUBSTRING', 'TRIM', 'UPPER', 'LOWER', 'LENGTH', 'REPLACE',
  'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'EXTRACT', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND'
]

// 自定义SQL补全
const createSqlCompletion = (tables: any[], columns: Record<string, any>) => {
  return (context: any) => {
    const word = context.matchBefore(/\w*/)
    if (!word) return null

    if (word.from === word.to && !context.explicit) {
      return null
    }

    const completions: any[] = []
    const wordLower = word.text.toLowerCase()

    sqlKeywords.forEach((kw) => {
      if (kw.toLowerCase().includes(wordLower)) {
        completions.push({
          label: kw,
          type: 'keyword',
          boost: 99
        })
      }
    })

    if (tables && tables.length > 0) {
      tables.forEach((table) => {
        if (table && table.toLowerCase().includes(wordLower)) {
          completions.push({
            label: table,
            type: 'class',
            boost: 95,
            info: 'Table'
          })
        }
      })
    }

    if (columns && Object.keys(columns).length > 0) {
      Object.entries(columns).forEach(([tableName, cols]) => {
        if (cols && Array.isArray(cols)) {
          cols.forEach((col: any) => {
            if (col && col.toLowerCase().includes(wordLower)) {
              completions.push({
                label: col,
                type: 'property',
                boost: 80,
                info: `Column of ${tableName}`
              })
            }
          })
        }
      })
    }

    const functions = ['COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'COALESCE', 'NULLIF',
      'CAST', 'CONCAT', 'SUBSTRING', 'TRIM', 'UPPER', 'LOWER',
      'LENGTH', 'REPLACE', 'DATE', 'TIME', 'TIMESTAMP']
    functions.forEach((fn) => {
      if (fn.toLowerCase().includes(wordLower)) {
        completions.push({
          label: fn,
          type: 'function',
          boost: 85
        })
      }
    })

    return {
      from: word.from,
      options: completions.slice(0, 50),
      validFor: /^\w*$/
    }
  }
}

// 创建自动补全扩展
const createCompletionExtension = (tables: any[], columns: Record<string, any>) => {
  return autocompletion({
    override: [createSqlCompletion(tables, columns)],
    activateOnTyping: true,
    maxRenderedOptions: 50
  })
}

/**
 * SQL 编辑器（对齐原 components/SqlEditor.vue）。
 * codemirror 裸用 EditorView + 各扩展;保留 SQL 高亮/补全/lint/格式化(sql-formatter)逻辑。
 * 由于源组件大量依赖命令式 compartment.reconfigure / dispatch,这里仍以 ref 挂载 EditorView。
 */
const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(props, ref) {
  const {
    modelValue = '',
    tables = [],
    columns = {},
    placeholder = '',
    height = '200px',
    showToolbar = true,
    showStatusBar = true,
    showSelectionPreview = true,
    vividSelection = false,
    isRunning = false,
    externalErrors: _externalErrors = [],
    'onUpdate:modelValue': onUpdateModelValue,
    onRun,
    onCancel
  } = props

  const { t } = useTranslation()

  // 模板 ref（编辑器挂载点）
  const editorRef = useRef<HTMLDivElement | null>(null)
  // shallowRef(null) → editor 实例 ref
  const editor = useRef<EditorView | null>(null)

  // 各 compartment（与源文件一一对应,实例级,用 ref 持有）
  const completionCompartment = useRef(new Compartment())
  const lintCompartment = useRef(new Compartment())
  const selectionThemeCompartment = useRef(new Compartment())

  // 内部错误列表（ref([]) → useState）
  const [internalErrors, setInternalErrors] = useState<SqlError[]>([])
  // 用 ref 镜像最新值,供 CodeMirror 回调/键位读取（避免闭包陈旧）
  const internalErrorsRef = useRef<SqlError[]>([])
  internalErrorsRef.current = internalErrors

  // 选中的SQL
  const [hasSelection, setHasSelection] = useState(false)
  const [selectedSql, setSelectedSql] = useState('')
  // savedSelection 与 selectedSql/hasSelection 的最新值用 ref 镜像,供命令式逻辑读取
  const hasSelectionRef = useRef(false)
  const selectedSqlRef = useRef('')
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null)
  hasSelectionRef.current = hasSelection
  selectedSqlRef.current = selectedSql

  // 最新 props 的 ref 镜像（供 CodeMirror 键位/回调读取，避免闭包陈旧）
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning
  const heightRef = useRef(height)
  heightRef.current = height
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const vividSelectionRef = useRef(vividSelection)
  vividSelectionRef.current = vividSelection
  const onUpdateModelValueRef = useRef(onUpdateModelValue)
  onUpdateModelValueRef.current = onUpdateModelValue
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun

  // ===== 计算属性（computed → useMemo / 派生）=====
  // hasContent 依赖编辑器内文档,这里用 modelValue 派生（与初始/外部同步一致）
  const hasContent = useMemo(() => {
    const val = editor.current?.state.doc.toString() || modelValue || ''
    return val.trim().length > 0
  }, [modelValue])
  // hasContent 的实时计算（命令式场景：读编辑器真实内容）
  const computeHasContent = () => {
    const val = editor.current?.state.doc.toString() || modelValue || ''
    return val.trim().length > 0
  }

  const hasErrors = useMemo(() => internalErrors.length > 0, [internalErrors])
  const hasErrorsRef = useRef(false)
  hasErrorsRef.current = hasErrors

  const errorCount = useMemo(() => internalErrors.length, [internalErrors])

  const errorSummary = useMemo(() => {
    if (internalErrors.length === 0) return ''
    return internalErrors.map((e) => e.message).join('; ')
  }, [internalErrors])

  const statusText = useMemo(() => {
    if (isRunning) {
      return t('database.query.statusRunning') || 'Running...'
    }
    if (hasErrors) {
      return `${errorCount} ${t('database.query.syntaxError') || 'syntax error(s)'}`
    }
    return ''
  }, [isRunning, hasErrors, errorCount, t])

  // 是否有选中的SQL（用于显示按钮文字）
  const shouldShowRunSelected = useMemo(() => {
    return hasSelection && selectedSql.trim().length > 0
  }, [hasSelection, selectedSql])

  // 选中SQL预览（截取前30字符）
  const selectedSqlPreview = useMemo(() => {
    if (!selectedSql) return ''
    const s = selectedSql.trim().replace(/\n/g, ' ')
    return s.length > 30 ? s.substring(0, 30) + '...' : s
  }, [selectedSql])

  // ===== 核心逻辑（依赖 props/state，定义在组件内以闭包访问 ref）=====

  // SQL语法校验函数
  const createSqlLinter = () => {
    return linter(
      (view: any) => {
        const diagnostics: any[] = []
        const doc = view.state.doc
        const code = doc.toString()

        if (!code.trim()) {
          setInternalErrors([])
          return diagnostics
        }

        // 1. 检查括号匹配
        const bracketErrors = checkBrackets(code, doc)
        diagnostics.push(...bracketErrors)

        // 2. 检查引号匹配
        const quoteErrors = checkQuotes(code, doc)
        diagnostics.push(...quoteErrors)

        // 3. 检查基本SQL结构
        const structureErrors = checkSqlStructure(code, doc)
        diagnostics.push(...structureErrors)

        // 4. 检查常见语法错误
        const commonErrors = checkCommonErrors(code, doc)
        diagnostics.push(...commonErrors)

        // 更新内部错误列表
        setInternalErrors(
          diagnostics.map((d) => ({
            line: doc.lineAt(d.from).number,
            message: d.message
          }))
        )

        return diagnostics
      },
      {
        delay: 300 // 延迟300ms检查，避免输入时频繁触发
      }
    )
  }

  const getSelectionThemeExtension = () =>
    vividSelectionRef.current ? vividSelectionTheme : defaultSelectionTheme

  // 创建编辑器扩展
  const createExtensions = () => {
    return [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection({ cursorBlinkRate: 1200 }),
      history(),
      bracketMatching(),
      indentOnInput(),
      foldGutter(),
      lintGutter(),
      sql({ dialect: StandardSQL }),
      completionCompartment.current.of(createCompletionExtension(tables, columns)),
      lintCompartment.current.of(createSqlLinter()),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        {
          key: 'Ctrl-Enter',
          run: () => {
            if (!isRunningRef.current && computeHasContent() && !hasErrorsRef.current) {
              const s = getSqlToRun()
              onRunRef.current?.(s)
            }
            return true
          }
        },
        {
          key: 'Ctrl-Space',
          run: startCompletion
        },
        {
          key: 'Tab',
          run: startCompletion
        }
      ]),
      EditorView.updateListener.of((update: any) => {
        if (update.docChanged) {
          onUpdateModelValueRef.current?.(update.state.doc.toString())
        }
        // 检测选中状态变化（文档变化或选择变化时都要检查）
        if (update.docChanged || update.selectionSet) {
          updateSelectionState(update.state)
        }
      }),
      EditorView.domEventHandlers({
        copy: (event: ClipboardEvent, view: any) => {
          const ranges = view.state.selection.ranges.filter((r: any) => !r.empty)
          if (ranges.length === 0) return false

          const selectedText = ranges
            .map((r: any) => view.state.sliceDoc(r.from, r.to))
            .join('\n')

          if (event.clipboardData) {
            event.clipboardData.setData('text/plain', selectedText)
            event.preventDefault()
            return true
          }

          return false
        }
      }),
      EditorView.theme({
        '&': {
          height: heightRef.current,
          fontSize: '14px'
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace"
        },
        '.cm-content': {
          padding: '8px 0'
        },
        '.cm-line': {
          padding: '0 12px'
        },
        '.cm-gutters': {
          backgroundColor: 'var(--el-fill-color-lighter)',
          border: 'none',
          borderRight: '1px solid var(--el-border-color-lighter)',
          color: 'var(--el-text-color-secondary)',
          fontSize: '12px'
        },
        '.cm-gutter': {
          minWidth: '40px'
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'var(--el-fill-color-light)'
        },
        '.cm-activeLine': {
          backgroundColor: 'var(--el-fill-color-light)'
        },
        '.cm-cursor': {
          borderLeftColor: 'var(--el-color-primary)',
          borderLeftWidth: '2px'
        },
        '.cm-selectionMatch': {
          backgroundColor: 'var(--el-color-primary-light-9)'
        },
        '.cm-tooltip-autocomplete': {
          fontFamily: 'inherit',
          fontSize: '13px',
          border: '1px solid var(--el-border-color-light)',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
        },
        '.cm-tooltip-autocomplete ul': {
          maxHeight: '250px',
          fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace"
        },
        '.cm-tooltip-autocomplete li': {
          padding: '6px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        },
        '.cm-tooltip-autocomplete li[aria-selected]': {
          backgroundColor: 'var(--el-color-primary-light-8)',
          color: 'var(--el-color-primary)'
        },
        '.cm-completionIcon': {
          width: '16px',
          height: '16px',
          marginRight: '4px'
        },
        '.cm-completionLabel': {
          flex: 1
        },
        '.cm-completionDetail': {
          fontSize: '11px',
          color: 'var(--el-text-color-secondary)',
          marginLeft: '8px'
        },
        '.cm-foldGutter': {
          width: '12px'
        },
        '.cm-foldPlaceholder': {
          backgroundColor: 'var(--el-fill-color)',
          border: '1px solid var(--el-border-color-lighter)',
          borderRadius: '2px',
          padding: '0 4px',
          fontSize: '12px'
        },
        // Lint 样式
        '.cm-lintRange-error': {
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'6\' height=\'3\'%3E%3Cpath d=\'M0 3 L2 0 L4 3 Z\' fill=\'%23f56c6c\'/%3E%3C/svg%3E")',
          backgroundRepeat: 'repeat-x',
          backgroundPosition: 'bottom left',
          paddingBottom: '2px'
        },
        '.cm-lintRange-warning': {
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'6\' height=\'3\'%3E%3Cpath d=\'M0 3 L2 0 L4 3 Z\' fill=\'%23e6a23c\'/%3E%3C/svg%3E")',
          backgroundRepeat: 'repeat-x',
          backgroundPosition: 'bottom left',
          paddingBottom: '2px'
        },
        '.cm-lintPoint-error': {
          '&::after': {
            content: '""',
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            height: '4px',
            backgroundColor: 'var(--el-color-danger-light-5)'
          }
        },
        '.cm-tooltip-lint': {
          fontFamily: 'inherit',
          fontSize: '13px',
          border: '1px solid var(--el-border-color-light)',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          padding: '4px 0'
        },
        '.cm-tooltip-lint li': {
          padding: '4px 12px',
          cursor: 'pointer'
        },
        '.cm-tooltip-lint li:hover': {
          backgroundColor: 'var(--el-fill-color-light)'
        },
        '.cm-lintMarker': {
          width: '4px',
          marginLeft: '2px'
        },
        '.cm-lintMarker-error': {
          backgroundColor: 'var(--el-color-danger)'
        },
        '.cm-lintMarker-warning': {
          backgroundColor: 'var(--el-color-warning)'
        }
      }),
      selectionThemeCompartment.current.of(getSelectionThemeExtension()),
      EditorView.contentAttributes.of({
        'data-placeholder': placeholderRef.current
      }),
      EditorView.baseTheme({
        '.cm-content[data-placeholder]:empty::before': {
          content: 'attr(data-placeholder)',
          color: 'var(--el-text-color-placeholder)',
          pointerEvents: 'none',
          position: 'absolute',
          padding: '0 12px'
        }
      })
    ]
  }

  // 更新选中状态
  const updateSelectionState = (state: any) => {
    const selection = state.selection.main
    const hasSel = selection && selection.from !== selection.to
    if (hasSel) {
      setHasSelection(true)
      hasSelectionRef.current = true
      const sel = state.doc.sliceString(selection.from, selection.to)
      setSelectedSql(sel)
      selectedSqlRef.current = sel
      // 保存选择范围
      savedSelectionRef.current = {
        from: selection.from,
        to: selection.to
      }
      console.log('选中SQL:', sel, '范围:', savedSelectionRef.current)
    } else {
      setHasSelection(false)
      hasSelectionRef.current = false
      setSelectedSql('')
      selectedSqlRef.current = ''
      savedSelectionRef.current = null
    }
  }

  // 获取光标位置的当前SQL语句（用于多条SQL的情况）
  const getCurrentStatement = (): string => {
    if (!editor.current) return ''

    const state = editor.current.state
    const cursorPos = state.selection.main.head
    const fullText = state.doc.toString()

    // 按分号分割SQL语句
    const statements: { sql: string; start: number; end: number }[] = []
    let start = 0
    let inString = false
    let stringChar = ''

    for (let i = 0; i < fullText.length; i++) {
      const char = fullText[i]

      // 处理字符串内的分号
      if ((char === "'" || char === '"' || char === '`') && !inString) {
        inString = true
        stringChar = char
      } else if (char === stringChar && inString) {
        inString = false
        stringChar = ''
      }

      // 遇到分号且不在字符串内，分割语句
      if (char === ';' && !inString) {
        const stmt = fullText.slice(start, i).trim()
        if (stmt) {
          statements.push({
            sql: stmt,
            start: start,
            end: i
          })
        }
        start = i + 1
      }
    }

    // 最后一条语句（可能没有分号结尾）
    const lastStmt = fullText.slice(start).trim()
    if (lastStmt) {
      statements.push({
        sql: lastStmt,
        start: start,
        end: fullText.length
      })
    }

    // 如果只有一条语句，直接返回
    if (statements.length <= 1) {
      return fullText.trim()
    }

    // 找到光标所在的语句
    for (const stmt of statements) {
      if (cursorPos >= stmt.start && cursorPos <= stmt.end) {
        return stmt.sql
      }
    }

    // 默认返回第一条
    return statements[0]?.sql || fullText.trim()
  }

  // 获取要执行的SQL（优先选中的，否则当前语句）
  const getSqlToRun = (): string => {
    console.log(
      'getSqlToRun - hasSelection:',
      hasSelectionRef.current,
      'selectedSql:',
      selectedSqlRef.current,
      'savedSelection:',
      savedSelectionRef.current
    )

    if (hasSelectionRef.current && selectedSqlRef.current.trim()) {
      console.log('执行选中的SQL:', selectedSqlRef.current.trim())
      return selectedSqlRef.current.trim()
    }
    const stmt = getCurrentStatement()
    console.log('执行光标所在语句:', stmt)
    return stmt
  }

  // 执行
  const handleRun = () => {
    if (!isRunning && computeHasContent() && !hasErrors) {
      // 如果有保存的选择，恢复选择并高亮显示
      if (savedSelectionRef.current && editor.current) {
        // 恢复编辑器焦点
        editor.current.focus()

        // 恢复选择范围
        editor.current.dispatch({
          selection: EditorSelection.create([
            EditorSelection.range(savedSelectionRef.current.from, savedSelectionRef.current.to)
          ]),
          scrollIntoView: true
        })

        console.log('执行选中SQL:', selectedSqlRef.current)
      }

      const s = getSqlToRun()
      onRun?.(s)
    }
  }

  // 取消
  const handleCancel = () => {
    onCancel?.()
  }

  // 工具栏鼠标按下事件 - 保存当前选择状态
  const handleToolbarMouseDown = () => {
    // 保存当前选择状态（不阻止默认行为，让按钮正常工作）
    if (editor.current) {
      const state = editor.current.state
      const selection = state.selection.main
      if (selection.from !== selection.to) {
        savedSelectionRef.current = {
          from: selection.from,
          to: selection.to
        }
        const sel = state.doc.sliceString(selection.from, selection.to)
        setSelectedSql(sel)
        selectedSqlRef.current = sel
        setHasSelection(true)
        hasSelectionRef.current = true
        console.log('工具栏点击前保存选择:', sel)
      }
    }
  }

  /** 获取要格式化的区间：有选区则只格式化选区（与运行逻辑一致），否则全文 */
  const getFormatRange = () => {
    if (!editor.current) return null
    const state = editor.current.state
    const doc = state.doc
    const len = doc.length
    const main = state.selection.main

    if (main.from !== main.to) {
      const from = Math.max(0, Math.min(main.from, len))
      const to = Math.max(from, Math.min(main.to, len))
      const slice = doc.sliceString(from, to)
      if (slice.trim()) return { from, to, text: slice }
    }

    if (savedSelectionRef.current) {
      const { from: sf, to: st } = savedSelectionRef.current
      if (sf !== st && sf >= 0 && st <= len && sf < st) {
        const slice = doc.sliceString(sf, st)
        if (slice.trim()) return { from: sf, to: st, text: slice }
      }
    }

    const all = doc.toString()
    if (!all.trim()) return null
    return { from: 0, to: len, text: all }
  }

  // 格式化SQL
  const handleFormat = () => {
    if (!editor.current) return

    const range = getFormatRange()
    if (!range) return

    try {
      const formatted = formatSql(range.text.trim(), {
        language: 'sql',
        tabWidth: 2,
        keywordCase: 'upper',
        linesBetweenQueries: 2
      })
      const insertFrom = range.from
      const insertTo = range.to
      editor.current.dispatch({
        changes: {
          from: insertFrom,
          to: insertTo,
          insert: formatted
        },
        selection: EditorSelection.create([
          EditorSelection.range(insertFrom, insertFrom + formatted.length)
        ]),
        scrollIntoView: true
      })
      onUpdateModelValue?.(editor.current.state.doc.toString())
      updateSelectionState(editor.current.state)
    } catch (e) {
      console.error('SQL format error:', e)
    }
  }

  // 清空
  const handleClear = () => {
    if (!editor.current) return
    editor.current.dispatch({
      changes: {
        from: 0,
        to: editor.current.state.doc.length,
        insert: ''
      }
    })
    onUpdateModelValue?.('')
  }

  // ===== 生命周期 =====

  // onMounted / onUnmounted
  useEffect(() => {
    editor.current = new EditorView({
      doc: modelValue || '',
      extensions: createExtensions(),
      parent: editorRef.current as HTMLDivElement
    })
    // 初始化选中状态
    updateSelectionState(editor.current.state)

    return () => {
      editor.current?.destroy()
      editor.current = null
    }
    // 仅挂载一次（对齐 onMounted）；后续同步走下面的 watch-style effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // watch(() => props.modelValue)
  useEffect(() => {
    if (editor.current && modelValue !== editor.current.state.doc.toString()) {
      editor.current.dispatch({
        changes: {
          from: 0,
          to: editor.current.state.doc.length,
          insert: modelValue || ''
        }
      })
    }
  }, [modelValue])

  // watch(() => props.vividSelection)
  useEffect(() => {
    if (!editor.current) return
    editor.current.dispatch({
      effects: selectionThemeCompartment.current.reconfigure(getSelectionThemeExtension())
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vividSelection])

  // watch([() => props.tables, () => props.columns], ..., { deep: true })
  useEffect(() => {
    if (editor.current) {
      editor.current.dispatch({
        effects: completionCompartment.current.reconfigure(
          createCompletionExtension(tables, columns)
        )
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, columns])

  // defineExpose → useImperativeHandle
  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor.current?.focus(),
      getValue: () => editor.current?.state.doc.toString() || '',
      setValue: (val: string) => {
        if (editor.current) {
          editor.current.dispatch({
            changes: {
              from: 0,
              to: editor.current.state.doc.length,
              insert: val || ''
            }
          })
        }
      },
      format: handleFormat,
      clear: handleClear,
      hasErrors: () => internalErrorsRef.current.length > 0,
      getErrors: () => internalErrorsRef.current,
      getSelectedSql: () => selectedSqlRef.current,
      hasSelection: () => hasSelectionRef.current,
      getSqlToRun: getSqlToRun
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return (
    <div
      className={`${styles.sqlEditorCm} sql-editor-cm ${showToolbar ? 'with-toolbar' : ''} ${hasErrors ? styles.hasErrors : ''}`}
    >
      {/* 工具栏 */}
      {showToolbar && (
        <div
          className={`${styles.sqlToolbar} sql-toolbar`}
          onMouseDownCapture={handleToolbarMouseDown}
        >
          <div className={styles.toolbarLeft}>
            {/* 执行按钮 */}
            <Button
              variant="filled"
              size="xs"
              loading={isRunning}
              disabled={!hasContent || isRunning || hasErrors}
              onClick={handleRun}
            >
              {shouldShowRunSelected
                ? t('database.query.runSelected')
                : isRunning
                  ? t('database.query.running')
                  : t('database.query.run')}
            </Button>
            {/* 暂停按钮 */}
            {isRunning && (
              <Button variant="filled" color="yellow" size="xs" onClick={handleCancel}>
                {t('database.query.cancel')}
              </Button>
            )}
            {/* 选中SQL预览 */}
            {showSelectionPreview && shouldShowRunSelected && (
              <Popover width={400} position="bottom" withArrow shadow="md">
                <Popover.Target>
                  <span className={styles.selectedSqlTag}>
                    <span
                      style={{
                        display: 'inline-block',
                        maxWidth: 200,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--el-color-success)',
                        cursor: 'pointer'
                      }}
                    >
                      {selectedSqlPreview}
                    </span>
                  </span>
                </Popover.Target>
                <Popover.Dropdown>
                  <pre className={styles.selectedSqlPopover}>{selectedSql}</pre>
                </Popover.Dropdown>
              </Popover>
            )}
            {/* 语法错误提示 */}
            {errorSummary && (
              <Tooltip label={errorSummary} position="bottom" color="gray">
                <span className={styles.errorTag} style={{ color: 'var(--el-color-danger)' }}>
                  <ElSvgIcon name="WarningFilled" size={14} />
                  {errorCount} {t('database.query.syntaxError')}
                </span>
              </Tooltip>
            )}
          </div>
          <div className={styles.toolbarRight}>
            <Button.Group>
              {/* 格式化 */}
              <Tooltip label={t('database.query.formatSql')} position="top">
                <Button
                  variant="default"
                  size="xs"
                  disabled={!hasContent}
                  onClick={handleFormat}
                  px={8}
                >
                  <ElSvgIcon name="MagicStick" size={14} />
                </Button>
              </Tooltip>
              {/* 清空 */}
              <Tooltip label={t('database.query.clearInput')} position="top">
                <Button
                  variant="default"
                  size="xs"
                  disabled={!hasContent}
                  onClick={handleClear}
                  px={8}
                >
                  <ElSvgIcon name="Delete" size={14} />
                </Button>
              </Tooltip>
            </Button.Group>
          </div>
        </div>
      )}
      <div ref={editorRef} className={`${styles.editorContent} editor-content`}></div>
      {/* 状态栏 */}
      {showStatusBar && (
        <div className={`${styles.sqlStatusBar} sql-status-bar`}>
          <span className={styles.statusItem}>
            {isRunning ? (
              <span className={styles.isLoading} style={{ display: 'inline-flex' }}>
                <ElSvgIcon name="Loading" size={14} />
              </span>
            ) : hasErrors ? (
              <span className={`${styles.errorIcon} error-icon`} style={{ display: 'inline-flex' }}>
                <ElSvgIcon name="WarningFilled" size={14} />
              </span>
            ) : null}
            <span>{statusText}</span>
          </span>
          <span className={`${styles.statusItem} ${styles.shortcutHint}`}>
            Ctrl+Enter {t('database.query.shortcutRun')} | Ctrl+Space{' '}
            {t('database.query.shortcutComplete')}
          </span>
        </div>
      )}
    </div>
  )
})

export default SqlEditor

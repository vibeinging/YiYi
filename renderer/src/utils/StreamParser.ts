/**
 * 流式消息解析器
 *
 * 统一处理：
 * 1. 流式输出的实时解析
 * 2. 历史消息的解析
 */

export class StreamParser {
  handlers: Record<string, any>

  constructor() {
    this.handlers = {
      content_stream: this.handleContentStream.bind(this),
      status_update: this.handleStatusUpdate.bind(this),
      complete: this.handleComplete.bind(this),
      error: this.handleError.bind(this),
      task_failed: this.handleError.bind(this),
      connection_established: this.handleConnectionEstablished.bind(this)
    }
  }

  // ============ 流式事件处理 ============

  parseEvent(payload: any, streamingMessage: any, addContentItem: any) {
    const eventType = payload?.type || 'unknown'
    const handler = this.handlers[eventType]

    if (handler) {
      handler(payload, streamingMessage, addContentItem)
    } else {
      // 未知类型，如果有 content_id 则当作 content_stream 处理
      if (payload && payload.content_id && payload.content !== undefined) {
        this.handleContentStream(payload, streamingMessage, addContentItem)
      }
    }
  }

  handleContentStream(event: any, streamingMessage: any, addContentItem: any) {
    const { content_id, content_type, content, session_id, title, metadata = {}, summary } = event

    // 验证session_id
    if (session_id && streamingMessage.sessionId && session_id !== streamingMessage.sessionId) {
      return
    }

    if (!streamingMessage.content_items) {
      streamingMessage.content_items = []
    }

    let block = this.findContentBlock(streamingMessage, content_id)

    // display_type 从 content 获取
    const displayType = (content && typeof content === 'object' && content.display_type)
      ? content.display_type
      : content_type

    const isObjectContent = content && typeof content === 'object'

    if (!block) {
      block = {
        id: content_id,
        type: content_type,
        content: isObjectContent ? null : '',
        title: title || this.getDefaultTitle(content_type, displayType),
        summary: summary,  // 提取 summary 到顶层
        metadata: { ...metadata },
        is_streaming: true,
        is_complete: false,
        savable_to_panel: metadata.savable_to_panel || false,
        display_type: displayType
      }
      streamingMessage.content_items.push(block)
    } else {
      // 同一 content_id 的后续流式事件可能补充 metadata/task_group/title，
      // 需要持续合并到已存在 block，避免任务归组和展示信息丢失。
      block.metadata = {
        ...(block.metadata || {}),
        ...(metadata || {})
      }

      if (summary !== undefined) {
        block.summary = summary
      }
      if (title) {
        block.title = title
      }
      if (displayType) {
        block.display_type = displayType
      }
      if (content_type) {
        block.type = content_type
      }
      if (metadata.savable_to_panel !== undefined) {
        block.savable_to_panel = Boolean(block.savable_to_panel || metadata.savable_to_panel)
      }
    }

    // 如果 metadata 含 task_plan，更新到消息顶层（最新的覆盖旧的）
    if (metadata.task_plan && Array.isArray(metadata.task_plan)) {
      streamingMessage.task_plan = metadata.task_plan
    }

    // 如果 metadata 含 executor_info，更新到消息顶层
    if (metadata.executor_info && typeof metadata.executor_info === 'object') {
      streamingMessage.executor_info = metadata.executor_info
    }

    const replaceContent = metadata.replace_content === true

    // 累积内容
    if (content !== undefined && content !== null) {
      if (isObjectContent) {
        block.content = content
        if (content.display_type) {
          block.display_type = content.display_type
        }
      } else if (typeof content === 'string') {
        if (replaceContent || typeof block.content !== 'string') {
          block.content = content
        } else if (typeof block.content === 'string') {
          block.content += content
        }
      }
    }

    if (addContentItem) {
      addContentItem({
        id: block.id,
        type: block.type,
        content: block.content,
        title: block.title,
        summary: block.summary,  // 传递 summary
        metadata: block.metadata || {},
        is_streaming: block.is_streaming,
        is_complete: block.is_complete,
        display_type: block.display_type,
        savable_to_panel: block.savable_to_panel
      })
    }

    streamingMessage.status = 'processing'
  }

  handleStatusUpdate(event: any, streamingMessage: any) {
    streamingMessage.status = event.status || 'processing'
    streamingMessage.statusMessage = event.message || '处理中...'
  }

  handleConnectionEstablished(event: any, streamingMessage: any) {
    streamingMessage.status = 'connected'
    streamingMessage.statusMessage = '连接已建立'
  }

  handleComplete(event: any, streamingMessage: any) {
    streamingMessage.status = 'completed'
    streamingMessage.statusMessage = event.message || '处理完成'
    streamingMessage.is_streaming = false
  }

  handleError(event: any, streamingMessage: any, addContentItem: any) {
    // task_failed 事件的错误文本在 error 字段；error 事件在 message/content
    const errorMessage = event.error || event.message || event.content || '处理失败'

    if (addContentItem) {
      addContentItem({
        type: 'error',
        content: errorMessage,
        title: '错误'
      })
    }

    streamingMessage.status = 'error'
    streamingMessage.statusMessage = errorMessage
    streamingMessage.is_streaming = false
  }

  // ============ 历史消息解析 ============

  /**
   * 解析历史消息，统一格式
   * @param {Object} msg - 后端返回的消息对象
   * @returns {Object} - 标准化的消息对象
   */
  parseHistoryMessage(msg: any) {
    // 容错:后端可能把 content_items 序列化成 JSON 字符串返回(桌面 Node 后端即如此),
    // 先尝试解析成数组,使下方「已有 content_items」分支生效。原 Vue 后端返回的是数组。
    if (typeof msg.content_items === 'string') {
      try {
        const parsed = JSON.parse(msg.content_items)
        if (Array.isArray(parsed)) msg = { ...msg, content_items: parsed }
      } catch {
        /* 非 JSON 字符串,保持原样,走后续兜底 */
      }
    }
    // 已有 content_items，直接标准化
    if (msg.content_items && Array.isArray(msg.content_items)) {
      // 从 content_items 的 metadata 中提取 task_plan 到消息顶层（取最后一个）
      let taskPlan = msg.task_plan || msg.message_metadata?.task_plan || null
      let executorInfo = msg.executor_info || msg.message_metadata?.executor_info || null
      for (const item of msg.content_items) {
        if (item.metadata?.task_plan && Array.isArray(item.metadata.task_plan)) {
          taskPlan = item.metadata.task_plan
        }
        if (item.metadata?.executor_info && typeof item.metadata.executor_info === 'object') {
          executorInfo = item.metadata.executor_info
        }
      }
      return {
        ...msg,
        is_streaming: false,
        task_plan: taskPlan,
        executor_info: executorInfo,
        content_items: msg.content_items.map((item: any) => this.normalizeContentItem(item))
      }
    }

    // 有 content 字段，尝试解析
    if (msg.content) {
      const contentItems = this.parseContentField(msg.content, msg.id)
      if (contentItems) {
        return {
          ...msg,
          is_streaming: false,
          content_items: contentItems
        }
      }
    }

    // 无内容
    return {
      ...msg,
      is_streaming: false,
      content_items: []
    }
  }

  /**
   * 解析 content 字段
   */
  parseContentField(content: any, msgId: any) {
    // 如果已经是数组
    if (Array.isArray(content)) {
      return content.map((item: any) => this.normalizeContentItem(item))
    }

    // 尝试 JSON 解析
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content)

        // 解析结果是数组
        if (Array.isArray(parsed)) {
          return parsed.map((item: any) => this.normalizeContentItem(item))
        }

        // 解析结果有 content_items 字段
        if (parsed && Array.isArray(parsed.content_items)) {
          return parsed.content_items.map((item: any) => this.normalizeContentItem(item))
        }

        // 解析结果是单个对象，包装成内容块
        if (parsed && typeof parsed === 'object') {
          return [this.normalizeContentItem({
            id: `${msgId}_content`,
            type: parsed.type || 'json',
            content: parsed,
            display_type: parsed.display_type
          })]
        }
      } catch (e) {
        // JSON 解析失败，当作纯文本
        return [{
          id: `${msgId}_content`,
          type: 'text',
          content: content,
          title: null,
          metadata: {},
          is_streaming: false,
          is_complete: true,
          savable_to_panel: false,
          display_type: 'text'
        }]
      }
    }

    return null
  }

  /**
   * 标准化内容块
   */
  normalizeContentItem(item: any) {
    // display_type 优先从 item 本身取，其次从 content 取，最后 fallback 到 type
    let displayType = item.display_type
    if (!displayType && item.content && typeof item.content === 'object') {
      displayType = item.content.display_type
    }
    if (!displayType) {
      displayType = item.type || 'text'
    }

    return {
      id: item.id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
      type: item.type || 'text',
      content: item.content,
      title: item.title || null,
      summary: item.summary,  // 支持 summary 字段
      metadata: item.metadata || {},
      is_streaming: false,
      is_complete: true,
      savable_to_panel: item.savable_to_panel || item.metadata?.savable_to_panel || false,
      display_type: displayType
    }
  }

  // ============ 工具方法 ============

  findContentBlock(streamingMessage: any, contentId: any) {
    if (!streamingMessage.content_items) {
      return null
    }
    return streamingMessage.content_items.find((block: any) => block.id === contentId)
  }

  getDefaultTitle(contentType: any, displayType: any) {
    if (displayType) {
      const displayTitles: Record<string, string> = {
        table: '查询结果',
        bar: '柱状图',
        line: '折线图',
        pie: '饼图',
        text: '文本内容'
      }
      if (displayTitles[displayType]) {
        return displayTitles[displayType]
      }
    }

    const titles: Record<string, string> = {
      text: '文本',
      markdown: '内容',
      json: '数据',
      table: '查询结果',
      sql: 'SQL查询',
      error: '错误信息',
      html: '研究报告',
      user_input: '请选择'
    }
    return titles[contentType] || '内容'
  }

  reset() {
    // 无状态
  }
}

export const defaultStreamParser = new StreamParser()

// 流式事件解析
export function parseStreamEvent(payload: any, streamingMessage: any, addContentItem: any) {
  return defaultStreamParser.parseEvent(payload, streamingMessage, addContentItem)
}

// 历史消息解析
export function parseHistoryMessage(msg: any) {
  return defaultStreamParser.parseHistoryMessage(msg)
}

// 批量解析一组历史消息：过滤掉「用户对消歧输入的回显」消息（避免重复展示），再逐条标准化。
// 会话页与分享只读页共用，保证 is_user_input_response 过滤契约只有一处。
export function parseHistoryMessages(rawMessages: any) {
  return (rawMessages || [])
    .filter((msg: any) => !(msg.role === 'user' && msg.message_metadata?.is_user_input_response))
    .map((msg: any) => defaultStreamParser.parseHistoryMessage(msg))
}

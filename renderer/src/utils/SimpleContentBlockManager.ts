/**
 * 内容块管理器
 *
 * 设计原则：
 * 1. 简单的数组操作
 * 2. 没有复杂的状态管理
 * 3. 直接映射后端ContentBlock格式
 */

export class SimpleContentBlockManager {
  blocks: Map<any, any>
  order: any[]

  constructor() {
    this.blocks = new Map() // id -> block
    this.order = [] // 添加顺序
  }

  // 处理事件 - 统一接口
  handleEvent(event: any) {
    const eventType = event.type

    if (eventType === 'content_start') {
      this.addBlock(event)
    } else if (eventType === 'content_stream') {
      this.updateBlock(event)
    } else if (eventType === 'content_end') {
      this.completeBlock(event)
    }
  }

  // 添加新块
  addBlock(event: any) {
    const { content_id, content_type, title, content = '' } = event

    const block = {
      id: content_id,
      type: content_type,
      content: content,
      title: title || this.getDefaultTitle(content_type),
      is_streaming: true,
      is_complete: false
    }

    this.blocks.set(content_id, block)
    this.order.push(content_id)
  }

  // 更新块内容
  updateBlock(event: any) {
    const { content_id, content } = event
    const block = this.blocks.get(content_id)

    if (block) {
      if (typeof block.content === 'string') {
        block.content += content
      } else {
        block.content = content
      }
    }
  }

  // 完成块
  completeBlock(event: any) {
    const { content_id, final_data } = event
    const block = this.blocks.get(content_id)

    if (block) {
      block.is_streaming = false
      block.is_complete = true

      // 应用最终数据
      if (final_data) {
        Object.assign(block, final_data)
      }
    }
  }

  // 获取可渲染的内容
  getRenderableContentItems() {
    return this.order
      .map((id) => {
        const block = this.blocks.get(id)
        if (!block) return null

        // 跳过空的流式块
        if (block.is_streaming && !block.content) {
          return null
        }

        return {
          id: block.id,
          type: block.type,
          content: block.content,
          title: block.title,
          summary: block.summary,
          metadata: block.metadata || {}
        }
      })
      .filter(Boolean) // 移除null值
  }

  // 获取第一个可执行代码块
  getFirstExecutableCode() {
    for (const id of this.order) {
      const block = this.blocks.get(id)
      if (block && block.type === 'sql' && block.content) {
        return {
          content: block.content,
          metadata: block.metadata || {}
        }
      }
    }
    return null
  }

  // 获取状态
  getStatus() {
    const hasStreaming = Array.from(this.blocks.values()).some((block) => block.is_streaming)
    const hasCompleted = Array.from(this.blocks.values()).some((block) => block.is_complete)

    return {
      isComplete: !hasStreaming && hasCompleted,
      isEmpty: this.blocks.size === 0,
      progress: hasCompleted ? 100 : hasStreaming ? 50 : 0,
      message: hasStreaming ? '正在处理...' : hasCompleted ? '处理完成' : '准备就绪'
    }
  }

  // 重置管理器
  reset() {
    this.blocks.clear()
    this.order.length = 0
  }

  // 辅助方法：获取默认标题
  getDefaultTitle(contentType: any) {
    const titles: any = {
      text: '文本',
      markdown: '内容',
      table: '查询结果',
      chart: '数据可视化',
      sql: 'SQL查询',
      error: '错误信息'
    }
    return titles[contentType] || '内容'
  }
}

// 创建默认实例
export const defaultContentBlockManager = new SimpleContentBlockManager()

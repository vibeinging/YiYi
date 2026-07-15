import { useMemo } from 'react'
import { Loader } from '@mantine/core'
import marked from '@/utils/markdownConfig'
import styles from './ChatItem.module.scss'
import './ChatItem.global.scss'

interface Message {
  loading: boolean
  content: string
  role: string
  time: string
}

interface ChatItemProps {
  message: Message
}

export default function ChatItem({ message }: ChatItemProps) {
  // computed → useMemo:marked 渲染消息内容为 HTML
  const htmlContent = useMemo(() => {
    return marked.parse(message.content) as string
  }, [message.content])

  return (
    <div className={styles.chatItemContainer}>
      <div className={styles.terminalHeader}>
        <span className={styles.prompt}>$</span>
        <span className={styles.role}>{message.role}</span>
        <span className={styles.time}>{message.time}</span>
      </div>
      <div className={styles.terminalContent}>
        {!message.loading ? (
          <div dangerouslySetInnerHTML={{ __html: htmlContent }} />
        ) : (
          <div className={styles.loading}>
            <Loader size={20} color="#61afef" />
          </div>
        )}
      </div>
    </div>
  )
}

import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import { Button } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import { copyToClipboard } from '@/utils/clipboard'
import styles from './CodeBlock.module.scss'

interface CodeBlockProps {
  code: string
  language?: string
}

export default function CodeBlock({ code, language = 'text' }: CodeBlockProps) {
  const { t } = useTranslation()

  const handleCopy = async () => {
    const success = await copyToClipboard(code)
    if (success) {
      notifications.show({ color: 'green', message: t('project.codeBlock.copied') })
    } else {
      notifications.show({ color: 'red', message: t('project.codeBlock.copyFailed') })
    }
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.languageLabel}>{language}</span>
        <Button
          size="compact-sm"
          variant="subtle"
          className={styles.copyBtn}
          leftSection={<ElSvgIcon name="CopyDocument" />}
          onClick={handleCopy}
        >
          {t('project.codeBlock.copy')}
        </Button>
      </div>
      <pre className={styles.codeContent}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

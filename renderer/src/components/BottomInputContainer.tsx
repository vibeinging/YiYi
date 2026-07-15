import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionIcon, TextInput } from '@mantine/core'
import ElSvgIcon from './ElSvgIcon'
import styles from './BottomInputContainer.module.scss'

interface BottomInputContainerProps {
  placeholder?: string
  /** 对应原 Vue 具名 slot="left" */
  left?: ReactNode
  /** 对应原 defineEmits(['send-click']) */
  onSendClick?: (value: string) => void
}

export default function BottomInputContainer({
  placeholder = '',
  left,
  onSendClick,
}: BottomInputContainerProps) {
  const { t } = useTranslation()

  const [userInput, setUserInput] = useState('')

  const sendBtnDisabled = userInput === ''

  const handleSendClick = () => {
    onSendClick?.(userInput)
    setUserInput('')
  }

  const onKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSendClick()
    }
  }

  return (
    <div className={styles.bottomInputContainer}>
      {left ?? <div />}
      <div className={styles.inputContainer}>
        <TextInput
          value={userInput}
          placeholder={placeholder || t('common.inputPlaceholder')}
          size="sm"
          style={{ width: 'calc(100% - 40px)' }}
          onChange={(e) => setUserInput(e.currentTarget.value)}
          onKeyUp={onKeyUp}
        />
        <ActionIcon
          color="green"
          radius="xl"
          variant="filled"
          size="lg"
          disabled={sendBtnDisabled}
          onClick={handleSendClick}
        >
          <ElSvgIcon name="Promotion" size={22} />
        </ActionIcon>
      </div>
    </div>
  )
}

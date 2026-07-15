import styles from './TourStepGuide.module.scss'

interface TourStepGuideProps {
  variant: 'welcome' | 'sidebar' | 'dock' | 'featured' | 'minimal'
  text: string
  accent?: string
  /** 仅屏幕阅读器：视觉上无说明、靠高亮+箭头引导时使用 */
  srOnly?: string
}

export default function TourStepGuide({ variant, text, accent, srOnly }: TourStepGuideProps) {
  return (
    <div className={styles['tour-step']} data-variant={variant} role="note">
      {accent && <p className={styles['tour-step__chip']}>{accent}</p>}
      {text && <p className={styles['tour-step__hint']}>{text}</p>}
      {srOnly && <span className={styles['tour-step__sr-only']}>{srOnly}</span>}
    </div>
  )
}

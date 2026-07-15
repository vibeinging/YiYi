import styles from './NL2SQLIcon.module.scss'

// NL2SQL 图标：纯展示组件，无 props / 无逻辑，仅模板 + 动画样式
export default function NL2SQLIcon() {
  return (
    <div className={styles.nl2sqlIcon}>
      {/* 文字气泡 */}
      <div className={styles.textBubble}>
        <div className={styles.bubbleContent}>
          <div className={styles.textLines}>
            <div className={`${styles.textLine} ${styles.short}`} />
            <div className={`${styles.textLine} ${styles.long}`} />
            <div className={`${styles.textLine} ${styles.medium}`} />
          </div>
        </div>
      </div>

      {/* 转换箭头 */}
      <div className={styles.transformArrow}>
        <div className={styles.arrowBody} />
        <div className={styles.arrowHead} />
      </div>

      {/* SQL查询框 */}
      <div className={styles.sqlBox}>
        <div className={styles.sqlHeader}>
          <div className={`${styles.sqlDot} ${styles.red}`} />
          <div className={`${styles.sqlDot} ${styles.yellow}`} />
          <div className={`${styles.sqlDot} ${styles.green}`} />
        </div>
        <div className={styles.sqlContent}>
          <div className={styles.sqlKeyword}>SELECT</div>
          <div className={styles.sqlText}>*</div>
          <div className={styles.sqlKeyword}>FROM</div>
          <div className={styles.sqlTable}>table</div>
        </div>
      </div>
    </div>
  )
}

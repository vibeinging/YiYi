// 语义层(指标/视图/实体/样例/记忆)统一空状态 —— 对齐「数据库/结构化数据」的空状态:
// 顶部图标插画(中心 hub + 环绕小图标)+ 标题 + 描述 + 一行特性标签 + 操作按钮。
// 不再用长文本(功能/SQL 示例/核心价值),与数据库空状态保持一致的轻量风格。
import { type ReactNode } from 'react'
import styles from './SemanticEmptyState.module.scss'

export { styles as emptyStyles }

export interface EmptyFeature {
  icon?: ReactNode
  label: ReactNode
}

export interface SemanticEmptyStateProps {
  /** 中心 hub 图标(渐变方块内) */
  icon?: ReactNode
  /** 环绕的 0~2 个小图标(浮在 hub 两侧上方) */
  satellites?: ReactNode[]
  title: ReactNode
  description?: ReactNode
  /** 特性标签行(图标 + 短文字),对齐数据库空状态的 featureItem */
  features?: EmptyFeature[]
  /** 底部操作按钮(居中) */
  actions?: ReactNode
  /** 兜底额外内容(一般不用) */
  children?: ReactNode
}

export default function SemanticEmptyState({
  icon,
  satellites,
  title,
  description,
  features,
  actions,
  children
}: SemanticEmptyStateProps) {
  const sats = (satellites || []).filter(Boolean).slice(0, 2)

  return (
    <div className={styles.wrap}>
      <div className={styles.content}>
        {(icon || sats.length > 0) && (
          <div className={styles.illustration}>
            <div className={styles.illoContainer}>
              {sats[0] && <div className={`${styles.sat} ${styles.satLeft}`}>{sats[0]}</div>}
              {sats[1] && <div className={`${styles.sat} ${styles.satRight}`}>{sats[1]}</div>}
              {icon && <div className={styles.hub}>{icon}</div>}
            </div>
          </div>
        )}

        <div className={styles.intro}>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>

        {features && features.length > 0 && (
          <div className={styles.features}>
            {features.map((f, i) => (
              <div className={styles.featureItem} key={i}>
                {f.icon && <span className={styles.featureIcon}>{f.icon}</span>}
                <span>{f.label}</span>
              </div>
            ))}
          </div>
        )}

        {children}

        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  )
}

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './VersionUpdate.module.scss'

// 版本更新页：展示当前版本 + 时间线形式的更新日志(新功能/修复/优化)

const currentVersion = '1.1.1.20260430'
const releaseDate = '2026-04-30'

const changelogItemKeys: Record<string, string[]> = {
  feature: ['feature1', 'feature2', 'feature3', 'feature4', 'feature5', 'feature6'],
  fix: ['fix1', 'fix2', 'fix3', 'fix4', 'fix5'],
  improve: ['improve1', 'improve2', 'improve3', 'improve4'],
}

// 分类 type → i18n label key
function labelKey(type: string) {
  return `admin.version.${type === 'feature' ? 'newFeatures' : type === 'fix' ? 'bugFixes' : 'improvements'}`
}

export default function VersionUpdate() {
  const { t } = useTranslation()

  const changelog = useMemo(
    () => [
      {
        type: 'feature',
        items: changelogItemKeys.feature.map((itemKey) => t(`admin.version.changelogItems.${itemKey}`)),
      },
      {
        type: 'fix',
        items: changelogItemKeys.fix.map((itemKey) => t(`admin.version.changelogItems.${itemKey}`)),
      },
      {
        type: 'improve',
        items: changelogItemKeys.improve.map((itemKey) => t(`admin.version.changelogItems.${itemKey}`)),
      },
    ],
    [t],
  )

  return (
    <div className={styles.versionPage}>
      <div className={styles.versionScroll}>
        {/* 顶部版本标识 */}
        <header className={styles.versionMasthead}>
          <div className={styles.mastheadLeft}>
            <span className={styles.productName}>YiW</span>
            <span className={styles.versionTag}>v{currentVersion}</span>
          </div>
          <time className={styles.releaseDate}>{releaseDate}</time>
        </header>

        {/* 统计概览 */}
        <div className={styles.statsRow}>
          {changelog.map((cat) => (
            <div key={cat.type} className={`${styles.statChip} ${styles[cat.type]}`}>
              <span className={styles.statCount}>{cat.items.length}</span>
              <span className={styles.statLabel}>{t(labelKey(cat.type))}</span>
            </div>
          ))}
        </div>

        {/* 时间线 */}
        <div className={styles.timeline}>
          {changelog.map((cat, ci) => (
            <div key={cat.type} className={styles.timelineGroup}>
              {/* 分类标记 */}
              <div className={`${styles.timelineSectionLabel} ${styles[cat.type]}`}>
                <span className={styles.sectionLine} />
                <span className={styles.sectionText}>{t(labelKey(cat.type))}</span>
              </div>

              {/* 条目 */}
              {cat.items.map((item, i) => (
                <div
                  key={`${cat.type}-${i}`}
                  className={`${styles.timelineItem} ${styles[cat.type]}`}
                  style={{ '--delay': `${ci * 120 + i * 60}ms` } as React.CSSProperties}
                >
                  <div className={styles.timelineTrack}>
                    <span className={styles.timelineNode} />
                    {!(ci === changelog.length - 1 && i === cat.items.length - 1) && (
                      <span className={styles.timelineRail} />
                    )}
                  </div>
                  <div className={styles.timelineBody}>
                    <p className={styles.itemText}>{item}</p>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* 终点 */}
          <div className={styles.timelineEnd}>
            <span className={styles.endDot} />
          </div>
        </div>
      </div>
    </div>
  )
}

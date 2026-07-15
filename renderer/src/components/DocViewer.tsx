import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Drawer } from '@mantine/core'
import ElSvgIcon from './ElSvgIcon'
import MarkdownRenderer from './MarkdownRenderer'
import { loadNavigation, loadMarkdown, flattenNavigation } from '@/utils/docsLoader'
import styles from './DocViewer.module.scss'
import './DocViewer.global.scss'

export interface DocViewerProps {
  /** 文档类型：'user' 或 'developer' */
  docType: string
  /** 文档标题 */
  title?: string
  /** 主题 */
  theme?: 'dark' | 'light' | 'github'
}

export default function DocViewer({ docType, title = '文档', theme = 'light' }: DocViewerProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [navigation, setNavigation] = useState<any>({ sections: [] })
  const [markdownContent, setMarkdownContent] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [expandedSections, setExpandedSections] = useState<string[]>([])
  const [expandedItems, setExpandedItems] = useState<string[]>([])
  const [toc, setToc] = useState<any[]>([])
  const [activeHeading, setActiveHeading] = useState('')
  const [flatDocs, setFlatDocs] = useState<any[]>([])
  const [markdownDrawerOpen, setMarkdownDrawerOpen] = useState(false)
  const [copySucceeded, setCopySucceeded] = useState(false)
  const [viewportWidth, setViewportWidth] = useState<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1440
  )

  // 用 ref 保存最新值,供事件回调(scroll)与异步流程读取,避免闭包过期
  const tocRef = useRef(toc)
  tocRef.current = toc
  const flatDocsRef = useRef(flatDocs)
  flatDocsRef.current = flatDocs
  const navigationRef = useRef(navigation)
  navigationRef.current = navigation
  const markdownContentRef = useRef(markdownContent)
  markdownContentRef.current = markdownContent
  const copyTimerRef = useRef<number | null>(null)

  const currentDoc = useMemo(
    () => flatDocs.find((doc) => doc.path === currentPath) || null,
    [flatDocs, currentPath]
  )

  const currentSectionTitle = useMemo(() => {
    const section = navigation.sections.find((sectionItem: any) =>
      (sectionItem.children || []).some((item: any) => {
        if (item.path === currentPath) return true
        return (item.children || []).some((child: any) => child.path === currentPath)
      })
    )
    return section?.title || title
  }, [navigation, currentPath, title])

  const inlineToc = useMemo(() => toc.filter((item) => item.level === 2), [toc])

  const copyButtonLabel = useMemo(
    () => (copySucceeded ? t('docs.viewer.copySuccess') : t('docs.viewer.copyMarkdown')),
    [copySucceeded, t]
  )

  const drawerSize = useMemo(() => {
    if (viewportWidth <= 768) return '100%'
    if (viewportWidth <= 1200) return '68%'
    return '55%'
  }, [viewportWidth])

  const prevDoc = useMemo(() => {
    const index = flatDocs.findIndex((doc) => doc.path === currentPath)
    return index > 0 ? flatDocs[index - 1] : null
  }, [flatDocs, currentPath])

  const nextDoc = useMemo(() => {
    const index = flatDocs.findIndex((doc) => doc.path === currentPath)
    return index >= 0 && index < flatDocs.length - 1 ? flatDocs[index + 1] : null
  }, [flatDocs, currentPath])

  const resetDocScroll = () => {
    window.scrollTo({ top: 0, behavior: 'auto' })

    const scrollingElement = document.scrollingElement
    if (scrollingElement) {
      scrollingElement.scrollTop = 0
    }

    const scrollContainers = document.querySelectorAll('.main-container, .app-main')
    scrollContainers.forEach((container) => {
      ;(container as HTMLElement).scrollTop = 0
    })
  }

  const ensureExpandedForPath = (path: string) => {
    const expandedSectionSet = new Set<string>()
    const expandedItemSet = new Set<string>()

    for (const section of navigationRef.current.sections || []) {
      const matchesSection = path.startsWith(section.path)
      if (matchesSection) {
        expandedSectionSet.add(section.path)
      }

      for (const item of section.children || []) {
        if (item.children?.some((child: any) => child.path === path) || item.path === path) {
          expandedSectionSet.add(section.path)
          if (item.children?.length) {
            expandedItemSet.add(item.path)
          }
        }
      }
    }

    setExpandedSections([...expandedSectionSet])
    setExpandedItems([...expandedItemSet])
  }

  const toggleSection = (path: string) => {
    setExpandedSections((prev) => {
      const index = prev.indexOf(path)
      if (index > -1) {
        const next = [...prev]
        next.splice(index, 1)
        return next
      }
      return [...prev, path]
    })
  }

  const toggleItem = (path: string) => {
    setExpandedItems((prev) => {
      const index = prev.indexOf(path)
      if (index > -1) {
        const next = [...prev]
        next.splice(index, 1)
        return next
      }
      return [...prev, path]
    })
  }

  const navigateTo = (item: any) => {
    if (!item.file || item.path === currentPath) {
      setMobileMenuOpen(false)
      return
    }

    setMobileMenuOpen(false)
    navigate(item.path)
  }

  const handleTocReady = (tocItems: any) => {
    setToc(tocItems)
  }

  const scrollToHeading = (id: string) => {
    const element = document.getElementById(id)
    if (!element) return

    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveHeading(id)
  }

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdownContentRef.current || '')
      setCopySucceeded(true)
      copyTimerRef.current = window.setTimeout(() => {
        setCopySucceeded(false)
      }, 2000)
    } catch (error) {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = markdownContentRef.current || ''
        textarea.setAttribute('readonly', 'true')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        setCopySucceeded(true)
        copyTimerRef.current = window.setTimeout(() => {
          setCopySucceeded(false)
        }, 2000)
      } catch (fallbackError) {
        console.error('Failed to copy markdown:', error, fallbackError)
      }
    }
  }

  const loadDocByRoute = async () => {
    const routePath = location.pathname
    const doc = flatDocsRef.current.find((item) => item.path === routePath)

    if (!doc) {
      navigate('/404', { replace: true })
      return
    }

    setCurrentPath(doc.path)
    ensureExpandedForPath(doc.path)
    resetDocScroll()
    setActiveHeading('')

    try {
      const content = await loadMarkdown(docType, doc.file)
      setMarkdownContent(content)
      // 等待 DOM 更新后再复位滚动(对应原 nextTick)
      requestAnimationFrame(() => {
        resetDocScroll()
      })
    } catch (error: any) {
      console.error('Failed to load document:', error)
      setMarkdownContent(`# 加载失败\n\n${error.message}`)
    }
  }

  // 初始化:加载导航 + 首篇文档,绑定滚动/尺寸监听(对应 onMounted/onUnmounted)
  useEffect(() => {
    document.documentElement.style.background = '#f5f7fb'
    document.body.style.background = '#f5f7fb'

    let scrollHandler: (() => void) | null = null
    let resizeHandler: (() => void) | null = null

    const init = async () => {
      const nav = await loadNavigation(docType)
      const flat = flattenNavigation(nav)
      setNavigation(nav)
      setFlatDocs(flat)
      navigationRef.current = nav
      flatDocsRef.current = flat

      await loadDocByRoute()

      scrollHandler = () => {
        const headings = tocRef.current
          .map((item) => ({
            id: item.id,
            element: document.getElementById(item.id),
          }))
          .filter((item) => item.element)

        const scrollPos = window.scrollY + 120

        for (let i = headings.length - 1; i >= 0; i -= 1) {
          const { id, element } = headings[i]
          if ((element as HTMLElement).offsetTop <= scrollPos) {
            setActiveHeading(id)
            return
          }
        }

        setActiveHeading(headings[0]?.id || '')
      }

      window.addEventListener('scroll', scrollHandler, { passive: true })

      resizeHandler = () => {
        setViewportWidth(window.innerWidth)
      }
      window.addEventListener('resize', resizeHandler, { passive: true })
    }

    init()

    return () => {
      document.documentElement.style.background = ''
      document.body.style.background = ''

      if (scrollHandler) {
        window.removeEventListener('scroll', scrollHandler)
      }
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler)
      }
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听路由变化重新加载文档(对应 watch(() => route.path))
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    loadDocByRoute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  return (
    <div
      className={`${styles.docViewer} ${theme}${mobileMenuOpen ? ` ${styles.mobileMenuOpen}` : ''}`}
    >
      <header className={styles.docHeader}>
        <div className={styles.headerContent}>
          <div className={styles.headerBrand}>
            <Link to="/docs" className={styles.brandLink}>
              <span className={styles.brandName}>YiW Docs</span>
            </Link>
          </div>

          <button
            className={styles.mobileMenuBtn}
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            <ElSvgIcon name="Menu" size={16} />
            <span>{t('docs.viewer.openNavigation')}</span>
          </button>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className={styles.mobileOverlay} onClick={() => setMobileMenuOpen(false)}></div>
      )}

      <div className={styles.docContainer}>
        <aside className={styles.docSidebar}>
          <nav className={styles.sidebarNav}>
            {navigation.sections.map((section: any) => (
              <div key={section.path} className={styles.navSection}>
                <button
                  className={`${styles.navSectionTitle}${
                    expandedSections.includes(section.path) ? ` ${styles.expanded}` : ''
                  }`}
                  type="button"
                  onClick={() => toggleSection(section.path)}
                >
                  <span className={styles.sectionText}>{section.title}</span>
                  <ElSvgIcon name="ArrowRight" size={12} />
                </button>

                <div
                  className={styles.navItems}
                  style={{ display: expandedSections.includes(section.path) ? undefined : 'none' }}
                >
                  {(section.children || []).map((item: any) =>
                    item.children && item.children.length > 0 ? (
                      <div key={item.path}>
                        <button
                          className={`${styles.navItem} ${styles.parent}${
                            expandedItems.includes(item.path) ? ` ${styles.expanded}` : ''
                          }`}
                          type="button"
                          onClick={() => toggleItem(item.path)}
                        >
                          <span>{item.title}</span>
                          <ElSvgIcon name="ArrowRight" size={12} />
                        </button>
                        <div
                          className={styles.navSubitems}
                          style={{
                            display: expandedItems.includes(item.path) ? undefined : 'none',
                          }}
                        >
                          {item.children.map((child: any) => (
                            <button
                              key={child.path}
                              className={`${styles.navItem}${
                                currentPath === child.path ? ` ${styles.active}` : ''
                              }`}
                              type="button"
                              onClick={() => navigateTo(child)}
                            >
                              {child.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <button
                        key={item.path}
                        className={`${styles.navItem}${
                          currentPath === item.path ? ` ${styles.active}` : ''
                        }`}
                        type="button"
                        onClick={() => navigateTo(item)}
                      >
                        {item.title}
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className={styles.docMain}>
          {markdownContent ? (
            <article className={styles.docArticle}>
              <nav className={styles.articleBreadcrumb} aria-label="Breadcrumb">
                <span>{title}</span>
                <span className={styles.breadcrumbSeparator}>/</span>
                <span>{currentSectionTitle}</span>
                <span className={styles.breadcrumbSeparator}>/</span>
                <span className={styles.isCurrent}>{currentDoc?.title || title}</span>
              </nav>

              <div className={styles.articleHeader}>
                <div className={styles.articleHeading}>
                  <p className={styles.articleKicker}>{currentSectionTitle}</p>
                  <h2>{currentDoc?.title || title}</h2>
                </div>
                <div className={styles.articleActions}>
                  <button
                    className={`${styles.actionBtn} ${styles.primary}`}
                    type="button"
                    onClick={copyMarkdown}
                  >
                    {copyButtonLabel}
                  </button>
                  <button
                    className={styles.actionBtn}
                    type="button"
                    onClick={() => setMarkdownDrawerOpen(true)}
                  >
                    {t('docs.viewer.viewMarkdown')}
                  </button>
                </div>
              </div>

              {inlineToc.length >= 3 && (
                <section className={styles.articleOutline} aria-label="Page outline">
                  <div className={styles.outlineTitle}>{t('common.toc')}</div>
                  <nav className={styles.outlineNav}>
                    {inlineToc.map((item) => (
                      <a
                        key={item.id}
                        href={'#' + item.id}
                        className={`${styles.outlineLink} ${styles[`level${item.level}`] || ''}`}
                        onClick={(e) => {
                          e.preventDefault()
                          scrollToHeading(item.id)
                        }}
                      >
                        {item.text}
                      </a>
                    ))}
                  </nav>
                </section>
              )}

              <div className={styles.docContent}>
                <MarkdownRenderer
                  content={markdownContent}
                  theme={theme}
                  onTocReady={handleTocReady}
                />
              </div>
            </article>
          ) : (
            <div className={styles.docLoading}>
              <ElSvgIcon name="Loading" size={28} />
              <span>{t('common.loading')}</span>
            </div>
          )}

          {(prevDoc || nextDoc) && (
            <footer className={styles.docFooter}>
              <div className={styles.footerNav}>
                {prevDoc ? (
                  <Link
                    to={prevDoc.path}
                    className={styles.footerLink}
                    onClick={() => navigateTo(prevDoc)}
                  >
                    <span className={styles.footerLabel}>{t('docs.viewer.previous')}</span>
                    <span>{prevDoc.title}</span>
                  </Link>
                ) : (
                  <div className={styles.footerLinkPlaceholder}></div>
                )}

                {nextDoc && (
                  <Link
                    to={nextDoc.path}
                    className={`${styles.footerLink} ${styles.next}`}
                    onClick={() => navigateTo(nextDoc)}
                  >
                    <span className={styles.footerLabel}>{t('docs.viewer.next')}</span>
                    <span>{nextDoc.title}</span>
                  </Link>
                )}
              </div>
            </footer>
          )}
        </main>

        {toc.length > 0 && (
          <aside className={styles.docToc}>
            <div className={styles.tocCard}>
              <div className={styles.tocTitle}>{t('common.toc')}</div>
              <nav className={styles.tocNav}>
                {toc.map((item) => (
                  <a
                    key={item.id}
                    href={'#' + item.id}
                    className={`${styles.tocItem} ${styles[`level${item.level}`] || ''}${
                      activeHeading === item.id ? ` ${styles.active}` : ''
                    }`}
                    onClick={(e) => {
                      e.preventDefault()
                      scrollToHeading(item.id)
                    }}
                  >
                    {item.text}
                  </a>
                ))}
              </nav>
            </div>
          </aside>
        )}
      </div>

      <Drawer
        opened={markdownDrawerOpen}
        onClose={() => setMarkdownDrawerOpen(false)}
        position="right"
        size={drawerSize}
        className="markdown-drawer"
        title={
          <div className={styles.drawerHeader}>
            <div>
              <div className={styles.drawerTitle}>{t('docs.viewer.rawMarkdown')}</div>
              <div className={styles.drawerSubtitle}>{t('docs.viewer.rawMarkdownDesc')}</div>
            </div>
            <button className={styles.actionBtn} type="button" onClick={copyMarkdown}>
              {copyButtonLabel}
            </button>
          </div>
        }
      >
        <pre className={styles.rawMarkdown}>{markdownContent}</pre>
      </Drawer>
    </div>
  )
}

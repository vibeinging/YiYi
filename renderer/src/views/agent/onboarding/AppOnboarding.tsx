import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronRight,
  IconCircleCheckFilled,
  IconFileText,
  IconFolderCog,
  IconMessageCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRocket,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconX
} from '@tabler/icons-react'
import { llmModelsReq } from '@/api/models'
import OnboardingModelSetup from './OnboardingModelSetup'
import styles from './AppOnboarding.module.scss'

type OnboardingMode = 'dialog' | 'settings'
type StepId = 'overview' | 'models' | 'workspace'
type ModelKey = 'PRIMARY' | 'SECONDARY' | 'EMBEDDING'

interface AppOnboardingProps {
  mode?: OnboardingMode
  onClose?: (meta?: { primaryModelReady: boolean }) => void
  onFinish?: () => void
}

interface StepDef {
  id: StepId
  label: string
  title: string
  eyebrow: string
  summary: string
}

interface TutorialFrame {
  id: string
  label: string
  title: string
  desc: string
}

interface ModelStatus {
  loading: boolean
  error: string
  PRIMARY: boolean
  SECONDARY: boolean
  EMBEDDING: boolean
}

const STEPS: StepDef[] = [
  {
    id: 'overview',
    label: '欢迎',
    eyebrow: '',
    title: '欢迎使用 YiW',
    summary: '一个本地工作空间，用来对话、处理文件、调用工具和完成多步任务。'
  },
  {
    id: 'models',
    label: '模型设置',
    eyebrow: '可选设置',
    title: '连接你的 AI 模型',
    summary: '配置主模型后即可使用 AI 能力；也可以先跳过，稍后从设置页完成。'
  },
  {
    id: 'workspace',
    label: '开始工作',
    eyebrow: '快速开始',
    title: '选择一种开始方式',
    summary: '直接新建对话，或打开一个文件夹，把相关文件、会话和运行记录放在一起。'
  }
]

const MODEL_KEYS: ModelKey[] = ['PRIMARY', 'EMBEDDING', 'SECONDARY']

const INITIAL_MODEL_STATUS: ModelStatus = {
  loading: false,
  error: '',
  PRIMARY: false,
  SECONDARY: false,
  EMBEDDING: false
}

function readItems(res: any): any[] {
  const data = res?.data
  const items = data?.items || data || res?.items || []
  return Array.isArray(items) ? items : []
}

export default function AppOnboarding({
  mode = 'dialog',
  onClose,
  onFinish
}: AppOnboardingProps) {
  const [active, setActive] = useState(0)
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)
  const step = STEPS[active]
  const isDialog = mode === 'dialog'
  const isFirst = active === 0
  const isLast = active === STEPS.length - 1
  const primaryModelReady = modelStatus.PRIMARY

  const refreshModelStatus = useCallback(async () => {
    setModelStatus((prev) => ({ ...prev, loading: true, error: '' }))
    const results = await Promise.allSettled(
      MODEL_KEYS.map((category) => llmModelsReq({ category, per_page: 100 }))
    )
    const next: ModelStatus = { ...INITIAL_MODEL_STATUS }
    results.forEach((result, index) => {
      const key = MODEL_KEYS[index]
      if (result.status === 'fulfilled') next[key] = readItems(result.value).length > 0
      else next.error = '模型状态暂时无法读取'
    })
    setModelStatus({ ...next, loading: false })
  }, [])

  useEffect(() => {
    refreshModelStatus()
  }, [refreshModelStatus])

  const goNext = () => {
    if (isLast) onFinish?.()
    else setActive((value) => Math.min(STEPS.length - 1, value + 1))
  }

  const goPrev = () => setActive((value) => Math.max(0, value - 1))
  const close = () => onClose?.({ primaryModelReady })

  const content = (
    <section
      className={`${styles.panel} ${isDialog ? styles.dialogPanel : styles.settingsPanel} ${
        step.id === 'models' ? styles.panelModel : ''
      } ${step.id === 'overview' ? styles.panelWelcome : ''}`}
      aria-labelledby="app-onboarding-title"
    >
      <header className={styles.header}>
        <div>
          <div className={styles.kicker}>
            <IconRocket size={15} stroke={1.8} />
            YiW 初始引导
          </div>
          <h2 id="app-onboarding-title" className={styles.title}>{step.title}</h2>
          <p className={styles.headerSummary}>{step.summary}</p>
        </div>
        {isDialog && (
          <button type="button" className={styles.closeBtn} onClick={close} aria-label="关闭引导">
            <IconX size={18} stroke={1.8} />
          </button>
        )}
      </header>

      <div className={styles.body}>
        <main className={`${styles.stage} ${step.id === 'models' ? styles.stageModel : ''}`}>
          {step.eyebrow && (
            <div className={styles.stageTop}>
              <span className={styles.eyebrow}>{step.eyebrow}</span>
            </div>
          )}
          {step.id === 'overview' && <WelcomeIntro />}
          {step.id === 'models' && (
            <OnboardingModelSetup modelStatus={modelStatus} onModelsChanged={refreshModelStatus} />
          )}
          {step.id === 'workspace' && <WorkspaceTutorial />}
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerMeta}>
          <div className={styles.flowProgress} aria-label="引导进度">
            {STEPS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={styles.flowDot}
                data-active={index === active ? 'true' : undefined}
                onClick={() => setActive(index)}
                aria-label={`切换到${item.label}`}
                aria-current={index === active ? 'step' : undefined}
              />
            ))}
          </div>
          <span>{active + 1} / {STEPS.length} · {step.label}</span>
          {step.id === 'models' && (
            <span>{primaryModelReady ? '主模型已配置' : '未配置也可以继续'}</span>
          )}
        </div>
        <div className={styles.footerActions}>
          {isDialog && (
            <button type="button" className={styles.ghostBtn} onClick={close}>跳过</button>
          )}
          {!isFirst && (
            <button type="button" className={styles.secondaryBtn} onClick={goPrev}>
              <IconArrowLeft size={15} stroke={1.8} />
              上一步
            </button>
          )}
          <button type="button" className={styles.primaryBtn} onClick={goNext}>
            {isLast ? '开始使用' : '下一步'}
            {!isLast && <IconArrowRight size={15} stroke={1.8} />}
          </button>
        </div>
      </footer>
    </section>
  )

  if (!isDialog) return <div className={styles.settingsRoot}>{content}</div>

  return (
    <div className={styles.dialogRoot} role="dialog" aria-modal="true">
      <div className={styles.backdrop} />
      {content}
    </div>
  )
}

function WelcomeIntro() {
  return (
    <div className={styles.welcomeIntro}>
      <div className={styles.welcomeCopy}>
        <span className={styles.welcomeBadge}>
          <IconSparkles size={14} stroke={1.8} />
          本地 AI 工作空间
        </span>
        <strong>把对话、文件和工具放在一起</strong>
        <p>
          YiW 不限定工作类型。你可以整理文档、研究资料、处理 PDF、编写方案，或安排一个需要多步完成的任务。
        </p>
        <div className={styles.welcomePills} aria-label="核心入口">
          <div><IconMessageCircle size={17} stroke={1.8} /><span>开始对话</span></div>
          <div><IconFolderCog size={17} stroke={1.8} /><span>打开文件夹</span></div>
          <div><IconSparkles size={17} stroke={1.8} /><span>调用技能</span></div>
        </div>
      </div>
      <div className={styles.welcomeDemo} aria-label="YiW 工作空间预览">
        <div className={styles.welcomeDemoNav}>
          <span>工作空间</span>
          <b>产品资料</b>
          <small>需求文档 · 参考文件 · 任务记录</small>
        </div>
        <div className={styles.welcomeDemoChat}>
          <div className={styles.welcomeDemoUser}>整理这份需求，输出一份执行清单</div>
          <div className={styles.welcomeDemoAnswer}>
            <b>已读取需求说明.pdf</b>
            <span>正在梳理目标、限制条件和需要确认的问题。</span>
          </div>
          <div className={styles.welcomeDemoComposer}>描述任务，或拖入一个文件开始...</div>
        </div>
        <div className={styles.welcomeDemoLedger}>
          <span>工作台</span>
          <div data-active="true"><IconCircleCheckFilled size={14} /><b>读取文件</b></div>
          <div><IconCircleCheckFilled size={14} /><b>拆解任务</b></div>
          <div><IconCircleCheckFilled size={14} /><b>整理结果</b></div>
        </div>
      </div>
    </div>
  )
}

function TutorialPlayer({
  frames,
  children
}: {
  frames: TutorialFrame[]
  children: (frame: TutorialFrame) => ReactNode
}) {
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const frame = frames[frameIndex] || frames[0]
  const isEnded = frameIndex === frames.length - 1 && !playing

  useEffect(() => {
    if (!playing) return
    if (frameIndex >= frames.length - 1) {
      const stopTimer = window.setTimeout(() => setPlaying(false), 1100)
      return () => window.clearTimeout(stopTimer)
    }
    const timer = window.setTimeout(
      () => setFrameIndex((current) => Math.min(current + 1, frames.length - 1)),
      1250
    )
    return () => window.clearTimeout(timer)
  }, [frameIndex, frames.length, playing])

  const togglePlay = () => {
    if (playing) return setPlaying(false)
    if (frameIndex >= frames.length - 1) setFrameIndex(0)
    setPlaying(true)
  }

  return (
    <div className={styles.tutorialPlayer}>
      <div className={styles.tutorialPlayback}>
        {children(frame)}
        <button
          type="button"
          className={styles.playOverlay}
          onClick={togglePlay}
          aria-label={playing ? '暂停教程播放' : isEnded ? '重新播放教程' : '播放教程'}
          data-playing={playing ? 'true' : undefined}
        >
          <span className={styles.playOverlayIcon}>
            {playing ? <IconPlayerPause size={15} stroke={1.8} /> : <IconPlayerPlay size={15} stroke={1.8} />}
          </span>
          <span>{playing ? '暂停' : isEnded ? '重新播放' : '播放'}</span>
        </button>
        <div className={styles.tutorialCaption} aria-live="polite">
          <div>
            <span>{frame.label} / {frames.length}</span>
            <strong>{frame.title}</strong>
            <small>{frame.desc}</small>
          </div>
          <div className={styles.tutorialProgress} aria-label="教程播放进度">
            {frames.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={styles.tutorialProgressDot}
                data-active={index === frameIndex ? 'true' : undefined}
                onClick={() => {
                  setPlaying(false)
                  setFrameIndex(index)
                }}
                aria-label={`${item.label}：${item.title}`}
                aria-current={index === frameIndex ? 'step' : undefined}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function WorkspaceTutorial() {
  const frames: TutorialFrame[] = [
    { id: 'chat', label: '1', title: '直接开始对话', desc: '适合临时问题、快速草拟和不需要保存文件上下文的任务。' },
    { id: 'folder', label: '2', title: '打开一个文件夹', desc: '长期工作使用文件夹，让资料、会话和结果保持在同一个工作空间。' },
    { id: 'files', label: '3', title: '加入相关文件', desc: '拖入文档、PDF、图片或表格，YiW 会在当前任务中使用这些内容。' },
    { id: 'task', label: '4', title: '交给 YiW 一个真实任务', desc: '说明目标和期望结果，需要工具或多步处理时，YiW 会展示执行过程。' }
  ]

  return (
    <div className={styles.tutorialPanel} data-kind="workspace">
      <div className={styles.tutorialHeader}>
        <span>开始工作</span>
        <small>不需要先完成复杂设置，选择一种方式并开始第一个真实任务。</small>
      </div>
      <TutorialPlayer frames={frames}>
        {(frame) => <WorkspaceTutorialScene frame={frame} />}
      </TutorialPlayer>
    </div>
  )
}

function MockWorkspaceRail() {
  return (
    <aside className={styles.mockRail}>
      <div className={styles.mockAction}><IconPlus size={14} stroke={1.9} /><span>新建对话</span><kbd>⌘N</kbd></div>
      <div className={styles.mockAction}><IconSearch size={14} stroke={1.7} /><span>搜索</span><kbd>⌘K</kbd></div>
      <div className={styles.mockAction}><IconSparkles size={14} stroke={1.7} /><span>技能</span></div>
      <div className={styles.mockSec}>工作空间</div>
      <div className={styles.mockWsActive}>
        <IconChevronRight size={12} className={styles.mockCaretOpen} />
        <IconFolderCog size={14} stroke={1.7} className={styles.mockAccentIcon} />
        <span>产品资料</span><em>3</em><IconSettings size={13} stroke={1.8} className={styles.mockGear} />
      </div>
      <div className={styles.mockConvNest}><span>需求执行清单</span><span>发布说明整理</span></div>
      <div className={styles.mockWsRow}><IconChevronRight size={12} /><span>合同审阅</span></div>
      <div className={styles.mockRailFoot}><b>YiW</b><span><IconSettings size={13} stroke={1.7} />设置</span></div>
    </aside>
  )
}

function WorkspaceTutorialScene({ frame }: { frame: TutorialFrame }) {
  return (
    <div
      className={`${styles.productMock} ${styles.mockAppFrame}`}
      data-scene="workspace"
      data-frame={frame.id}
      data-layout="conversation"
      aria-label="工作空间界面演示"
    >
      <MockWorkspaceRail />
      <section className={styles.mockConversationScreen}>
        <div className={styles.mockConversationTop}>
          <div>
            <strong>{frame.id === 'chat' ? '新对话' : '产品资料'}</strong>
            <span>{frame.id === 'chat' ? '随时开始，稍后也能归入工作空间' : '文件、会话和结果会保留在这里'}</span>
          </div>
        </div>
        <div className={styles.mockThreadBody}>
          {frame.id === 'task' ? (
            <>
              <div className={styles.mockUserBubble}>整理需求文档，输出执行清单和风险项</div>
              <div className={styles.mockAssistantBlock}>
                <b>已拆成 4 个执行阶段</b>
                <span>正在整理依赖、负责人建议和需要提前确认的风险。</span>
              </div>
            </>
          ) : frame.id === 'files' ? (
            <div className={styles.mockSourceList}>
              <div className={styles.mockSourceRow} data-status="online">
                <IconFileText size={16} stroke={1.7} /><span><b>需求说明.pdf</b><small>24 页 · 已加入当前任务</small></span><em>可用</em>
              </div>
              <div className={styles.mockSourceRow} data-status="indexed">
                <IconFileText size={16} stroke={1.7} /><span><b>发布计划.xlsx</b><small>3 个工作表 · 已读取</small></span><em>可用</em>
              </div>
            </div>
          ) : frame.id === 'folder' ? (
            <div className={styles.mockContextGrid}>
              <div><span>文件</span><b>8 个</b><small>文档、PDF、表格和图片</small></div>
              <div><span>最近会话</span><b>需求执行清单</b><small>昨天 16:40 更新</small></div>
              <div><span>技能</span><b>3 个</b><small>文档、PDF、研究</small></div>
              <div><span>运行记录</span><b>已保留</b><small>过程和结果可以继续查看</small></div>
            </div>
          ) : (
            <div className={styles.mockWelcomeBlock}>
              <IconMessageCircle size={24} stroke={1.7} />
              <strong>从一个真实任务开始</strong>
              <span>输入目标，或把相关文件直接拖进对话。</span>
            </div>
          )}
        </div>
        <div className={styles.mockComposer}>
          <IconMessageCircle size={15} stroke={1.7} />
          <span>{frame.id === 'task' ? '整理需求文档，输出执行清单和风险项' : '描述任务，或拖入一个文件'}</span>
          <small>{frame.id === 'chat' ? '新对话' : '产品资料'}</small>
        </div>
      </section>
      <aside className={styles.mockWorkstation}>
        <div className={styles.mockWorkstationHeader}>工作台</div>
        <div className={styles.mockWorkstationItem} data-active={frame.id === 'files'}><b>相关文件</b><span>需求说明.pdf · 发布计划.xlsx</span></div>
        <div className={styles.mockWorkstationItem} data-active={frame.id === 'task'}><b>任务进度</b><span>{frame.id === 'task' ? '正在整理执行清单' : '等待任务开始'}</span></div>
        <div className={styles.mockWorkstationItem} data-active={frame.id === 'folder'}><b>工作空间</b><span>产品资料 · 内容会持续保留</span></div>
      </aside>
    </div>
  )
}

// yiw-agent 设置页:整窗接管(自带左栏 + 主面板),与对话壳同主题(--yiw-* token)。
// 「常规」完整可用:主题/缩放即时生效;运行、显示、通知、归档和网络设置按各自链路生效。
// 其余分组嵌入对应管理页。返回工作区 → onBack 回到对话壳。
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconBell,
  IconBook2,
  IconBox,
  IconBrain,
  IconChevronDown,
  IconDeviceLaptop,
  IconFolder,
  IconFolderOpen,
  IconListCheck,
  IconMoon,
  IconRocket,
  IconRoute,
  IconServer,
  IconShieldCheck,
  IconSparkles,
  IconSun,
  IconVolume,
  type TablerIcon
} from '@tabler/icons-react'
import ModelsPage from '@/views/models/index'
import McpProviderListView from '@/views/project/settings/components/McpProviderListView'
import SkillsPage from '@/views/skills/index'
import { useConfigStore } from '@/store/config'
import { useYiWTheme, type YiWThemeMode } from './themeContext'
import { SettingsShell, SettingsNavGroup, SettingsNavItem, SettingsNavSep } from './SettingsShell'
import AppOnboarding from './onboarding/AppOnboarding'
import { markAppOnboardingCompleted } from './onboarding/storage'
import { pickFolder } from './folders'
import styles from './yiwSettings.module.scss'

/* ── 设置持久化:主题走 themeContext;缩放即时应用;网络设置额外同步到 Electron userData 供主进程启动后端时读取。── */
const STORAGE_KEY = 'yiw-settings'

type YiWLanguage = 'zh' | 'en'

interface YiWSettingsData {
  language: YiWLanguage
  zoom: 'small' | 'normal' | 'large'
  inheritProfile: boolean
  terminalFont: string
  httpProxy: string
  noProxy: string
  customCert: string
  netTimeout: '30' | '60' | '120' | '300' | '600'
  autoCompact: boolean
  taskNotify: boolean
  notifySound: boolean
  interaction: 'queue' | 'interrupt'
  showThinking: boolean
  showTodo: boolean
  autoArchiveTasks: boolean
  archiveRetention: '7' | '14' | '30' | '90'
  dataRoot: string
  optimizeExperience: boolean
}

type NetworkSettings = Pick<YiWSettingsData, 'httpProxy' | 'noProxy' | 'customCert'>
type NetworkSettingKey = keyof NetworkSettings

const DEFAULTS: YiWSettingsData = {
  language: 'zh',
  zoom: 'normal',
  inheritProfile: true,
  terminalFont: '',
  httpProxy: '',
  noProxy: '',
  customCert: '',
  netTimeout: '60',
  autoCompact: true,
  taskNotify: true,
  notifySound: true,
  interaction: 'queue',
  showThinking: true,
  showTodo: true,
  autoArchiveTasks: false,
  archiveRetention: '7',
  dataRoot: '',
  optimizeExperience: false
}

// 供对话层读取的「代理运行设置」:超时(ms)+ 是否自动压缩上下文。
export function loadAgentRuntimeSettings(): { timeoutMs: number; autoCompact: boolean } {
  const s = loadYiWSettings()
  return { timeoutMs: (parseInt(s.netTimeout, 10) || 60) * 1000, autoCompact: s.autoCompact !== false }
}

export function loadAgentDisplaySettings(): {
  showThinking: boolean
  showTodo: boolean
  interaction: YiWSettingsData['interaction']
} {
  const s = loadYiWSettings()
  return {
    showThinking: s.showThinking !== false,
    showTodo: s.showTodo !== false,
    interaction: s.interaction === 'interrupt' ? 'interrupt' : 'queue'
  }
}

const ZOOM_FACTOR: Record<YiWSettingsData['zoom'], number> = {
  small: 0.9,
  normal: 1,
  large: 1.1
}

export function loadYiWSettings(): YiWSettingsData {
  try {
    return normalizeYiWSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return { ...DEFAULTS }
  }
}

function normalizeLanguage(value: unknown): YiWLanguage {
  return value === 'en' ? 'en' : 'zh'
}

function normalizeYiWSettings(raw: unknown): YiWSettingsData {
  const value = raw && typeof raw === 'object' ? (raw as Partial<YiWSettingsData> & Record<string, unknown>) : {}
  const merged = { ...DEFAULTS, ...value }
  return {
    ...merged,
    language: normalizeLanguage(value.language),
    zoom: ['small', 'normal', 'large'].includes(String(merged.zoom)) ? merged.zoom : DEFAULTS.zoom,
    interaction: merged.interaction === 'interrupt' ? 'interrupt' : 'queue',
    archiveRetention: ['7', '14', '30', '90'].includes(String(merged.archiveRetention))
      ? merged.archiveRetention
      : DEFAULTS.archiveRetention,
    netTimeout: ['30', '60', '120', '300', '600'].includes(String(merged.netTimeout))
      ? merged.netTimeout
      : DEFAULTS.netTimeout
  }
}

function pickNetworkSettings(settings: YiWSettingsData): NetworkSettings {
  return {
    httpProxy: settings.httpProxy || '',
    noProxy: settings.noProxy || '',
    customCert: settings.customCert || ''
  }
}

function saveDesktopNetworkSettings(settings: YiWSettingsData) {
  const api = (window as any).electronAPI
  if (!api?.saveNetworkSettings) return
  api.saveNetworkSettings(pickNetworkSettings(settings)).catch((err: any) => {
    console.warn('[YiWSettings] 保存网络设置到主进程失败:', err?.message || err)
  })
}

export function applyYiWZoom(zoom: YiWSettingsData['zoom']) {
  // 缩放只作用于 .yiw-zoom(内容)。外层 .yiw-root 的 padding / 标题栏条不被缩放,保持固定。
  const el = document.querySelector('.yiw-zoom') as HTMLElement | null
  if (!el) return
  const f = ZOOM_FACTOR[zoom] ?? 1
  // 不使用 CSS zoom:它会和 Electron/Chromium page zoom 混在一起,导致右侧/底部露出背景。
  el.style.removeProperty('zoom')
  el.style.setProperty('--yiw-zoom', String(f))
}

export const ZOOM_ORDER: YiWSettingsData['zoom'][] = ['small', 'normal', 'large']

// 全局快捷键用:在三档间步进(+1 放大 / -1 缩小 / 0 复位 normal),落盘 + 即时应用,返回新档。
// 直接读写 localStorage,与设置面板共用同一持久化(面板下次打开即读到)。
export function stepYiWZoom(dir: -1 | 0 | 1): YiWSettingsData['zoom'] {
  const cur = loadYiWSettings()
  const next: YiWSettingsData['zoom'] =
    dir === 0
      ? 'normal'
      : ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, ZOOM_ORDER.indexOf(cur.zoom) + dir))]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, zoom: next }))
  } catch {
    /* ignore */
  }
  applyYiWZoom(next)
  return next
}

/* ── 左栏导航分组 ── */
interface NavDef {
  key: string
  label: string
  Icon: TablerIcon
  desc?: string
}
const GENERAL_NAV: NavDef[] = [
  { key: 'general', label: '常规', Icon: IconAdjustmentsHorizontal, desc: '聚合入口，集中调整常用设置。' }
]
const GENERAL_GROUP_NAV: NavDef[] = [
  { key: 'display', label: '外观与终端', Icon: IconDeviceLaptop, desc: '主题、语言、缩放和本机终端偏好。' },
  { key: 'runtime-network', label: '运行与网络', Icon: IconRoute, desc: '代理、证书、超时和上下文策略。' },
  { key: 'interaction-notify', label: '通知与交互', Icon: IconBell, desc: '桌面通知、提示音、输入处理和过程可见性。' },
  { key: 'tasks-data', label: '任务与数据', Icon: IconArchive, desc: '旧任务归档和本机数据路径偏好。' },
  { key: 'guide-privacy', label: '引导与隐私', Icon: IconShieldCheck, desc: '新手引导和体验优化偏好。' }
]
const MANAGE_NAV: NavDef[] = [
  { key: 'models', label: '模型设置', Icon: IconBox },
  { key: 'skills', label: '技能', Icon: IconSparkles },
  { key: 'mcp', label: 'MCP 服务器', Icon: IconServer }
]
const NAV: NavDef[] = [...GENERAL_NAV, ...GENERAL_GROUP_NAV, ...MANAGE_NAV]

const THEME_LABEL: Record<YiWThemeMode, string> = {
  light: '浅色',
  dark: '暗色',
  system: '跟随系统'
}

export default function YiWSettings({
  onBack,
  initialActive = 'general'
}: { onBack?: () => void; initialActive?: string }) {
  const { mode, scheme, setMode } = useYiWTheme()
  const appLanguage = useConfigStore((s) => s.language)
  const setAppLanguage = useConfigStore((s) => s.setLanguage)

  const [active, setActive] = useState(initialActive)
  const [groupsCollapsed, setGroupsCollapsed] = useState(false)
  const [data, setData] = useState<YiWSettingsData>(loadYiWSettings)
  const [defaultDataRoot, setDefaultDataRoot] = useState('')
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  useEffect(() => {
    setActive(initialActive)
  }, [initialActive])

  useEffect(() => {
    setData((prev) => (prev.language === appLanguage ? prev : { ...prev, language: appLanguage }))
  }, [appLanguage])

  useEffect(() => {
    let cancelled = false
    const api = (window as any).electronAPI
    if (api?.loadNetworkSettings) {
      api.loadNetworkSettings()
        .then((settings: Partial<NetworkSettings> | null) => {
          if (cancelled || !settings) return
          setData((prev) => ({
            ...prev,
            httpProxy: String(settings.httpProxy || ''),
            noProxy: String(settings.noProxy || ''),
            customCert: String(settings.customCert || '')
          }))
        })
        .catch((err: any) => console.warn('[YiWSettings] 读取主进程网络设置失败:', err?.message || err))
    }
    if (api?.defaultDataRoot) {
      api.defaultDataRoot()
        .then((root: unknown) => {
          if (!cancelled && typeof root === 'string') setDefaultDataRoot(root)
        })
        .catch((err: any) => console.warn('[YiWSettings] 读取默认数据路径失败:', err?.message || err))
    }
    return () => {
      cancelled = true
    }
  }, [])

  // 持久化 + 即时应用缩放
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])
  useEffect(() => {
    applyYiWZoom(data.zoom)
  }, [data.zoom])

  const set = <K extends keyof YiWSettingsData>(key: K, value: YiWSettingsData[K]) =>
    setData((d) => ({ ...d, [key]: value }))
  const setLanguage = (value: YiWLanguage) => {
    setAppLanguage(value)
    set('language', value)
  }
  const setNetwork = <K extends NetworkSettingKey>(key: K, value: NetworkSettings[K]) => {
    const next = { ...data, [key]: value }
    setData(next)
    saveDesktopNetworkSettings(next)
  }

  const activeDef = useMemo(() => NAV.find((n) => n.key === active), [active])
  const activeGeneralGroup = useMemo(() => GENERAL_GROUP_NAV.find((n) => n.key === active), [active])
  const isGeneralOverview = active === 'general'
  const isGeneralPage = isGeneralOverview || !!activeGeneralGroup

  const closeOnboarding = () => setOnboardingOpen(false)
  const finishOnboarding = () => {
    markAppOnboardingCompleted()
    setOnboardingOpen(false)
  }
  const chooseDataRoot = async () => pickFolder()

  return (
    <SettingsShell
      onBack={onBack}
      nav={
        <>
          {GENERAL_NAV.map(({ key, label, Icon }) => (
            <SettingsNavItem
              key={key}
              active={active === key}
              onClick={() => setActive(key)}
              icon={<Icon size={17} stroke={1.7} />}
            >
              {label}
            </SettingsNavItem>
          ))}

          <SettingsNavGroup
            label="常规分组"
            collapsed={groupsCollapsed}
            onToggle={() => setGroupsCollapsed((v) => !v)}
          >
            {GENERAL_GROUP_NAV.map(({ key, label, Icon }) => (
              <SettingsNavItem
                key={key}
                active={active === key}
                onClick={() => setActive(key)}
                icon={<Icon size={17} stroke={1.7} />}
              >
                {label}
              </SettingsNavItem>
            ))}
          </SettingsNavGroup>

          <SettingsNavSep />

          {MANAGE_NAV.map(({ key, label, Icon }) => (
            <SettingsNavItem
              key={key}
              active={active === key}
              onClick={() => setActive(key)}
              icon={<Icon size={17} stroke={1.7} />}
            >
              {label}
            </SettingsNavItem>
          ))}

          <SettingsNavSep />

          <button
            type="button"
            className={`${styles.bootBtn} ${onboardingOpen ? styles.bootBtnActive : ''}`}
            onClick={() => setOnboardingOpen(true)}
          >
            <IconRocket size={17} stroke={1.7} />
            <span>引导</span>
          </button>
        </>
      }
    >
      <div className={`${styles.mainInner} ${active === 'skills' || active === 'mcp' ? styles.mainInnerFixed : ''}`}>
          {isGeneralPage ? (
            <>
              <h1 className={styles.pageTitle}>{isGeneralOverview ? '常规' : activeGeneralGroup?.label}</h1>
              {isGeneralOverview ? (
                <div className={styles.badges}>
                  <span className={styles.badge}>{scheme === 'dark' ? '深色' : '浅色'}</span>
                  <span className={styles.badge}>{data.language === 'zh' ? '简体中文' : 'English'}</span>
                </div>
              ) : (
                <p className={styles.pageLead}>{activeGeneralGroup?.desc}</p>
              )}

              {(isGeneralOverview || active === 'display') && (
              <SettingsSection title="外观" desc="控制界面外观、显示语言和窗口内容比例。">
                <Row label="界面主题" desc="切换应用界面使用的主题外观。">
                  <Select<YiWThemeMode>
                    value={mode}
                    onChange={setMode}
                    icon={
                      mode === 'light' ? (
                        <IconSun size={15} stroke={1.7} />
                      ) : mode === 'dark' ? (
                        <IconMoon size={15} stroke={1.7} />
                      ) : (
                        <IconDeviceLaptop size={15} stroke={1.7} />
                      )
                    }
                    options={[
                      { value: 'light', label: THEME_LABEL.light },
                      { value: 'dark', label: THEME_LABEL.dark },
                      { value: 'system', label: THEME_LABEL.system }
                    ]}
                  />
                </Row>
                <Row label="界面语言" desc="选择应用 UI 的显示语言。">
                  <Select
                    value={data.language}
                    onChange={setLanguage}
                    options={[
                      { value: 'zh', label: '简体中文' },
                      { value: 'en', label: 'English' }
                    ]}
                  />
                </Row>
                <Row label="界面缩放" desc="调整当前窗口中文本和控件的整体显示大小。">
                  <Segmented
                    value={data.zoom}
                    onChange={(v) => set('zoom', v)}
                    options={[
                      { value: 'small', label: '偏小' },
                      { value: 'normal', label: '正常' },
                      { value: 'large', label: '偏大' }
                    ]}
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'display') && (
              <SettingsSection title="终端" desc="保存本机终端偏好，后续内置终端接入后直接消费。">
                <Row
                  label="继承系统终端 Profile"
                  desc="保存为本机偏好；内置终端接入后会用于继承登录 shell 环境、代理和 Kube 变量。"
                >
                  <Toggle value={data.inheritProfile} onChange={(v) => set('inheritProfile', v)} />
                </Row>
                <TextRow
                  label="终端字体"
                  desc="保存为本机偏好；内置终端接入后会作为字体覆盖。留空表示使用默认等宽字体。"
                  placeholder="留空自动继承,例如 MesloLGS NF, monospace"
                  value={data.terminalFont}
                  onSave={(v) => set('terminalFont', v)}
                />
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'runtime-network') && (
              <SettingsSection title="网络" desc="配置模型、检索、MCP 和命令工具的网络出口。">
                <TextRow
                  label="HTTP 代理"
                  desc="模型、Embedding、Web 搜索、MCP 与命令工具的出口流量将经此代理;留空时直连。保存后渲染层立即生效,后端请求需重启应用。"
                  placeholder="留空直连,例如 http://127.0.0.1:7890"
                  value={data.httpProxy}
                  onSave={(v) => setNetwork('httpProxy', v)}
                />
                <TextRow
                  label="不走代理"
                  desc="匹配这些主机的请求将直连,不经过 HTTP 代理。localhost、127.0.0.1 和 ::1 会自动加入。保存后后端请求需重启应用。"
                  placeholder="例如 localhost,127.0.0.1,::1,.example.com,*.corp.com"
                  value={data.noProxy}
                  onSave={(v) => setNetwork('noProxy', v)}
                />
                <TextRow
                  label="自定义证书"
                  desc="可选。填写 PEM 根证书路径后,会作为 NODE_EXTRA_CA_CERTS 注入后端、MCP 与命令工具。修改后需重启应用。"
                  placeholder="例如 /Users/name/certs/root-ca.pem"
                  value={data.customCert}
                  onSave={(v) => setNetwork('customCert', v)}
                />
                <Row label="网络超时" desc="模型请求的最长等待时间;超时即中断本次请求并报错(下次对话生效)。">
                  <Select
                    value={data.netTimeout}
                    onChange={(v) => set('netTimeout', v)}
                    options={[
                      { value: '30', label: '30 秒' },
                      { value: '60', label: '60 秒' },
                      { value: '120', label: '2 分钟' },
                      { value: '300', label: '5 分钟' },
                      { value: '600', label: '10 分钟' }
                    ]}
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'runtime-network') && (
              <SettingsSection title="运行" desc="控制长对话时的上下文处理策略。">
                <Row
                  label="自动压缩上下文"
                  desc="对话变长、接近模型上下文上限时,自动把较早内容摘要压缩以控制长度(界面显示不变)。也可在输入框用 /compact 手动压缩。"
                >
                  <Toggle value={data.autoCompact} onChange={(v) => set('autoCompact', v)} />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'interaction-notify') && (
              <SettingsSection title="通知" desc="任务完成、失败或需要确认时，给出清晰但不打扰的提醒。">
                <Row icon={<IconBell size={17} stroke={1.75} />} label="任务通知" desc="任务完成、失败或需要确认时发送桌面通知。">
                  <Toggle value={data.taskNotify} onChange={(v) => set('taskNotify', v)} ariaLabel="任务通知" />
                </Row>
                <Row
                  icon={<IconVolume size={17} stroke={1.75} />}
                  label="通知声音"
                  desc="通知开启后，可以单独关闭任务通知提示音。"
                  disabled={!data.taskNotify}
                >
                  <Toggle
                    value={data.notifySound}
                    onChange={(v) => set('notifySound', v)}
                    disabled={!data.taskNotify}
                    ariaLabel="通知声音"
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'interaction-notify') && (
              <SettingsSection title="交互与可见性" desc="控制任务运行时的输入处理方式，以及过程信息的展示密度。">
                <Row icon={<IconRoute size={17} stroke={1.75} />} label="交互行为" desc="任务运行中继续输入时，选择加入队列，或中断当前任务后立即执行。">
                  <Select
                    value={data.interaction}
                    onChange={(v) => set('interaction', v)}
                    options={[
                      { value: 'queue', label: '队列' },
                      { value: 'interrupt', label: '打断' }
                    ]}
                  />
                </Row>
                <Row icon={<IconBrain size={17} stroke={1.75} />} label="显示思考过程" desc="在消息流中展示模型思考内容；关闭后仅保留结果、工具调用和确认信息。">
                  <Toggle value={data.showThinking} onChange={(v) => set('showThinking', v)} ariaLabel="显示思考过程" />
                </Row>
                <Row icon={<IconListCheck size={17} stroke={1.75} />} label="显示待办" desc="在消息流中展示待办 / 计划浮窗，便于跟踪长任务进度。">
                  <Toggle value={data.showTodo} onChange={(v) => set('showTodo', v)} ariaLabel="显示待办" />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'tasks-data') && (
              <SettingsSection title="任务整理" desc="把旧任务收起到更安静的位置，保持工作区列表可扫描。">
                <Row icon={<IconArchive size={17} stroke={1.75} />} label="自动归档旧任务" desc="应用启动后每天最多扫描一次最近打开过的工作区，将超过保留期、未置顶且当前未运行的对话移入归档区。">
                  <Toggle value={data.autoArchiveTasks} onChange={(v) => set('autoArchiveTasks', v)} ariaLabel="自动归档旧任务" />
                </Row>
                <Row
                  icon={<IconArchive size={17} stroke={1.75} />}
                  label="归档保留时长"
                  desc="对话最后更新时间早于该时长后，才会被自动归档。"
                  disabled={!data.autoArchiveTasks}
                >
                  <Select
                    value={data.archiveRetention}
                    onChange={(v) => set('archiveRetention', v)}
                    disabled={!data.autoArchiveTasks}
                    options={[
                      { value: '7', label: '7 天后归档' },
                      { value: '14', label: '14 天后归档' },
                      { value: '30', label: '30 天后归档' },
                      { value: '90', label: '90 天后归档' }
                    ]}
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'tasks-data') && (
              <SettingsSection title="本机数据" desc="本地优先保存数据和运行痕迹，路径设置先作为本机偏好保留。">
                <PathRow
                  label="数据存储路径"
                  desc="应用数据的默认根目录；包含本地数据库、项目工作区、上传文件和运行记录。当前仅展示并保存偏好，迁移执行另接任务。"
                  value={data.dataRoot || defaultDataRoot}
                  placeholder="读取默认路径中..."
                  onSave={(v) => set('dataRoot', v)}
                  onChoose={chooseDataRoot}
                />
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'guide-privacy') && (
              <SettingsSection title="引导与隐私" desc="重新查看初始化流程，或者调整体验优化偏好。">
                <ActionRow
                  icon={<IconBook2 size={17} stroke={1.75} />}
                  label="新手引导"
                  desc="重新打开 YiW 初始引导，查看模型设置、工作空间和常用开始方式。"
                >
                  <button type="button" className={styles.actionBtn} onClick={() => setOnboardingOpen(true)}>
                    打开引导
                  </button>
                </ActionRow>
                <Row icon={<IconShieldCheck size={17} stroke={1.75} />} label="优化体验" desc="当前仅保存本机偏好；后续接入诊断或体验优化链路时，会按这个开关执行。">
                  <Toggle
                    value={data.optimizeExperience}
                    onChange={(v) => set('optimizeExperience', v)}
                    ariaLabel="优化体验"
                  />
                </Row>
              </SettingsSection>
              )}
            </>
          ) : active === 'models' ? (
            <>
              <h1 className={styles.pageTitle}>模型设置</h1>
              <div className={styles.embed}>
                <EmbedBoundary>
                  <ModelsPage readonly={false} showHeader={false} />
                </EmbedBoundary>
              </div>
            </>
          ) : active === 'skills' ? (
            <div className={`${styles.embed} ${styles.embedFixed}`}>
              <EmbedBoundary>
                <SkillsPage scope="app" />
              </EmbedBoundary>
            </div>
          ) : active === 'mcp' ? (
            <div className={`${styles.embed} ${styles.embedFixed}`}>
              <EmbedBoundary>
                <McpProviderListView scope="app" />
              </EmbedBoundary>
            </div>
          ) : (
            <Placeholder title={activeDef?.label || ''} Icon={activeDef?.Icon || IconRocket} />
          )}
      </div>
      {onboardingOpen && (
        <AppOnboarding
          mode="dialog"
          onClose={closeOnboarding}
          onFinish={finishOnboarding}
        />
      )}
    </SettingsShell>
  )
}

function SettingsSection({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>{title}</h2>
          <p className={styles.sectionDesc}>{desc}</p>
        </div>
      </div>
      <div className={styles.group}>{children}</div>
    </section>
  )
}

/* ── 行:左标签+描述,右控件 ── */
function Row({
  label,
  desc,
  children,
  icon,
  disabled = false
}: {
  label: string
  desc: string
  children: ReactNode
  icon?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className={`${styles.row} ${disabled ? styles.rowDisabled : ''}`}>
      {icon && <div className={styles.rowIcon}>{icon}</div>}
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDesc}>{desc}</div>
      </div>
      <div className={styles.rowCtrl}>{children}</div>
    </div>
  )
}

function ActionRow({
  label,
  desc,
  children,
  icon
}: {
  label: string
  desc: string
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className={styles.row}>
      {icon && <div className={styles.rowIcon}>{icon}</div>}
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDesc}>{desc}</div>
      </div>
      <div className={styles.rowCtrl}>{children}</div>
    </div>
  )
}

/* ── 文本输入行(带「保存」)── */
function TextRow({
  label,
  desc,
  placeholder,
  value,
  onSave
}: {
  label: string
  desc: string
  placeholder?: string
  value: string
  onSave: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const dirty = draft !== value

  useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <div className={`${styles.row} ${styles.rowStacked}`}>
      <div className={styles.rowText}>
        <div className={styles.rowHeadLine}>
          <div className={styles.rowLabel}>{label}</div>
          <button
            type="button"
            className={styles.saveBtn}
            disabled={!dirty}
            onClick={() => onSave(draft.trim())}
          >
            保存
          </button>
        </div>
        <div className={styles.rowDesc}>{desc}</div>
        <input
          className={styles.textInput}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) onSave(draft.trim())
          }}
        />
      </div>
    </div>
  )
}

function PathRow({
  label,
  desc,
  placeholder,
  value,
  onSave,
  onChoose
}: {
  label: string
  desc: string
  placeholder?: string
  value: string
  onSave: (v: string) => void
  onChoose: () => Promise<string | null>
}) {
  const [draft, setDraft] = useState(value)
  const dirty = draft.trim() !== value

  useEffect(() => {
    setDraft(value)
  }, [value])

  const save = () => onSave(draft.trim())
  const choose = async () => {
    const picked = await onChoose()
    if (!picked) return
    setDraft(picked)
    onSave(picked)
  }

  return (
    <div className={`${styles.row} ${styles.pathRow}`}>
      <div className={styles.rowIcon}>
        <IconFolder size={17} stroke={1.75} />
      </div>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDesc}>{desc}</div>
        <div className={styles.pathEdit}>
          <input
            className={styles.pathInput}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirty) save()
            }}
          />
          <button type="button" className={styles.iconBtn} onClick={choose} aria-label="选择文件夹">
            <IconFolderOpen size={16} stroke={1.8} />
          </button>
          <button type="button" className={styles.saveBtn} disabled={!dirty} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── 下拉 ── */
function Select<T extends string>({
  value,
  onChange,
  options,
  icon,
  disabled = false
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  icon?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className={`${styles.select} ${disabled ? styles.controlDisabled : ''}`}>
      {icon && <span className={styles.selectIcon}>{icon}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={15} stroke={1.8} className={styles.selectChevron} />
    </div>
  )
}

/* ── 分段选择 ── */
function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className={styles.seg} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`${styles.segBtn} ${value === o.value ? styles.segBtnActive : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── 开关 ── */
function Toggle({
  value,
  onChange,
  disabled = false,
  ariaLabel
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${styles.toggle} ${value ? styles.toggleOn : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

/* ── 错误边界:内嵌问数页崩溃时兜底,不连累设置壳 ── */
class EmbedBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: unknown) {
    console.error('[YiWSettings] 内嵌页渲染失败:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className={styles.placeholder}>
          <div className={styles.placeholderText}>该模块加载失败</div>
          <div className={styles.placeholderSub}>{this.state.error.message}</div>
        </div>
      )
    }
    return this.props.children
  }
}

/* ── 占位骨架(待功能接入)── */
function Placeholder({ title, Icon }: { title: string; Icon: TablerIcon }) {
  return (
    <>
      <h1 className={styles.pageTitle}>{title}</h1>
      <div className={styles.placeholder}>
        <Icon size={40} stroke={1.3} />
        <div className={styles.placeholderText}>「{title}」模块即将上线</div>
        <div className={styles.placeholderSub}>该分组的设置项正在接入中。</div>
      </div>
    </>
  )
}

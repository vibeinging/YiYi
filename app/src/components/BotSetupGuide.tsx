/**
 * BotSetupGuide — AI-assisted step-by-step bot onboarding wizard
 *
 * Replaces the bare "fill in credentials" form with a guided flow that
 * walks users through creating a bot on the target platform.
 *
 * Currently supports: Feishu, DingTalk
 * Other platforms fall through to the classic form.
 */

import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  Circle,
  ExternalLink,
  Loader2,
  AlertCircle,
  ChevronRight,
  Copy,
  Check,
  Sparkles,
  Shield,
  Zap,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';

/* ── Types ─────────────────────────────────────────────────── */

interface GuideStep {
  id: string;
  title: string;
  description: string;
  /** Detailed instructions shown when step is active */
  instructions: string[];
  /** External URL to open (optional) */
  externalUrl?: string;
  externalLabel?: string;
  /** Config fields to fill in this step (optional) */
  fields?: { key: string; label: string; placeholder: string; secret?: boolean }[];
  /** Permissions or settings to check (informational) */
  checklist?: string[];
}

interface BotSetupGuideProps {
  platform: 'feishu' | 'dingtalk' | 'wecom';
  config: Record<string, string>;
  onConfigChange: (config: Record<string, string>) => void;
  /** Called when the guide is complete and user wants to save */
  onComplete: () => void;
  /** Language from i18n */
  lang?: string;
}

/* ── Feishu Guide Steps ────────────────────────────────────── */

const FEISHU_STEPS_ZH: GuideStep[] = [
  {
    id: 'create-app',
    title: '创建飞书应用',
    description: '在飞书开放平台创建一个企业自建应用',
    instructions: [
      '打开飞书开放平台，点击「创建企业自建应用」',
      '填写应用名称（如 "YiYi AI 助手"）和描述',
      '创建完成后，你会进入应用的管理页面',
    ],
    externalUrl: 'https://open.feishu.cn/app',
    externalLabel: '打开飞书开放平台',
  },
  {
    id: 'enable-bot',
    title: '启用机器人能力',
    description: '让应用具备接收和发送消息的能力',
    instructions: [
      '在应用管理页面，点击左侧菜单「添加应用能力」',
      '找到「机器人」能力，点击添加',
      '添加后机器人能力会出现在左侧菜单中',
    ],
  },
  {
    id: 'permissions',
    title: '配置权限',
    description: '授予机器人接收和发送消息的权限',
    instructions: [
      '在左侧菜单点击「权限管理」',
      '搜索并开通以下权限（勾选后点击「批量开通」）',
    ],
    checklist: [
      'im:message — 获取与发送单聊、群组消息',
      'im:message:send_as_bot — 以应用的身份发送消息',
      'im:chat:readonly — 获取群组信息',
      'contact:user.id:readonly — 获取用户 ID（用于私聊）',
    ],
  },
  {
    id: 'event-config',
    title: '配置事件订阅',
    description: '选择 WebSocket 模式（无需公网 IP）',
    instructions: [
      '在左侧菜单点击「事件订阅」',
      '请求方式选择「使用长连接接收事件」(WebSocket 模式)',
      '添加事件：搜索 「接收消息」 并勾选 im.message.receive_v1',
      '这样 YiYi 就能通过 WebSocket 实时接收消息，无需公网服务器',
    ],
  },
  {
    id: 'credentials',
    title: '获取凭证',
    description: '复制 App ID 和 App Secret',
    instructions: [
      '在左侧菜单点击「凭证与基础信息」',
      '复制 App ID 和 App Secret 到下方输入框',
    ],
    fields: [
      { key: 'app_id', label: 'App ID', placeholder: 'cli_xxxxxxxxxx' },
      { key: 'app_secret', label: 'App Secret', placeholder: '点击凭证页面的「复制」按钮', secret: true },
    ],
  },
  {
    id: 'publish',
    title: '发布应用',
    description: '创建版本并发布，机器人才能正常使用',
    instructions: [
      '在左侧菜单点击「版本管理与发布」',
      '点击「创建版本」，填写版本号和更新说明',
      '提交后等待管理员审核（自建应用通常秒过）',
      '发布成功后，回到 YiYi 点击下方「测试连接」验证',
    ],
  },
];

const FEISHU_STEPS_EN: GuideStep[] = [
  {
    id: 'create-app',
    title: 'Create Feishu App',
    description: 'Create a custom app on Feishu Open Platform',
    instructions: [
      'Open Feishu Open Platform and click "Create Custom App"',
      'Fill in app name (e.g. "YiYi AI Assistant") and description',
      'After creation, you\'ll enter the app management page',
    ],
    externalUrl: 'https://open.feishu.cn/app',
    externalLabel: 'Open Feishu Platform',
  },
  {
    id: 'enable-bot',
    title: 'Enable Bot Capability',
    description: 'Give the app the ability to send and receive messages',
    instructions: [
      'In app settings, click "Add Capabilities" in the left menu',
      'Find "Bot" capability and add it',
      'The Bot option will appear in the left sidebar menu',
    ],
  },
  {
    id: 'permissions',
    title: 'Configure Permissions',
    description: 'Grant the bot permissions to handle messages',
    instructions: [
      'Click "Permissions & Scopes" in the left menu',
      'Search and enable the following permissions:',
    ],
    checklist: [
      'im:message — Read and send messages',
      'im:message:send_as_bot — Send messages as bot',
      'im:chat:readonly — Read chat info',
      'contact:user.id:readonly — Read user IDs',
    ],
  },
  {
    id: 'event-config',
    title: 'Configure Events',
    description: 'Choose WebSocket mode (no public IP needed)',
    instructions: [
      'Click "Event Subscriptions" in the left menu',
      'Select "Long Connection (WebSocket)" as the request method',
      'Add event: search "Receive messages" and check im.message.receive_v1',
      'YiYi will receive messages via WebSocket — no public server needed',
    ],
  },
  {
    id: 'credentials',
    title: 'Get Credentials',
    description: 'Copy App ID and App Secret',
    instructions: [
      'Click "Credentials & Basic Info" in the left menu',
      'Copy App ID and App Secret into the fields below',
    ],
    fields: [
      { key: 'app_id', label: 'App ID', placeholder: 'cli_xxxxxxxxxx' },
      { key: 'app_secret', label: 'App Secret', placeholder: 'Click "Copy" on the credentials page', secret: true },
    ],
  },
  {
    id: 'publish',
    title: 'Publish App',
    description: 'Create a version and publish to make the bot active',
    instructions: [
      'Click "Version Management" in the left menu',
      'Click "Create Version", fill in version number and notes',
      'Submit for review (custom apps usually approve instantly)',
      'After publishing, click "Test Connection" below to verify',
    ],
  },
];

/* ── DingTalk Guide Steps ──────────────────────────────────── */

const DINGTALK_STEPS_ZH: GuideStep[] = [
  {
    id: 'create-app',
    title: '创建钉钉应用',
    description: '在钉钉开放平台创建一个企业内部应用',
    instructions: [
      '打开钉钉开放平台，进入「应用开发」→「企业内部开发」',
      '点击「创建应用」，选择「机器人」类型',
      '填写应用名称（如 "YiYi AI 助手"）和描述',
    ],
    externalUrl: 'https://open-dev.dingtalk.com/console/new/app',
    externalLabel: '打开钉钉开放平台',
  },
  {
    id: 'bot-config',
    title: '配置机器人',
    description: '启用机器人能力并选择 Stream 模式',
    instructions: [
      '在应用管理页面，点击「机器人与消息推送」',
      '开启「机器人配置」开关',
      '消息接收模式选择 「Stream 模式」（推荐，无需公网 IP）',
    ],
  },
  {
    id: 'permissions',
    title: '配置权限',
    description: '授予机器人必要的权限',
    instructions: [
      '在左侧菜单点击「权限管理」',
      '搜索并开通以下权限：',
    ],
    checklist: [
      'qyapi_robot_sendmsg — 企业内机器人发送消息',
      'qyapi_chat_manage — 群会话管理',
    ],
  },
  {
    id: 'credentials',
    title: '获取凭证',
    description: '复制 Client ID 和 Client Secret',
    instructions: [
      '在应用管理页面，点击「凭证与基础信息」',
      'Client ID 即 AppKey，Client Secret 即 AppSecret',
      '复制到下方输入框',
    ],
    fields: [
      { key: 'client_id', label: 'Client ID (AppKey)', placeholder: 'dingxxxxxxxxx' },
      { key: 'client_secret', label: 'Client Secret (AppSecret)', placeholder: '点击凭证页面的「复制」按钮', secret: true },
    ],
    externalUrl: 'https://open-dev.dingtalk.com/console/new/app',
    externalLabel: '打开应用管理',
  },
  {
    id: 'publish',
    title: '发布上线',
    description: '发布应用并添加机器人到群聊',
    instructions: [
      '点击「版本管理与发布」→「上线」',
      '发布后，在钉钉群聊中添加你的机器人',
      '群设置 → 智能群助手 → 添加机器人 → 选择你的应用',
      '回到 YiYi 点击「测试连接」验证',
    ],
  },
];

const DINGTALK_STEPS_EN: GuideStep[] = [
  {
    id: 'create-app',
    title: 'Create DingTalk App',
    description: 'Create an internal enterprise app on DingTalk Open Platform',
    instructions: [
      'Open DingTalk Open Platform → "App Development" → "Internal Development"',
      'Click "Create App", select "Bot" type',
      'Fill in app name (e.g. "YiYi AI Assistant") and description',
    ],
    externalUrl: 'https://open-dev.dingtalk.com/console/new/app',
    externalLabel: 'Open DingTalk Platform',
  },
  {
    id: 'bot-config',
    title: 'Configure Bot',
    description: 'Enable bot capability and choose Stream mode',
    instructions: [
      'In app settings, click "Bot & Message Push"',
      'Toggle on "Bot Configuration"',
      'Select "Stream Mode" for message receiving (recommended, no public IP needed)',
    ],
  },
  {
    id: 'permissions',
    title: 'Configure Permissions',
    description: 'Grant the bot necessary permissions',
    instructions: [
      'Click "Permission Management" in the left menu',
      'Search and enable the following permissions:',
    ],
    checklist: [
      'qyapi_robot_sendmsg — Send messages as bot',
      'qyapi_chat_manage — Manage group chats',
    ],
  },
  {
    id: 'credentials',
    title: 'Get Credentials',
    description: 'Copy Client ID and Client Secret',
    instructions: [
      'In app settings, click "Credentials & Basic Info"',
      'Client ID = AppKey, Client Secret = AppSecret',
      'Copy them into the fields below',
    ],
    fields: [
      { key: 'client_id', label: 'Client ID (AppKey)', placeholder: 'dingxxxxxxxxx' },
      { key: 'client_secret', label: 'Client Secret (AppSecret)', placeholder: 'Click "Copy" on credentials page', secret: true },
    ],
    externalUrl: 'https://open-dev.dingtalk.com/console/new/app',
    externalLabel: 'Open App Settings',
  },
  {
    id: 'publish',
    title: 'Publish & Deploy',
    description: 'Publish the app and add bot to group chats',
    instructions: [
      'Click "Version Management" → "Publish"',
      'After publishing, add the bot to a DingTalk group',
      'Group Settings → Smart Assistant → Add Bot → Select your app',
      'Return to YiYi and click "Test Connection" to verify',
    ],
  },
];

/* ── WeCom Guide Steps ─────────────────────────────────────── */

const WECOM_STEPS_ZH: GuideStep[] = [
  {
    id: 'create-app',
    title: '创建企业微信自建应用',
    description: '在企业微信管理后台创建一个自建应用',
    instructions: [
      '使用管理员账号登录企业微信管理后台',
      '点击「应用管理」→「自建」→「创建应用」',
      '填写应用名称（如 "YiYi AI 助手"）、上传 Logo、选择可见范围',
      '创建完成后进入应用详情页',
    ],
    externalUrl: 'https://work.weixin.qq.com/wework_admin/frame#apps/createApiApp',
    externalLabel: '打开企业微信管理后台',
  },
  {
    id: 'credentials',
    title: '获取凭证',
    description: '复制 Corp ID、Corp Secret 和 Agent ID',
    instructions: [
      'Corp ID：在「我的企业」→「企业信息」页面底部查看',
      'Corp Secret：在应用详情页查看「Secret」，点击查看并复制',
      'Agent ID：在应用详情页查看「AgentId」',
      '将这三项复制到下方输入框',
    ],
    fields: [
      { key: 'corp_id', label: 'Corp ID', placeholder: 'wwxxxxxxxxxxxxxxxx' },
      { key: 'corp_secret', label: 'Corp Secret', placeholder: '点击应用详情页的「查看」按钮', secret: true },
      { key: 'agent_id', label: 'Agent ID', placeholder: '1000002' },
    ],
    externalUrl: 'https://work.weixin.qq.com/wework_admin/frame#profile',
    externalLabel: '查看企业信息',
  },
  {
    id: 'ip-whitelist',
    title: '配置 IP 白名单',
    description: '将服务器 IP 添加到可信 IP 列表',
    instructions: [
      '在应用详情页找到「企业可信IP」配置',
      '添加你的服务器出口 IP 地址（本地开发可暂时跳过）',
      '如果不配置，API 调用可能会被拒绝',
      '提示：本地开发时，可以先测试连接看是否需要配置',
    ],
  },
  {
    id: 'callback-config',
    title: '配置消息回调',
    description: '设置回调 URL 接收用户消息',
    instructions: [
      '在应用详情页找到「接收消息」→「设置 API 接收」',
      '回调 URL 填写: http://你的服务器地址:9090/webhook/wecom',
      '本地开发可使用 ngrok、cpolar 等内网穿透工具',
      'Token 和 EncodingAESKey 可以随机生成（点击「随机获取」）',
      '保存后企业微信会发送验证请求到你的回调 URL',
    ],
  },
  {
    id: 'publish',
    title: '测试连接',
    description: '验证凭证并测试 Bot 是否正常',
    instructions: [
      '确保上方已填写 Corp ID、Corp Secret 和 Agent ID',
      '点击下方「测试连接」按钮验证凭证',
      '验证通过后，在企业微信中找到你创建的应用，发送消息试试',
      '如遇到 IP 白名单问题，请返回上一步配置',
    ],
  },
];

const WECOM_STEPS_EN: GuideStep[] = [
  {
    id: 'create-app',
    title: 'Create WeCom App',
    description: 'Create a self-built application in WeCom admin console',
    instructions: [
      'Log in to WeCom admin console as an administrator',
      'Go to "Applications" → "Self-built" → "Create App"',
      'Fill in app name (e.g. "YiYi AI Assistant"), upload logo, set visibility',
      'After creation, you\'ll enter the app details page',
    ],
    externalUrl: 'https://work.weixin.qq.com/wework_admin/frame#apps/createApiApp',
    externalLabel: 'Open WeCom Admin',
  },
  {
    id: 'credentials',
    title: 'Get Credentials',
    description: 'Copy Corp ID, Corp Secret, and Agent ID',
    instructions: [
      'Corp ID: Found at "My Enterprise" → "Enterprise Info" page bottom',
      'Corp Secret: On app details page, click "View" next to "Secret"',
      'Agent ID: Found on the app details page',
      'Copy all three values to the fields below',
    ],
    fields: [
      { key: 'corp_id', label: 'Corp ID', placeholder: 'wwxxxxxxxxxxxxxxxx' },
      { key: 'corp_secret', label: 'Corp Secret', placeholder: 'Click "View" on app details page', secret: true },
      { key: 'agent_id', label: 'Agent ID', placeholder: '1000002' },
    ],
    externalUrl: 'https://work.weixin.qq.com/wework_admin/frame#profile',
    externalLabel: 'View Enterprise Info',
  },
  {
    id: 'ip-whitelist',
    title: 'Configure IP Whitelist',
    description: 'Add your server IP to the trusted IP list',
    instructions: [
      'On the app details page, find "Trusted IPs" configuration',
      'Add your server\'s outbound IP address (can skip for local dev)',
      'Without this, API calls may be rejected',
      'Tip: For local development, try testing connection first to see if needed',
    ],
  },
  {
    id: 'callback-config',
    title: 'Configure Message Callback',
    description: 'Set up callback URL to receive user messages',
    instructions: [
      'On app details page, find "Receive Messages" → "Set API Receive"',
      'Callback URL: http://your-server:9090/webhook/wecom',
      'For local dev, use tools like ngrok or cpolar for tunneling',
      'Token and EncodingAESKey can be randomly generated (click "Generate")',
      'After saving, WeCom will send a verification request to your callback URL',
    ],
  },
  {
    id: 'publish',
    title: 'Test Connection',
    description: 'Verify credentials and test the bot',
    instructions: [
      'Make sure Corp ID, Corp Secret, and Agent ID are filled in above',
      'Click "Test Connection" below to verify credentials',
      'Once verified, find your app in WeCom and try sending a message',
      'If you encounter IP whitelist issues, go back and configure it',
    ],
  },
];

/* ── Component ─────────────────────────────────────────────── */

export function BotSetupGuide({
  platform,
  config,
  onConfigChange,
  onComplete,
  lang,
}: BotSetupGuideProps) {
  const { t } = useTranslation();
  const isZh = lang?.startsWith('zh') !== false;

  const steps = platform === 'feishu'
    ? (isZh ? FEISHU_STEPS_ZH : FEISHU_STEPS_EN)
    : platform === 'wecom'
    ? (isZh ? WECOM_STEPS_ZH : WECOM_STEPS_EN)
    : (isZh ? DINGTALK_STEPS_ZH : DINGTALK_STEPS_EN);

  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const markComplete = (idx: number) => {
    setCompletedSteps((prev) => new Set([...prev, idx]));
    if (idx < steps.length - 1) {
      setCurrentStep(idx + 1);
    }
  };

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<{ success: boolean; message: string }>(
        'bots_test_connection',
        { platform, config },
      );
      setTestResult(result);
      if (result.success) {
        markComplete(steps.length - 1);
      }
    } catch (error) {
      setTestResult({ success: false, message: String(error) });
    } finally {
      setTesting(false);
    }
  }, [platform, config]);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedField(null), 2000);
  };

  const allCredentialsFilled = platform === 'feishu'
    ? !!(config.app_id && config.app_secret)
    : platform === 'wecom'
    ? !!(config.corp_id && config.corp_secret && config.agent_id)
    : !!(config.client_id && config.client_secret);

  const platformColor = platform === 'feishu' ? '#3370FF' : platform === 'wecom' ? '#07C160' : '#0A6CFF';

  return (
    <div className="space-y-4">
      {/* Header banner */}
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl"
        style={{ background: platformColor + '08', border: `1px solid ${platformColor}20` }}
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: platformColor + '15' }}
        >
          <Sparkles size={18} style={{ color: platformColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
            {isZh ? 'AI 引导开通' : 'AI-Guided Setup'}
          </p>
          <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            {isZh
              ? '按照下方步骤操作，通常 3 分钟即可完成'
              : 'Follow the steps below — usually takes about 3 minutes'}
          </p>
        </div>
        {/* Benefits badges */}
        <div className="hidden sm:flex items-center gap-2">
          {platform !== 'wecom' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium"
              style={{ background: '#10B98115', color: '#10B981' }}>
              <Shield size={11} />
              {isZh ? '无需公网 IP' : 'No public IP'}
            </span>
          )}
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium"
            style={{ background: '#F59E0B15', color: '#F59E0B' }}>
            <Zap size={11} />
            {platform === 'wecom' ? 'Webhook' : 'WebSocket'}
          </span>
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-1">
        {steps.map((step, idx) => {
          const isActive = currentStep === idx;
          const isCompleted = completedSteps.has(idx);
          const isLast = idx === steps.length - 1;

          return (
            <div key={step.id}>
              {/* Step header */}
              <button
                onClick={() => setCurrentStep(idx)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all"
                style={{
                  background: isActive ? 'var(--color-bg-elevated)' : 'transparent',
                  border: isActive ? '1px solid var(--color-border)' : '1px solid transparent',
                }}
              >
                {/* Step indicator */}
                <div className="shrink-0">
                  {isCompleted ? (
                    <CheckCircle size={20} style={{ color: '#10B981' }} />
                  ) : isActive ? (
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
                      style={{ background: platformColor }}
                    >
                      {idx + 1}
                    </div>
                  ) : (
                    <Circle size={20} style={{ color: 'var(--color-text-muted)' }} />
                  )}
                </div>

                {/* Title + desc */}
                <div className="flex-1 min-w-0">
                  <span
                    className="text-[13px] font-medium"
                    style={{
                      color: isActive ? 'var(--color-text)' : isCompleted ? '#10B981' : 'var(--color-text-secondary)',
                    }}
                  >
                    {step.title}
                  </span>
                  {!isActive && (
                    <span className="text-[12px] ml-2" style={{ color: 'var(--color-text-muted)' }}>
                      {step.description}
                    </span>
                  )}
                </div>

                {!isActive && (
                  <ChevronRight size={14} style={{ color: 'var(--color-text-muted)' }} />
                )}
              </button>

              {/* Step content (expanded) */}
              {isActive && (
                <div className="ml-8 mr-4 mb-3 mt-1 space-y-3">
                  {/* Description */}
                  <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                    {step.description}
                  </p>

                  {/* Instructions */}
                  <div className="space-y-2">
                    {step.instructions.map((inst, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span
                          className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5"
                          style={{
                            background: platformColor + '12',
                            color: platformColor,
                          }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text)' }}>
                          {inst}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Permission checklist */}
                  {step.checklist && (
                    <div
                      className="rounded-lg px-3 py-2.5 space-y-1.5"
                      style={{ background: 'var(--color-bg-subtle)' }}
                    >
                      {step.checklist.map((item, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <div
                            className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                            style={{ borderColor: platformColor + '40' }}
                          >
                            <Check size={10} style={{ color: platformColor }} />
                          </div>
                          <span className="text-[12px] font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                            {item}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Config fields */}
                  {step.fields && (
                    <div className="space-y-2.5">
                      {step.fields.map((field) => (
                        <div key={field.key}>
                          <label className="block text-[12px] font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                            {field.label}
                          </label>
                          <div className="flex gap-2">
                            <input
                              type={field.secret ? 'password' : 'text'}
                              value={config[field.key] || ''}
                              onChange={(e) =>
                                onConfigChange({ ...config, [field.key]: e.target.value })
                              }
                              placeholder={field.placeholder}
                              className="flex-1 rounded-xl border px-3.5 py-2.5 text-[13px] font-mono focus:outline-none focus:ring-2 transition-shadow"
                              style={{
                                background: 'var(--color-bg)',
                                borderColor: 'var(--color-border)',
                                color: 'var(--color-text)',
                              }}
                            />
                            {config[field.key] && (
                              <button
                                onClick={() => handleCopy(config[field.key], field.key)}
                                className="p-2.5 rounded-xl border transition-colors shrink-0"
                                style={{ borderColor: 'var(--color-border)' }}
                                title="Copy"
                              >
                                {copiedField === field.key ? (
                                  <Check size={14} style={{ color: '#10B981' }} />
                                ) : (
                                  <Copy size={14} style={{ color: 'var(--color-text-muted)' }} />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* External link button */}
                  {step.externalUrl && (
                    <button
                      onClick={() => open(step.externalUrl!)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-opacity hover:opacity-80 text-white"
                      style={{ background: platformColor }}
                    >
                      <ExternalLink size={12} />
                      {step.externalLabel}
                    </button>
                  )}

                  {/* Test connection button (on last step or credentials step) */}
                  {(isLast || step.fields) && allCredentialsFilled && (
                    <div className="pt-1">
                      <button
                        onClick={handleTestConnection}
                        disabled={testing}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
                        style={{
                          background: testResult?.success ? '#10B98118' : 'var(--color-bg-subtle)',
                          color: testResult?.success ? '#10B981' : 'var(--color-text)',
                          border: `1px solid ${testResult?.success ? '#10B98130' : 'var(--color-border)'}`,
                        }}
                      >
                        {testing ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            {isZh ? '测试中...' : 'Testing...'}
                          </>
                        ) : testResult?.success ? (
                          <>
                            <CheckCircle size={14} />
                            {isZh ? '连接成功' : 'Connected'}
                          </>
                        ) : (
                          <>
                            <Zap size={14} />
                            {isZh ? '测试连接' : 'Test Connection'}
                          </>
                        )}
                      </button>

                      {/* Test result message */}
                      {testResult && (
                        <div
                          className="flex items-start gap-2 mt-2 px-3 py-2 rounded-lg text-[12px]"
                          style={{
                            background: testResult.success ? '#10B98108' : '#EF444408',
                            color: testResult.success ? '#10B981' : '#EF4444',
                          }}
                        >
                          {testResult.success ? (
                            <CheckCircle size={14} className="shrink-0 mt-0.5" />
                          ) : (
                            <AlertCircle size={14} className="shrink-0 mt-0.5" />
                          )}
                          <span>{testResult.message}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Next / Complete button */}
                  <div className="flex items-center gap-2 pt-1">
                    {!isLast ? (
                      <button
                        onClick={() => markComplete(idx)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                        style={{ background: platformColor }}
                      >
                        {isZh ? '下一步' : 'Next'}
                        <ChevronRight size={14} />
                      </button>
                    ) : (
                      <button
                        onClick={onComplete}
                        disabled={!allCredentialsFilled}
                        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                        style={{ background: '#10B981' }}
                      >
                        <CheckCircle size={14} />
                        {isZh ? '完成创建' : 'Complete Setup'}
                      </button>
                    )}

                    {!isLast && (
                      <button
                        onClick={() => setCurrentStep(idx + 1)}
                        className="text-[12px] px-3 py-2 rounded-lg transition-colors"
                        style={{ color: 'var(--color-text-muted)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        {isZh ? '跳过' : 'Skip'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Progress summary */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          {completedSteps.size} / {steps.length} {isZh ? '步已完成' : 'steps completed'}
        </span>
        <div className="flex gap-1">
          {steps.map((_, idx) => (
            <div
              key={idx}
              className="w-6 h-1.5 rounded-full transition-colors"
              style={{
                background: completedSteps.has(idx)
                  ? '#10B981'
                  : idx === currentStep
                    ? platformColor
                    : 'var(--color-bg-muted)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Check if a platform supports the guided setup wizard */
export function hasSetupGuide(platform: string): boolean {
  return platform === 'feishu' || platform === 'dingtalk' || platform === 'wecom';
}

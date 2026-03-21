/**
 * Platform metadata shared across bot components
 */

export interface PlatformMeta {
  icon: string;
  color: string;
  docUrl: string;
  docLabel: string;
  configFields: { key: string; label: string; placeholder: string; secret?: boolean }[];
}

export const PLATFORM_META: Record<string, PlatformMeta> = {
  discord: {
    icon: '🎮',
    color: '#5865F2',
    docUrl: 'https://discord.com/developers/docs/intro',
    docLabel: 'Discord Developer Docs',
    configFields: [
      { key: 'bot_token', label: 'Bot Token', placeholder: 'MTxxxxxxxx.xxxxxx.xxxxxxxx', secret: true },
    ],
  },
  telegram: {
    icon: '✈️',
    color: '#26A5E4',
    docUrl: 'https://core.telegram.org/bots/api',
    docLabel: 'Telegram Bot API Docs',
    configFields: [
      { key: 'bot_token', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', secret: true },
    ],
  },
  qq: {
    icon: '🐧',
    color: '#12B7F5',
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/',
    docLabel: 'QQ Bot Docs',
    configFields: [
      { key: 'app_id', label: 'App ID', placeholder: '10xxxxxxx' },
      { key: 'client_secret', label: 'Client Secret (AppSecret)', placeholder: 'xxxxx', secret: true },
    ],
  },
  dingtalk: {
    icon: '🔔',
    color: '#0A6CFF',
    docUrl: 'https://open.dingtalk.com/document/orgapp/robot-overview',
    docLabel: 'DingTalk Bot Docs',
    configFields: [
      { key: 'client_id', label: 'Client ID (AppKey)', placeholder: 'dingxxxxxxxxx' },
      { key: 'client_secret', label: 'Client Secret (AppSecret)', placeholder: 'xxxxx', secret: true },
    ],
  },
  feishu: {
    icon: '🚀',
    color: '#3370FF',
    docUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/bot-overview',
    docLabel: 'Feishu Bot Docs',
    configFields: [
      { key: 'app_id', label: 'App ID', placeholder: 'cli_xxxxx' },
      { key: 'app_secret', label: 'App Secret', placeholder: 'xxxxx', secret: true },
    ],
  },
  wecom: {
    icon: '🏢',
    color: '#07C160',
    docUrl: 'https://developer.work.weixin.qq.com/document/path/90664',
    docLabel: 'WeCom Docs',
    configFields: [
      { key: 'corp_id', label: 'Corp ID', placeholder: 'wwxxxxxxxx' },
      { key: 'corp_secret', label: 'Corp Secret', placeholder: 'xxxxx', secret: true },
      { key: 'agent_id', label: 'Agent ID', placeholder: '1000002' },
    ],
  },
  webhook: {
    icon: '🔗',
    color: '#6B7280',
    docUrl: '',
    docLabel: '',
    configFields: [
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://your-server.com/webhook' },
      { key: 'port', label: 'Listen Port', placeholder: '9090' },
    ],
  },
};

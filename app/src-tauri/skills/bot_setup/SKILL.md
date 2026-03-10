---
name: bot_setup
description: "当用户要求添加/配置/连接机器人（Bot）到任意平台（飞书、钉钉、QQ、Discord、Telegram、企业微信）时使用此技能。会自动打开浏览器引导用户在对应开放平台创建应用、获取凭据，然后调用 manage_bot 完成创建。"
metadata:
  {
    "yiclaw":
      {
        "emoji": "🤖",
        "requires": {}
      }
  }
---

# Bot 配置引导技能

当用户说「帮我添加飞书机器人」「配置 Discord bot」「连接 Telegram」等时，使用此技能引导用户完成整个配置流程。

## 核心流程

1. **确认平台** — 询问用户要配置哪个平台
2. **打开浏览器** — 用 `browser_use`（headed=true）打开对应平台的开发者控制台
3. **引导操作** — 使用 `ai_snapshot` + `act` 辅助用户在页面上操作
4. **获取凭据** — 从页面提取 App ID、Secret 等信息
5. **创建 Bot** — 调用 `manage_bot` 的 create action 完成创建
6. **测试连接** — 启动 Bot 并发送测试消息

## 各平台详细配置步骤

### 飞书 (Feishu)

**所需凭据**: `app_id`, `app_secret`, `webhook_url`

**步骤 1: 创建应用**
- 打开 https://open.feishu.cn/app （国际版: https://open.larksuite.com/app）
- 如果用户未登录，提示用户登录飞书账号
- 点击「创建企业自建应用」
- 填写应用名称和描述

**步骤 2: 获取凭据**
- 进入应用 → 「凭证与基础信息」页面
- 复制 **App ID**（格式: `cli_xxxxxxxx`）
- 复制 **App Secret**

**步骤 3: 启用机器人能力**
- 进入「应用能力 > 机器人」
- 开启机器人功能

**步骤 4: 配置权限**
- 进入「权限管理」
- 搜索并开通以下权限:
  - `im:message` — 获取与发送消息
  - `im:message:send_as_bot` — 以机器人身份发送消息
  - `im:chat:readonly` — 获取群组信息
  - `contact:user.id:readonly` — 获取用户 ID

**步骤 5: 配置事件订阅**
- 进入「事件订阅」
- 选择「使用长连接接收事件」（推荐，无需公网 URL）
  - 或设置请求地址: `http://<你的IP>:9090/webhook/feishu`
- 添加事件: `im.message.receive_v1`（接收消息）

**步骤 6: 发布应用**
- 进入「版本管理与发布」
- 创建版本并提交审核
- 审核通过后即可使用

**步骤 7: 在 YiClaw 创建 Bot**
```json
{
  "action": "create",
  "platform": "feishu",
  "name": "我的飞书机器人",
  "config": {
    "app_id": "cli_xxxxxxxx",
    "app_secret": "从页面复制的密钥",
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx"
  }
}
```

---

### 钉钉 (DingTalk)

**所需凭据**: `webhook_url`, `secret`

**步骤 1: 创建机器人**
- 打开 https://open-dev.dingtalk.com/
- 登录后进入「应用开发 > 机器人」
- 点击「创建机器人」

**步骤 2: 获取 Webhook**
- 在群设置中添加自定义机器人
- 安全设置选择「加签」，复制 **Secret**
- 复制 **Webhook URL**

**步骤 3: 在 YiClaw 创建 Bot**
```json
{
  "action": "create",
  "platform": "dingtalk",
  "name": "我的钉钉机器人",
  "config": {
    "webhook_url": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
    "secret": "SECxxxxxxxx"
  }
}
```

---

### QQ

**所需凭据**: `app_id`, `client_secret`

**步骤 1: 创建应用**
- 打开 https://q.qq.com/
- 登录 QQ 开放平台
- 创建一个机器人应用

**步骤 2: 获取凭据**
- 在应用详情中复制 **App ID** 和 **Client Secret**
- 配置沙箱或正式环境的频道权限

**步骤 3: 在 YiClaw 创建 Bot**
```json
{
  "action": "create",
  "platform": "qq",
  "name": "我的QQ机器人",
  "config": {
    "app_id": "你的AppID",
    "client_secret": "你的ClientSecret"
  }
}
```

---

### Discord

**所需凭据**: `bot_token`

**步骤 1: 创建应用**
- 打开 https://discord.com/developers/applications
- 点击 "New Application"，填写名称

**步骤 2: 创建 Bot**
- 进入应用 → "Bot" 页面
- 点击 "Add Bot"
- 复制 **Bot Token**（点击 "Reset Token" 生成新的）

**步骤 3: 配置权限和意图**
- 开启 "Message Content Intent"
- 在 "OAuth2 > URL Generator" 中:
  - Scopes: `bot`
  - Bot Permissions: `Send Messages`, `Read Message History`
- 复制生成的邀请链接，在浏览器中打开以将 Bot 邀请到你的服务器

**步骤 4: 在 YiClaw 创建 Bot**
```json
{
  "action": "create",
  "platform": "discord",
  "name": "我的Discord机器人",
  "config": {
    "bot_token": "你的BotToken"
  }
}
```

---

### Telegram

**所需凭据**: `bot_token`

**步骤 1: 创建 Bot**
- 在 Telegram 中搜索 **@BotFather** 并发送 `/newbot`
- 按提示输入 Bot 名称和用户名
- BotFather 会返回 **Bot Token**

**步骤 2: 在 YiClaw 创建 Bot**
```json
{
  "action": "create",
  "platform": "telegram",
  "name": "我的Telegram机器人",
  "config": {
    "bot_token": "从BotFather获取的Token"
  }
}
```

---

### 企业微信 (WeCom)

**所需凭据**: `corp_id`, `corp_secret`, `agent_id`

**步骤 1: 创建应用**
- 打开 https://work.weixin.qq.com/wework_admin/frame
- 进入「应用管理 > 自建应用」
- 点击「创建应用」

**步骤 2: 获取凭据**
- **Corp ID**: 在「我的企业 > 企业信息」底部
- **Agent ID**: 在应用详情页
- **Corp Secret**: 在应用详情页点击查看

**步骤 3: 配置回调**
- 在应用的「接收消息」中设置回调 URL: `http://<你的IP>:9090/webhook/wecom`
- 配置 Token 和 EncodingAESKey

**步骤 4: 在 YiClaw 创建 Bot**
```json
{
  "action": "create",
  "platform": "wecom",
  "name": "我的企业微信机器人",
  "config": {
    "corp_id": "你的CorpID",
    "corp_secret": "你的CorpSecret",
    "agent_id": "你的AgentID"
  }
}
```

---

## 浏览器辅助操作指南

在引导用户配置时，按以下模式使用浏览器:

1. **启动可见浏览器**:
   ```json
   {"action": "start", "headed": true}
   ```

2. **打开开发者控制台**:
   ```json
   {"action": "open", "url": "https://open.feishu.cn/app"}
   ```

3. **获取页面结构（使用 AI Snapshot）**:
   ```json
   {"action": "ai_snapshot"}
   ```
   这会返回带编号的可交互元素列表，如 `[1] <button>创建应用</button>`

4. **操作页面元素**:
   ```json
   {"action": "act", "element": 1, "operation": "click"}
   ```

5. **等待用户操作**（如登录、输入验证码）:
   - 告诉用户需要手动完成的步骤
   - 使用 `{"action": "wait", "timeout": 10000}` 等待
   - 再次 `ai_snapshot` 检查页面状态

6. **提取凭据**: 从页面快照中识别 App ID / Secret 等信息

## 注意事项

- 始终以 **headed=true** 模式启动浏览器，让用户能看到操作过程
- 涉及登录、验证码等步骤时，**提示用户手动操作**，不要尝试自动化
- 获取到凭据后，**立即使用 manage_bot 创建 Bot**，避免用户需要手动复制粘贴
- 创建完成后，自动调用 `manage_bot` 的 `start` action 启动 Bot
- 如果用户的网络环境无法访问某些平台（如 Discord、Telegram），提示使用代理

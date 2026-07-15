// chat 域路由表:新旧 chat URL 都进入同一个 WorkspaceAgent,问数由 query_project_data 服务工具完成。
// 一域一文件,避免多 agent 扇出冲突。两条 SSE 流式端点标 stream:true(transport 注入 emit + 收尾 [DONE]/end)。
import * as agentChat from "../app/chat/agent_chat.js";
import * as agentMisc from "../app/chat/agent_misc.js";

export const chatRoutes = [
  // ── 旧问数 URL 兼容层:不再直达 QueryAgent ──
  { m: "POST", p: "/api/projects/:pid/sessions/:sid/chat", fn: agentChat.agentChat, auth: true, stream: true },

  // ── 工作台 Agent 对话(流式,抽自 routes/agent_chat.js)──
  { m: "POST", p: "/api/agent/projects/:pid/sessions/:sid/chat", fn: agentChat.agentChat, auth: true, stream: true },

  // ── 工作台 Agent 周边非流式端点(抽自 routes/agent_chat.js)──
  { m: "POST", p: "/api/agent/tool-decision", fn: agentMisc.resolveToolDecision, auth: true },
  { m: "GET", p: "/api/agent/skills", fn: agentMisc.listAppAgentSkills, auth: true },
  { m: "POST", p: "/api/agent/skills", fn: agentMisc.createAppAgentSkill, auth: true },
  { m: "GET", p: "/api/agent/skills/enabled/list", fn: agentMisc.listEnabledAppAgentSkills, auth: true },
  { m: "GET", p: "/api/agent/skills/available-tools", fn: agentMisc.listAppSkillAvailableTools, auth: true },
  { m: "POST", p: "/api/agent/skills/ai-generate", fn: agentMisc.aiGenerateAppAgentSkill, auth: true },
  { m: "PATCH", p: "/api/agent/skills/:skillName/toggle", fn: agentMisc.toggleAppAgentSkill, auth: true },
  { m: "GET", p: "/api/agent/skills/:skillName", fn: agentMisc.getAppAgentSkill, auth: true },
  { m: "PUT", p: "/api/agent/skills/:skillName", fn: agentMisc.updateAppAgentSkill, auth: true },
  { m: "DELETE", p: "/api/agent/skills/:skillName", fn: agentMisc.deleteAppAgentSkill, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/sessions", fn: agentMisc.listAgentSessions, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/model", fn: agentMisc.getAgentModel, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/files", fn: agentMisc.getAgentFiles, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/file", fn: agentMisc.getAgentFile, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/sessions/:sid/compact", fn: agentMisc.compactAgentSession, auth: true },
];

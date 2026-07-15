/**
 * Prompt 模板加载器(Node 版,对应 Python config/prompt_templates_loader.py)。
 *
 * Python 版从 prompt_templates.yaml 加载并解析 {{include:}};桌面版改为加载
 * **预解析好的 JSON**(app/server/config/agent_configs.zh.json,由 Python loader
 * 导出,include 已展开),避免在 Node 端引入 YAML 依赖。
 *
 * 导出 get_default_agent_configs() 供 AgentSettings 降级取默认 prompt。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.AGENT_CONFIGS_PATH || join(__dir, "../../config/agent_configs.zh.json");

let _configs = null;
function _load() {
  if (_configs) return _configs;
  try {
    _configs = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`[prompt_templates] 加载 ${CONFIG_PATH} 失败: ${e?.message ?? e}`);
    _configs = {};
  }
  return _configs;
}

/** 所有 Agent 类型默认配置:{ [agentType]: { name, system_prompt, user_prompt_template, rules } } */
export function get_default_agent_configs() {
  return _load();
}

/** 按模板名取内容,name 形如 'super_agent_system' / 'format_user'(兼容直接 agentType)。 */
export function load_prompt_template(name) {
  const cfg = _load();
  if (cfg[name]) return cfg[name].system_prompt || "";
  const m = String(name).match(/^(.+)_(system|user)$/);
  if (m && cfg[m[1]]) {
    return m[2] === "system" ? (cfg[m[1]].system_prompt || "") : (cfg[m[1]].user_prompt_template || "");
  }
  return "";
}

export default { get_default_agent_configs, load_prompt_template };

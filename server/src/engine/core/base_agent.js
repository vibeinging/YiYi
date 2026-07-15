import { traceAgentCall } from "../trace/trace_context.js";

function compactAgentInput(agentContext = {}) {
  const input = agentContext?.input_data || {};
  return {
    user_message: input.user_message || "",
    enhanced_user_query: input.enhanced_user_query || "",
    project_id: agentContext?.project_id || input.project_id || "",
    session_id: agentContext?.session_id || input.session_id || "",
    business_id: input.business_id || "",
  };
}

function jsonText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class BaseAgent {
  constructor({ name = "", description = "" } = {}) {
    this.name = name || this.constructor.name;
    this.description = description || `${this.name} Agent`;

    const rawExecute = this.execute;
    if (rawExecute && rawExecute !== BaseAgent.prototype.execute && !this.__baseAgentExecuteWrapped) {
      Object.defineProperty(this, "_executeImpl", {
        value: rawExecute.bind(this),
        configurable: false,
        enumerable: false,
        writable: false,
      });
      Object.defineProperty(this, "__baseAgentExecuteWrapped", {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      this.execute = (agentContext, streamCallback, ...args) =>
        this.executeWithLifecycle(agentContext, streamCallback, ...args);
    }

    const rawRun = this.run;
    if (rawRun && rawRun !== BaseAgent.prototype.run && !this.__baseAgentRunWrapped) {
      Object.defineProperty(this, "_runImpl", {
        value: rawRun.bind(this),
        configurable: false,
        enumerable: false,
        writable: false,
      });
      Object.defineProperty(this, "__baseAgentRunWrapped", {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      this.run = (agentContext, streamCallback, ...args) =>
        this.runWithLifecycle(agentContext, streamCallback, ...args);
    }
  }

  async execute(_agentContext, _streamCallback) {
    throw new Error(`${this.constructor.name}.execute() 未实现`);
  }

  async run(_agentContext, _streamCallback) {
    throw new Error(`${this.constructor.name}.run() 未实现`);
  }

  async executeWithLifecycle(agentContext, streamCallback, ...args) {
    const executeImpl = this._executeImpl || BaseAgent.prototype.execute.bind(this);
    return this._callWithLifecycle("execute", agentContext, streamCallback, args, executeImpl);
  }

  async runWithLifecycle(agentContext, streamCallback, ...args) {
    const runImpl = this._runImpl || BaseAgent.prototype.run.bind(this);
    return this._callWithLifecycle("run", agentContext, streamCallback, args, runImpl);
  }

  async _callWithLifecycle(method, agentContext, streamCallback, args, fn) {
    return traceAgentCall(
      {
        name: this.name || this.constructor.name,
        input: compactAgentInput(agentContext),
        attrs: {
          trace_source: "base_agent",
          agent_method: method,
          agent_class: this.constructor.name,
        },
        resultToText: jsonText,
      },
      () => fn(agentContext, streamCallback, ...args),
    );
  }
}

export async function runAgent(agent, agentContext, streamCallback, { method = "" } = {}) {
  if (!agent || typeof agent !== "object") throw new Error("runAgent 需要传入 agent 实例");
  const resolved =
    method ||
    (agent._executeImpl || agent.__baseAgentExecuteWrapped
      ? "execute"
      : agent._runImpl || agent.__baseAgentRunWrapped
        ? "run"
        : typeof agent.execute === "function"
          ? "execute"
          : "run");
  if (resolved === "execute" && typeof agent.execute === "function") {
    return agent.execute(agentContext, streamCallback);
  }
  if (resolved === "run" && typeof agent.run === "function") {
    return agent.run(agentContext, streamCallback);
  }
  throw new Error(`agent 缺少 ${resolved}() 方法`);
}

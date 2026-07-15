export class SkillHookRegistry {
  constructor(hooks = []) {
    this.hooks = [...hooks].sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  async beforeToolCall(ctx, signal) {
    for (const hook of this.hooks) {
      if (typeof hook.beforeToolCall !== "function") continue;
      const result = await hook.beforeToolCall(ctx, signal);
      if (result?.block) return result;
    }
    return undefined;
  }

  async afterToolCall(ctx, signal) {
    let override;
    for (const hook of this.hooks) {
      if (typeof hook.afterToolCall !== "function") continue;
      const result = await hook.afterToolCall(ctx, signal);
      if (result) override = { ...(override || {}), ...result };
    }
    return override;
  }

  async onEvent(ctx, event) {
    for (const hook of this.hooks) {
      if (typeof hook.onEvent !== "function") continue;
      await hook.onEvent(ctx, event);
    }
  }
}

export default { SkillHookRegistry };

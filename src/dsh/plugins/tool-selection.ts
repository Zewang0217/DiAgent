/** 根据本次请求的授权限制 DSH Agent 可见且可调用的工具。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-tools';

export const name = 'diagent-tool-selection';
export const inject = ['agents', 'tools'];

interface ToolSelection {
  toolIds?: string[];
  mcpServerNames?: string[];
  subagentTools?: Record<string, string[]>;
}

/** 应用工具名单和已获授权的 MCP 服务。 */
export function apply(ctx: Context, config: ToolSelection): void {
  const prefixes = (config.mcpServerNames ?? []).map(name => 'mcp__' + name + '__');
  ctx.on('agent/created', ({ agent }): undefined => {
    if (config.subagentTools && agent.session.header.parentSession !== undefined) {
      // 用 DSH 绑定的 preset 确定工具权限。未登记的子会话默认无工具。
      const preset = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx);
      const allow = preset && Object.hasOwn(config.subagentTools, preset) ? config.subagentTools[preset] : [];
      agent.ctx.tools.restrict({ allow });
      return;
    }
    const registered = ctx.tools.definitions().map(tool => tool.name);
    if (config.toolIds === undefined) {
      // 保留旧任务的默认工具，只移除实际注册且非具名委托所需的控制工具。
      const deny = ['send_message', 'list_agents', 'interrupt_agent'].filter(name => registered.includes(name));
      agent.ctx.tools.restrict({ deny });
      return;
    }
    const discovered = registered.filter(name => prefixes.some(prefix => name.startsWith(prefix)));
    agent.ctx.tools.restrict({ allow: [...config.toolIds.filter(id => id !== 'mcp'), ...discovered] });
  }, { global: true });
}

/** 为本次 Chat 限定模型工具，允许旧 shell 在内部委派给 Bash。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';

export const name = 'diagent-chat-tool-selection';
export const inject = ['agents', 'tools'];

/** 将经过服务校验的工具名单应用于 DSH 会话。 */
export function apply(ctx: Context, config: { toolIds: string[]; mcpServerNames?: string[] }): void {
  const prefixes = (config.mcpServerNames ?? []).map(name => 'mcp__' + name + '__');
  ctx.on('agent/created', ({ agent }): undefined => {
    const discovered = ctx.tools.definitions().map(tool => tool.name)
      .filter(name => prefixes.some(prefix => name.startsWith(prefix)));
    agent.ctx.tools.restrict({ allow: [...config.toolIds, ...discovered] });
  }, { global: true });
}

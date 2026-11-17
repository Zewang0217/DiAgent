/** 按会话装配文件系统 Skills 和 MCP 连接，作用域随 Agent 生命周期回收。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-system-prompt';
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem';
import * as mcpClient from '@deepseek-ai/dsh-mcp-client';
import type { mcpProfileRows } from '../profile.js';

export const name = 'diagent-task-agent-resources';
export const inject = ['agents'];

interface AgentResources {
  skillRoots: string[];
  mcp: Array<ReturnType<typeof mcpProfileRows>[number]['config']>;
}

interface TaskResources {
  root: AgentResources;
  children: Record<string, AgentResources>;
  rootMcpServerNames: string[];
}

/** 等待会话可见的初始工具发现完成后，再发出首次模型请求。 */
export function apply(ctx: Context, { root, children, rootMcpServerNames }: TaskResources): void {
  ctx.on('agent/created', async ({ agent }) => {
    const isChild = agent.session.header.parentSession !== undefined;
    const preset = isChild ? agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) : undefined;
    const resources = isChild ? (preset && Object.hasOwn(children, preset) ? children[preset] : undefined) : root;
    if (!resources) return;
    if (isChild && rootMcpServerNames.length > 0) {
      const hidden = rootMcpServerNames.filter(name => !resources.mcp.some(server => server.serverName === name));
      await agent.ctx.inject(['systemPrompt'], scoped => {
        // MCP 客户端把服务器提示注册为同名 section，作用域内的空段覆盖继承的根提示。
        for (const name of hidden) {
          scoped.systemPrompt.section({
            name: 'mcp:' + name, order: scoped.systemPrompt.getSectionOrder('MCP_SERVERS'), text: '',
          });
        }
      });
    }
    if (resources.skillRoots.length > 0) {
      await agent.ctx.plugin(skillFilesystem, { includeDefaultRoots: false, customSkillDirs: resources.skillRoots, watch: false });
    }
    await Promise.all(resources.mcp.map(config => agent.ctx.plugin(mcpClient, config)));
  }, { global: true });
}

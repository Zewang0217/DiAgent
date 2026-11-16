/** 将 DSH 进程内的实时文本增量送到现有 SDK Session 通道。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';

export const textDeltaRecord = 'plugin:diagent/chat-text';

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    [textDeltaRecord]: string;
  }
}

export const name = 'diagent-chat-stream';
export const inject = ['agents'];

/** SDK 不转发实时 assistant 事件，通过插件记录传递本轮可见文本。 */
export function apply(ctx: Context): void {
  const agentsWithOutput = new WeakSet<Agent>();
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta' && frame.chunk.text) {
      appendPluginRecord(agent.session, textDeltaRecord, frame.chunk.text);
      agentsWithOutput.add(agent);
    }
  }, { global: true });
  // 已交给 SDK 的文字无法撤回，重试会混入另一份回答。
  ctx.on('agent/request-error', async ({ agent }, next) => {
    if (agentsWithOutput.has(agent)) return undefined;
    return next();
  }, { global: true, prepend: true });
}

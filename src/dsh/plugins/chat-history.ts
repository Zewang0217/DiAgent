/** 将调用方提供的纯文本历史写入本次 DSH 会话的消息记录。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const name = 'diagent-chat-history';
export const inject = ['agents'];

/** 在首轮 prompt 入队前恢复消息顺序。导入的回答没有可重放的模型流。 */
export function apply(ctx: Context, config: {
  history: readonly ChatHistoryMessage[];
  personaPrefix: string;
}): void {
  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session;
    const placement = { surfaceOp: 'append' } as const;
    // DSH 的消息事件要求正数坐标。外部历史只填充消息记录，不开启执行轮次。
    const initialPosition = { turn: 1, step: 1 };
    // 为 DSH 后续渲染系统提示保留首位，历史消息紧随其后。
    session.append('system/message', {
      ...initialPosition, message: createSystemMessage(config.personaPrefix),
    }, placement);
    for (const entry of config.history) {
      const content = [{ type: 'text' as const, text: entry.content }];
      if (entry.role === 'user') {
        session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), placement);
      } else {
        const message = createAssistantMessage({ content, source: { provider: 'diagent-history', model: 'imported' } });
        session.append('assistant/message', { ...initialPosition, message, stream: [] }, placement);
      }
    }
    return undefined;
  }, { global: true });
}

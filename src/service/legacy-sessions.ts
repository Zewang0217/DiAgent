/** 独立服务的旧会话存储。各会话串行提交，进程退出后历史随之清空。 */
import type { ChatHistoryMessage } from '../dsh/plugins/chat-history.js';
import { ChatRequestError } from './chat.js';

interface Session {
  messages: ChatHistoryMessage[];
  created: number;
  last_access: number;
}

function positiveSetting(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/** 读取旧 Chat 请求的会话 ID，空值保持无状态请求。 */
export function legacySessionId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('session_id' in input) || input.session_id == null || input.session_id === '') return;
  const id = input.session_id;
  if (typeof id !== 'string' || id.length > 1024) throw new ChatRequestError('session_id must be a string of at most 1024 characters');
  return id;
}

/** 在调用方的系统提示和当前请求之间插入前几轮消息。 */
export function withSessionHistory(input: object, history: ChatHistoryMessage[]): object {
  if (!history.length || !('messages' in input) || !Array.isArray(input.messages)) return input;
  const isSystem = (message: unknown) => message !== null && typeof message === 'object'
    && 'role' in message && message.role === 'system';
  return { ...input, messages: [...input.messages.filter(isSystem), ...history, ...input.messages.filter(message => !isSystem(message))] };
}

/** 按旧配置限制消息数和 TTL，每个服务实例持有自己的历史。 */
export class LegacySessions {
  private readonly entries = new Map<string, Session>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly ttl: number;
  private readonly maxMessages: number;

  constructor(env: NodeJS.ProcessEnv) {
    this.ttl = positiveSetting(env.SESSION_TTL, 86_400);
    this.maxMessages = positiveSetting(env.MAX_HISTORY_MESSAGES, 50);
  }

  /** 同一会话中的请求和删除按到达顺序执行，失败不会阻塞后续请求。 */
  async serialize<T>(id: string, execute: () => Promise<T>): Promise<T> {
    const pending = this.pending.get(id);
    const next = pending ? pending.then(execute, execute) : Promise.resolve().then(execute);
    this.pending.set(id, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }

  /** 读取历史并刷新有效会话的空闲时间。 */
  get(id: string): ChatHistoryMessage[] {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) return [];
    this.entries.delete(id);
    entry.last_access = Date.now() / 1000;
    this.entries.set(id, entry);
    return entry.messages;
  }

  /** 保存一轮成功完成的对话，按旧上限淘汰最久未访问的会话。 */
  append(id: string, history: ChatHistoryMessage[], messages: ChatHistoryMessage[]): void {
    const now = Date.now() / 1000;
    const created = this.entries.get(id)?.created ?? now;
    this.entries.delete(id);
    this.entries.set(id, { messages: [...history, ...messages].slice(-this.maxMessages), created, last_access: now });
    this.sweep();
    if (this.entries.size > 200) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  /** 返回仍有效的会话元数据，省略消息正文。 */
  list(): Array<{ session_id: string; message_count: number; created: number; last_access: number }> {
    this.sweep();
    return Array.from(this.entries, ([session_id, entry]) => ({ session_id, message_count: entry.messages.length,
      created: entry.created, last_access: entry.last_access }));
  }

  /** 移除已存在且未过期的会话。 */
  delete(id: string): boolean {
    this.sweep();
    return this.entries.delete(id);
  }

  private sweep(): void {
    const deadline = Date.now() / 1000 - this.ttl;
    for (const [id, entry] of this.entries) {
      if (entry.last_access >= deadline) break;
      this.entries.delete(id);
    }
  }
}

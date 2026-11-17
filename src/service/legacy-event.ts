/** 将旧 CloudEvent 请求转换为单轮 DSH 输入，并保留同步响应格式。 */
import { ChatRequestError } from './chat.js';

/** 校验旧事件的字段，并构建旧服务使用的用户消息。 */
export function legacyEventChat(input: unknown): { id: string; messages: [{ role: 'user'; content: string }] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChatRequestError('Expected a CloudEvent object', 422);
  }
  const { id, source, type, specversion, subject, time, data = {} } = input as Record<string, unknown>;
  if (typeof id !== 'string' || typeof source !== 'string' || typeof type !== 'string'
    || [subject, time].some(value => value != null && typeof value !== 'string')
    || (specversion !== undefined && typeof specversion !== 'string')
    || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ChatRequestError('Invalid CloudEvent fields', 422);
  }
  const lines = [`[事件通知] 类型: ${type}`, `来源: ${source}`];
  if (subject) lines.push(`主题: ${subject}`);
  if (time) lines.push(`时间: ${time}`);
  lines.push('数据:\n```json\n' + JSON.stringify(data, null, 2) + '\n```');
  return { id, messages: [{ role: 'user', content: lines.join('\n') }] };
}

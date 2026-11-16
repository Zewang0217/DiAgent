/** 将 DSH 根会话的模型和工具事件转换为 DiOS Chat 可消费的 SSE 内容。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';

type ToolEvent = {
  tool_call_id: string;
  tool_name: string;
  timestamp: number;
} & (
  { type: 'tool_call_start'; arguments: object }
  | { type: 'tool_call_end'; result: string; duration_ms: number }
  | { type: 'tool_call_error'; error: string }
);

/** 一轮 Chat 的文本或旧工具事件，HTTP 层负责 SSE 编码。 */
export type ChatStreamOutput =
  | { type: 'content' | 'reasoning'; text: string }
  | { type: 'tool_call'; event: ToolEvent }
  | { type: 'event_approval'; event: { event_id: string } };

function previewArguments(source: string): object {
  if (source.length <= 4096) {
    try {
      const value: unknown = JSON.parse(source);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // 参数解析失败仍留下一条可读的诊断事件。
    }
  }
  return { input: source.slice(0, 4096) };
}

function eventToolStatus(result: string): { approvalId?: string; failure?: string } {
  if (result.startsWith('[publish_event failed]') || result.startsWith('[publish_event rejected]')) {
    return { failure: result };
  }
  try {
    const parsed = JSON.parse(result) as { status?: unknown; event_id?: unknown; ok?: unknown; error?: unknown } | null;
    if (parsed?.status === 'approval_required' && typeof parsed.event_id === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.event_id)) return { approvalId: parsed.event_id };
    if (parsed?.ok === false) return { failure: typeof parsed.error === 'string' && parsed.error ? parsed.error : result };
  } catch {
    // 兼容未携带机器可读状态的工具结果。
  }
  return {};
}

function shellFailure(result: string): string | undefined {
  const match = /^exit_code: (-?\d+)\nstdout:\n/.exec(result);
  if (!match || match[1] === '0') return undefined;
  const stderrStart = result.lastIndexOf('\nstderr:\n');
  const stdout = result.slice(match[0].length, stderrStart);
  // DiOS CLI 用退出码 3 表示已经生成确认令牌，结束帧仍供 DiOS 打开确认卡。
  if (match[1] === '3' && /"status"\s*:\s*"pending_hil"/.test(stdout)
    && /"token"\s*:\s*"[A-Za-z0-9_-]{22}"/.test(stdout)) return undefined;
  const stderr = stderrStart === -1 ? '' : result.slice(stderrStart + '\nstderr:\n'.length).trim();
  return stderr ? 'Shell exited with code ' + match[1] + '\n' + stderr : 'Shell exited with code ' + match[1];
}

/** 构造单轮事件处理器，按 call ID 配对并发的工具事件。 */
export function chatToolStream(send: (output: ChatStreamOutput) => Promise<void>) {
  const modelCalls = new Set<string>();
  const running = new Map<string, { name: string; time: number }>();
  return async (event: SessionEvent<'assistant/message' | 'tool/call' | 'tool/result'>): Promise<void> => {
    if (event.type === 'assistant/message') {
      const calls = event.data.message.content.filter(block => block.type === 'tool-call');
      for (const call of calls) modelCalls.add(call.id);
      const type = calls.length > 0 ? 'reasoning' : 'content';
      // 工具可用时，等本步模型明确是否调用工具，再决定前置文本是否属于答案。
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text) await send({ type, text: block.text });
      }
      return;
    }
    if (event.type === 'tool/call') {
      const { callId, name, arguments: args } = event.data;
      if (!modelCalls.delete(callId)) return;
      running.set(callId, { name, time: event.time });
      await send({ type: 'tool_call', event: { type: 'tool_call_start', tool_call_id: callId,
        tool_name: name, arguments: previewArguments(args), timestamp: event.time / 1000 } });
      return;
    }
    const { message, error } = event.data;
    const start = running.get(message.toolCallId);
    if (!start) return;
    running.delete(message.toolCallId);
    const base = { tool_call_id: message.toolCallId, tool_name: start.name, timestamp: event.time / 1000 };
    const result = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const status = start.name === 'publish_event' ? eventToolStatus(result) : {};
    const failure = message.isError ? error?.reason || result || 'Tool execution failed'
      : start.name === 'shell' ? shellFailure(result) : status.failure;
    await send({ type: 'tool_call', event: failure
      ? { ...base, type: 'tool_call_error', error: failure.slice(0, 500) }
      : { ...base, type: 'tool_call_end', duration_ms: Math.max(0, event.time - start.time), result: result.slice(0, 500) } });
    if (!failure && status.approvalId) {
      await send({ type: 'event_approval', event: { event_id: status.approvalId } });
    }
  };
}

/** 封装一次性任务的 DSH 会话和子进程生命周期，将运行终态交回任务入口。 */
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client';
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { TaskConfig } from '../task/config.js';
import { openTaskModelBridge } from '../task/model-bridge.js';
import { writeTaskProfile } from './profile.js';
import { textDeltaRecord } from './plugins/chat-stream.js';

/** 可恢复的运行由调度器持有 home，并固定会话 ID。 */
export interface PersistentDshTurn {
  home: string;
  sessionId: string;
  resume: boolean;
  budgetMarker: string;
}

export class DshTurnError extends Error {
  constructor(readonly reason: string, code?: string) {
    super('DSH did not complete the task: ' + (code ? reason + ' (' + code + ')' : reason));
  }
}

/**
 * 在配置的工作区启动独立 DSH 子进程，完成或取消后清理临时配置。
 * @param runDirectory - 本轮文件产物目录，由调用方创建。
 * @returns 根会话成功结束时的最后一条助手文本。
 * @throws 任务取消、超出步数、启动失败或根会话没有成功结束。
 */
export async function runDshTask(
  config: TaskConfig,
  runDirectory: string,
  signal: AbortSignal,
  log: (message: string) => void,
  checkpoint?: PersistentDshTurn,
  onTaskEvent?: (event: SessionEvent) => Promise<void>,
): Promise<string> {
  const credentialFile = process.env.DIAGENT_TASK_MODEL_REFRESH_PATH;
  await using bridge = credentialFile ? await openTaskModelBridge(config.model, credentialFile, signal, Boolean(config.hostTools?.length)) : undefined;
  const execution = bridge ? { ...config, model: bridge.model } : config;
  const writesWorkspace = config.toolIds === undefined || config.toolIds.some(id => ['shell', 'write', 'edit'].includes(id))
    || config.subagents.some(role => role.toolIds.some(id => ['write', 'edit'].includes(id)));
  return await runDshTurn(execution, home => writeTaskProfile(execution, home, runDirectory, checkpoint?.budgetMarker), signal, log, {
    checkpoint,
    onTaskEvent,
    dshBin: bridge ? fileURLToPath(new URL('./task-child.js', import.meta.url)) : undefined,
    toolEnv: {
      DIOS_API: config.isDiosEventPublishingEnabled ? process.env.DIOS_API || 'http://backend:8000' : '',
      DIAGENT_EVENT_ACCESS_TOKEN: config.isDiosEventPublishingEnabled ? process.env.DIAGENT_EVENT_ACCESS_TOKEN : '',
      GIT_PLATFORM_TOKEN: config.toolIds === undefined || config.toolIds.includes('shell') ? process.env.GIT_PLATFORM_TOKEN : '',
    },
    permissionMode: writesWorkspace ? 'workspace-write' : 'read-only',
  });
}

/** 启动并收尾一次独立 DSH 会话，由调用入口提供本次运行的 profile。 */
export async function runDshTurn(
  config: Pick<TaskConfig, 'workspace' | 'model' | 'prompt' | 'stepLimit'>,
  writeProfile: (home: string) => Promise<string>,
  signal: AbortSignal,
  log: (message: string) => void,
  { toolEnv, permissionMode = 'read-only', onTextDelta, onToolStreamEvent, dshBin, checkpoint, onTaskEvent }: {
    toolEnv?: Pick<NodeJS.ProcessEnv, 'DIOS_API' | 'DIAGENT_EVENT_ACCESS_TOKEN' | 'GIT_PLATFORM_TOKEN'>;
    permissionMode?: 'workspace-write' | 'read-only';
    dshBin?: string;
    checkpoint?: PersistentDshTurn;
    onTaskEvent?: (event: SessionEvent) => Promise<void>;
    onTextDelta?: (text: string) => Promise<void>;
    onToolStreamEvent?: (event: SessionEvent<'assistant/message' | 'tool/call' | 'tool/result'>) => Promise<void>;
  } = {},
): Promise<string> {
  const home = checkpoint?.home ?? await mkdtemp(join(tmpdir(), 'diagent-dsh-'));
  if (checkpoint) await mkdir(home, { recursive: true });
  try {
    const patch = await writeProfile(home);
    signal.throwIfAborted();
    await using harness = new DeepSeekHarness({
      dshBin,
      dshHome: home,
      profile: 'sdk',
      patches: [patch],
      provider: 'diagent-model',
      model: config.model.name,
      cwd: config.workspace,
      processCwd: config.workspace,
      env: {
        ...process.env,
        DIAGENT_TASK_MODEL_REFRESH_PATH: '',
        // 空值也显式传递，阻止工作区 .env 注入未授予本轮工具的凭据。
        DIOS_API: toolEnv?.DIOS_API ?? '',
        DIAGENT_EVENT_ACCESS_TOKEN: toolEnv?.DIAGENT_EVENT_ACCESS_TOKEN ?? '',
        DIAGENT_MODEL_API_KEY: config.model.apiKey,
        GIT_PLATFORM_TOKEN: toolEnv?.GIT_PLATFORM_TOKEN ?? '',
        DSH_PERMISSION_MODE: permissionMode,
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_MAX_TOKENS_AS_SUCCESS: 'false',
      },
    });
    const stop = () => {
      void harness.close().catch(() => log('[dsh] shutdown_failed'));
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      await harness.start();
      signal.throwIfAborted();
      const sessionId = checkpoint?.sessionId ?? randomUUID();
      if (checkpoint?.resume) await harness.resumeSession(sessionId);
      const subscription = harness.client.subscribeSessionTree(sessionId);
      try {
        // 用协议层 prompt 保留原始任务文本，避免 SDK 把开头的 / 当成命令。
        const prompt = checkpoint?.resume
          ? '继续完成当前任务。沿用历史中已完成的工具结果和工作区文件。' : config.prompt;
        await harness.client.prompt(sessionId, [{ type: 'text', text: prompt }]);
        const idle = harness.client.request('session/wait', { sessionId });
        // wait 响应与最后一帧走不同的读取路径，等已入队的终态完成投递。
        const finished = idle.then(() => delay(1000, null));
        let steps = 0;
        let startedRootStep = false;
        let reply = '';
        let reason: string | undefined;
        let errorCode: string | undefined;
        while (true) {
          const notification = await Promise.race([subscription.next(), finished]);
          if (notification === null) break;
          if (notification.method !== 'session.event') continue;

          const event = validatedSessionEvent(notification.params.event);
          if (event.type === 'step/start') {
            steps += 1;
            if (!checkpoint && steps > config.stepLimit) throw new Error('Task exceeded its configured step limit');
          }
          log('[dsh] ' + event.type);
          if (notification.params.sessionId !== sessionId) continue;
          await onTaskEvent?.(event);
          if (event.type === 'step/start') startedRootStep = true;
          if (startedRootStep && onToolStreamEvent && (event.type === 'assistant/message'
            || event.type === 'tool/call' || event.type === 'tool/result')) {
            await onToolStreamEvent(event);
          }
          const streamed = onTextDelta && pluginRecordOf(event);
          if (streamed && streamed.type === textDeltaRecord) {
            if (typeof streamed.data !== 'string') throw new Error('Invalid DSH chat text delta');
            await onTextDelta(streamed.data);
          } else if (event.type === 'assistant/message' && startedRootStep) {
            const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
            reply = onTextDelta ? reply + text : text;
          } else if (event.type === 'turn/end') {
            reason = event.data.reason.kind;
            if (event.data.reason.kind === 'error') errorCode = event.data.reason.error.code;
            break;
          }
        }
        await idle;
        signal.throwIfAborted();
        if (reason !== 'completed') {
          throw new DshTurnError(reason ?? 'missing turn end', errorCode);
        }
        return reply;
      } finally {
        subscription.close();
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    if (!checkpoint) await rm(home, { recursive: true, force: true });
  }
}

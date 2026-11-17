/** 封装一次性任务的 DSH 会话和子进程生命周期，将运行终态交回任务入口。 */
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client';
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskConfig } from '../task/config.js';
import { openTaskModelBridge } from '../task/model-bridge.js';
import { writeTaskProfile } from './profile.js';
import { textDeltaRecord } from './plugins/chat-stream.js';

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
): Promise<string> {
  const credentialFile = process.env.DIAGENT_TASK_MODEL_REFRESH_PATH;
  await using bridge = credentialFile ? await openTaskModelBridge(config.model, credentialFile, signal) : undefined;
  const execution = bridge ? { ...config, model: bridge.model } : config;
  const writesWorkspace = config.toolIds === undefined || config.toolIds.some(id => ['shell', 'write', 'edit'].includes(id))
    || config.subagents.some(role => role.toolIds.some(id => ['write', 'edit'].includes(id)));
  return await runDshTurn(execution, home => writeTaskProfile(execution, home, runDirectory), signal, log, {
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
  { toolEnv, permissionMode = 'read-only', onTextDelta, onToolStreamEvent, dshBin }: {
    toolEnv?: Pick<NodeJS.ProcessEnv, 'DIOS_API' | 'DIAGENT_EVENT_ACCESS_TOKEN' | 'GIT_PLATFORM_TOKEN'>;
    permissionMode?: 'workspace-write' | 'read-only';
    dshBin?: string;
    onTextDelta?: (text: string) => Promise<void>;
    onToolStreamEvent?: (event: SessionEvent<'assistant/message' | 'tool/call' | 'tool/result'>) => Promise<void>;
  } = {},
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'diagent-dsh-'));
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
      const sessionId = randomUUID();
      const subscription = harness.client.subscribeSessionTree(sessionId);
      try {
        // 用协议层 prompt 保留原始任务文本，避免 SDK 把开头的 / 当成命令。
        await harness.client.prompt(sessionId, [{ type: 'text', text: config.prompt }]);
        const finished = harness.client.request('session/wait', { sessionId }).then(() => null);
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
            if (steps > config.stepLimit) throw new Error('Task exceeded its configured step limit');
          }
          log('[dsh] ' + event.type);
          if (notification.params.sessionId !== sessionId) continue;
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
          }
        }
        signal.throwIfAborted();
        if (reason !== 'completed') {
          const detail = errorCode ? reason + ' (' + errorCode + ')' : reason ?? 'missing turn end';
          throw new Error('DSH did not complete the task: ' + detail);
        }
        return reply;
      } finally {
        subscription.close();
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

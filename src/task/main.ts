/** 一次性任务命令入口。调度器通过结果文件和进程退出码回收执行状态。 */
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTaskConfig, TaskConfigError } from './config.js';
import { DshTurnError, runDshTask } from '../dsh/task-runtime.js';
import { TaskResultProtocol, writeFailureResult } from './result-protocol.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = await loadTaskConfig(process.env);
  // 一次性任务默认限时 30 分钟。Node.js 定时器的上限为有符号 32 位整数。
  const timeout = Number(process.env.DIAGENT_TASK_TIMEOUT_MS ?? 1_800_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new TaskConfigError('DIAGENT_TASK_TIMEOUT_MS must be a positive timer interval');
  }

  // 每次运行创建独立目录，同一输出根下的历史结果可以保留。
  await mkdir(config.outputDir, { recursive: true });
  const protocol = await TaskResultProtocol.open(process.env, config);
  const runDirectory = protocol?.runDirectory ?? await mkdtemp(join(config.outputDir, 'run-'));
  const logPath = join(runDirectory, config.logFile);
  const resultPath = join(runDirectory, config.resultFile);
  await writeFile(logPath, '[start] DSH task\n');
  console.log('[start] DSH task output: ' + runDirectory);

  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Task interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(timeout)]);
  const events: string[] = [];

  try {
    const result = await runDshTask(
      config, runDirectory, signal, message => events.push(message),
      protocol?.checkpoint, protocol && (event => protocol.observe(event)),
    );
    signal.throwIfAborted();
    await writeFile(resultPath, result, 'utf8');
    await appendFile(logPath, [...events, '[complete] Task completed', ''].join('\n'));
    await protocol?.finish('completed', config, result);
    console.log('[complete] ' + resultPath);
  } catch (error) {
    if (protocol && !signal.aborted && error instanceof DshTurnError && error.reason === 'error'
        && await protocol.pausedAt(config.stepLimit)) {
      await protocol.finish('paused', config);
      await appendFile(logPath, [...events, '[pause] Task reached its step limit', ''].join('\n'));
      return;
    }
    const detail = errorMessage(signal.aborted ? signal.reason : error);
    const message = detail.replaceAll(config.model.apiKey, '[redacted]');
    await appendFile(logPath, [...events, '[error] ' + message, ''].join('\n'));
    await writeFile(resultPath, '任务执行失败：' + message + '\n', 'utf8');
    const code = signal.aborted
      ? signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'interrupted'
      : detail === 'Task exceeded its configured step limit' ? 'step_limit' : 'engine_error';
    await protocol?.finish('failed', config, '', code);
    console.error('[error] ' + message);
    process.exitCode = error instanceof TaskConfigError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main().catch(async error => {
  const code = error instanceof TaskConfigError ? 'invalid_config' : 'engine_error';
  try {
    await writeFailureResult(process.env, code);
  } catch {
    // 协议目录不可写时不能掩盖原始启动错误。
  }
  console.error('[error] ' + errorMessage(error));
  process.exitCode = error instanceof TaskConfigError ? 2 : 1;
});

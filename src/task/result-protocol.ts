/** 一次性任务与调度器交换事件、终态及本地检查点的文件协议。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { PersistentDshTurn } from '../dsh/task-runtime.js';
import { TaskConfigError, type TaskConfig } from './config.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const toolCallId = /^[\w.:-]{1,128}$/;

type TaskStatus = 'completed' | 'failed' | 'paused';

/** 调度器为每段指定协议目录，检查点以同一目录中的 DSH home 为基础。 */
export class TaskResultProtocol {
  private seq = 0;
  private steps = 0;

  private constructor(
    private readonly directory: string,
    private readonly workspace: string,
    readonly runDirectory: string,
    readonly checkpoint?: PersistentDshTurn,
  ) {}

  static async open(env: NodeJS.ProcessEnv, config: TaskConfig): Promise<TaskResultProtocol | undefined> {
    const directory = env.DIAGENT_TASK_PROTOCOL_DIR;
    const resume = env.DIAGENT_TASK_RESUME_SESSION;
    const canPause = env.DIAGENT_TASK_PAUSE_ON_LIMIT === 'true';
    const localTools = new Set(['shell', 'read', 'write', 'edit', 'skill', 'office']);
    if (!directory && !resume && !canPause) return undefined;
    if (!directory || !isAbsolute(directory)) {
      throw new TaskConfigError('Task protocol directory must be an absolute path');
    }
    const output = relative(config.workspace, config.outputDir);
    if (!output || output === '..' || output.startsWith('..' + sep) || isAbsolute(output)) {
      throw new TaskConfigError('Task protocol output must be within its workspace');
    }
    if ((canPause && (!config.toolIds || config.toolIds.some(tool => !localTools.has(tool))
        || config.subagents.length || config.mcpConfigPath || config.isDiosEventPublishingEnabled))
        || (resume && (!canPause || !uuid.test(resume)))) {
      throw new TaskConfigError('Checkpointed tasks require local tools and a valid session');
    }
    const runDirectory = join(config.outputDir, 'run-task');
    const checkpoint = canPause ? {
      home: join(directory, 'dsh-home'),
      sessionId: resume || randomUUID(),
      resume: Boolean(resume),
      budgetMarker: join(directory, 'step-limit.json'),
    } : undefined;
    const protocol = new TaskResultProtocol(directory, config.workspace, runDirectory, checkpoint);
    await mkdir(directory, { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await rm(join(directory, 'result.json'), { force: true });
    await writeFile(join(directory, 'events.ndjson'), '');
    if (checkpoint) await rm(checkpoint.budgetMarker, { force: true });
    await protocol.writeEvent('started');
    return protocol;
  }

  private async writeEvent(type: string, detail: object = {}): Promise<void> {
    const event = { version: 1, seq: ++this.seq, type, at: Date.now(), ...detail };
    await appendFile(join(this.directory, 'events.ndjson'), JSON.stringify(event) + '\n');
  }

  async observe(event: SessionEvent): Promise<void> {
    if (event.type === 'step/start') {
      this.steps += 1;
      await this.writeEvent('step_started', { steps: this.steps });
    } else if (event.type === 'tool/call') {
      const tool = /^[\w-]{1,64}$/.test(event.data.name) ? event.data.name : 'unknown';
      let skill: string | undefined;
      if (tool === 'skill') {
        const name = /"name"\s*:\s*"(office-(?:docx|xlsx|pptx))"/.exec(event.data.arguments)?.[1];
        skill = name;
      }
      await this.writeEvent('tool_started', {
        tool, skill, call_id: toolCallId.test(event.data.callId) ? event.data.callId : undefined,
      });
    } else if (event.type === 'tool/result') {
      const id = event.data.message.toolCallId;
      await this.writeEvent('tool_finished', {
        success: !event.data.message.isError, call_id: toolCallId.test(id) ? id : undefined,
      });
    }
  }

  async pausedAt(limit: number): Promise<boolean> {
    if (!this.checkpoint) return false;
    try {
      const marker = await readFile(this.checkpoint.budgetMarker, 'utf8');
      return marker === String(limit + 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async finish(status: TaskStatus, config: TaskConfig, summary = '', error?: string): Promise<void> {
    const excluded = new Set([config.logFile, config.resultFile]);
    const rows = status === 'completed' ? await readdir(this.runDirectory, { withFileTypes: true }) : [];
    const artifacts = rows.filter(row => row.isFile() && !excluded.has(row.name))
      .map(row => relative(this.workspace, join(this.runDirectory, row.name)).split(sep).join('/'));
    const result = {
      version: 1, status, summary: summary.slice(0, 4096).toWellFormed(), error, artifacts,
      steps: status === 'paused' ? config.stepLimit : this.steps,
      ...(status === 'paused' && this.checkpoint ? { checkpoint_ref: this.checkpoint.sessionId } : {}),
    };
    const file = join(this.directory, 'result.json');
    await writeFile(file + '.tmp', JSON.stringify(result) + '\n');
    await rename(file + '.tmp', file);
    await this.writeEvent('finished', { status, error });
  }
}

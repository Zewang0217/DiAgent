/** 将任务描述与容器可写的工作区隔离，并用 Docker 状态恢复未完成任务。 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ContainerState, TaskDocker } from './docker.js';
import { isMissingPath, TaskApiError, type TaskInput } from './inputs.js';
import { loadTaskProfile } from './profiles.js';

export interface TaskRecord {
  id: string;
  profile: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  created_at: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
}

interface StoredJob {
  record: TaskRecord;
  cleanupPending?: boolean;
}

/** 判断容器是否已结束并允许读取产物。 */
export function isTerminal(job: TaskRecord): boolean {
  return job.status === 'completed' || job.status === 'failed';
}

/** 持久化任务并与 Docker 同步状态。同一个状态目录由单个控制器使用。 */
export class TaskJobs {
  readonly #busy = new Map<string, Promise<TaskRecord>>();
  readonly #root: string;
  readonly #profiles: string;

  constructor(root: string, profiles: string, private readonly docker: TaskDocker) {
    this.#root = resolve(root);
    this.#profiles = resolve(profiles);
  }

  /** 返回已验证任务 ID 对应的容器产物目录。 */
  output(id: string): string {
    return join(this.#root, id, 'workspace', 'output');
  }

  /** 写入私有工作区并启动容器，每次提交分配新 ID。 */
  async submit(input: TaskInput): Promise<TaskRecord> {
    const profile = join(this.#profiles, input.profile);
    const taskConfig = await loadTaskProfile(profile, input.prompt);
    const id = randomUUID();
    const dir = join(this.#root, id);
    const workspace = join(dir, 'workspace');
    const config = join(dir, 'task.json');
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    await mkdir(workspace);
    for (const [name, content] of Object.entries(input.files)) {
      await writeFile(join(workspace, name), content, { flag: 'wx' });
    }
    await writeFile(config, JSON.stringify(taskConfig), { mode: 0o600, flag: 'wx' });
    const record: TaskRecord = {
      id, profile: input.profile, status: 'starting', created_at: new Date().toISOString(),
    };
    await this.#save(record);
    try {
      await this.docker.start({ id, workspace, profile, config });
    } catch {
      // Docker 可能已创建容器。由 inspect 确定状态，并在 daemon 恢复后继续查询。
      return this.#observe(record, 'Docker did not start the task container');
    }
    return this.#save({ ...record, status: 'running' });
  }

  /** 按任务 ID 查询状态。并行查询共享一次状态刷新与容器回收。 */
  get(id: string): Promise<TaskRecord> {
    let pending = this.#busy.get(id);
    if (!pending) {
      pending = this.#refresh(id).finally(() => this.#busy.delete(id));
      this.#busy.set(id, pending);
    }
    return pending;
  }

  async #refresh(id: string): Promise<TaskRecord> {
    let stored: StoredJob;
    try {
      stored = JSON.parse(await readFile(join(this.#root, id, 'state.json'), 'utf8'));
    } catch (error) {
      if (isMissingPath(error)) throw new TaskApiError(404, 'Task not found');
      throw error;
    }
    if (!isTerminal(stored.record)) return this.#observe(stored.record, 'Task container is missing', true);
    if (stored.cleanupPending) await this.#cleanup(stored.record);
    return stored.record;
  }

  async #observe(record: TaskRecord, missingMessage: string, requireDocker = false): Promise<TaskRecord> {
    let state: ContainerState | undefined;
    try {
      state = await this.docker.inspect(record.id);
    } catch {
      if (!requireDocker) return record;
      throw new TaskApiError(503, 'Docker state is temporarily unavailable');
    }
    if (!state || ['exited', 'dead', 'created'].includes(state.status)) {
      const exitCode = state?.status === 'created' ? undefined : state?.exitCode;
      const error = !state ? missingMessage : state.status === 'created' ? 'Docker did not start the task container' : undefined;
      const result: TaskRecord = {
        ...record,
        status: state?.status === 'exited' && exitCode === 0 ? 'completed' : 'failed',
        finished_at: new Date().toISOString(),
        ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        ...(error ? { error } : {}),
      };
      await this.#save(result, !!state);
      if (state) await this.#cleanup(result);
      return result;
    }
    if (record.status === 'starting') {
      return this.#save({ ...record, status: 'running' });
    }
    return record;
  }

  async #cleanup(record: TaskRecord): Promise<void> {
    try {
      await this.docker.remove(record.id);
    } catch {
      // 已完成的记录和产物始终可读。下次轮询再清理已退出的容器。
      return;
    }
    await this.#save(record);
  }

  async #save(record: TaskRecord, cleanupPending = false): Promise<TaskRecord> {
    const dir = join(this.#root, record.id);
    const temp = join(dir, randomUUID() + '.tmp');
    await writeFile(temp, JSON.stringify({ record, cleanupPending }), { mode: 0o600, flag: 'wx' });
    await rename(temp, join(dir, 'state.json'));
    return record;
  }
}

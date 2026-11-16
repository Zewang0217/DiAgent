/** 在宿主机启动 DSH 一次性镜像，并通过固定容器名恢复查询。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface TaskLaunch {
  id: string;
  workspace: string;
  profile: string;
  config: string;
}

export interface ContainerState {
  status: string;
  exitCode?: number;
}

/** 宿主机按任务 ID 操作容器。查询无法连接 Docker 时抛异常，容器不存在时返回 undefined。 */
export interface TaskDocker {
  start(task: TaskLaunch): Promise<void>;
  inspect(id: string): Promise<ContainerState | undefined>;
  remove(id: string): Promise<void>;
}

const exec = promisify(execFile);

function containerName(id: string): string {
  return 'diagent-api-' + id;
}

function mount(source: string, target: string, readOnly = false): string {
  // Docker CLI 将 --mount 解析为 CSV。整个 source 字段必须作为一个 CSV 值转义。
  return ['type=bind', '"source=' + source.replaceAll('"', '""') + '"', 'target=' + target,
    ...(readOnly ? ['readonly'] : [])].join(',');
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await exec('docker', args, { timeout: 30_000, windowsHide: true });
  return stdout;
}

function isMissingContainer(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 1
    && 'stderr' in error && typeof error.stderr === 'string'
    && /^(?:Error(?: response from daemon)?: )?No such (?:container|object):/im.test(error.stderr);
}

/** 镜像和网络由部署方固定，调用方的数据不进入 Docker 选项。 */
export function createTaskDocker(image: string, network?: string): TaskDocker {
  if (!image || image.startsWith('-') || /\s/.test(image)) throw new Error('Invalid DIAGENT_TASK_IMAGE');
  return {
    async start(task) {
      await docker(['run', '--detach', '--pull=never', '--name', containerName(task.id),
        '--mount', mount(task.workspace, '/workspace'),
        '--mount', mount(task.profile, '/profile', true),
        '--mount', mount(task.config, '/run/diagent/task.json', true),
        '--env', 'TASK_CONFIG=/run/diagent/task.json',
        '--env', 'OUTPUT_DIR=/workspace/output',
        '--env', 'TRIGGER_MODE=once',
        '--env', 'DIAGENT_ENABLE_DIOS_EVENTS=false',
        ...(network ? ['--network', network] : []), image]);
    },
    async inspect(id) {
      try {
        const state = JSON.parse(await docker(['inspect', '--type', 'container', '--format', '{{json .State}}', containerName(id)]));
        return { status: state.Status, exitCode: state.ExitCode };
      } catch (error) {
        if (isMissingContainer(error)) return undefined;
        throw error;
      }
    },
    async remove(id) {
      try {
        await docker(['rm', containerName(id)]);
      } catch (error) {
        if (!isMissingContainer(error)) throw error;
      }
    },
  };
}

/** 校验外部任务输入与产物的相对路径。 */
/** 可作为 HTTP 响应公开的错误。消息只包含调用方可见的详情。 */
export class TaskApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 判断 JSON 值是否可按字段读取。 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 检查单个文件名在 Linux 和 Windows 的宿主机上能否安全拼接。 */
export function isPathSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..'
    && !/[\\/:*?"<>|\p{Cc}]/u.test(value) && !/[. ]$/.test(value)
    && !/^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
}

/** 将路径不存在与其他必须处理的文件系统错误区分开。 */
export function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export interface TaskInput {
  profile: string;
  prompt: string;
  files: Record<string, string>;
}

/** 提取提交参数。输入文件只写入工作区根目录，非法输入返回 HTTP 400。 */
export function parseTaskInput(data: unknown): TaskInput {
  if (!isObject(data) || Object.keys(data).some(key => !['profile', 'prompt', 'files'].includes(key))) {
    throw new TaskApiError(400, 'Expected profile, prompt and optional files');
  }
  const { profile, prompt, files = {} } = data;
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) || !isPathSegment(profile)) {
    throw new TaskApiError(400, 'Invalid profile name');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TaskApiError(400, 'Expected a non-empty prompt');
  if (!isObject(files)) throw new TaskApiError(400, 'Expected files to be an object');
  const names = new Set<string>();
  const entries: [string, string][] = [];
  for (const [name, content] of Object.entries(files)) {
    const folded = name.toLowerCase();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !isPathSegment(name)
      || folded === 'output' || names.has(folded) || typeof content !== 'string') {
      throw new TaskApiError(400, 'Expected uniquely named UTF-8 input files at the workspace root');
    }
    names.add(folded);
    entries.push([name, content]);
  }
  return { profile, prompt, files: Object.fromEntries(entries) };
}

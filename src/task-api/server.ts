/** 独立任务的宿主机 HTTP 入口。 */
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { findArtifact, listArtifacts } from './artifacts.js';
import { createTaskDocker, type TaskDocker } from './docker.js';
import { parseTaskInput, TaskApiError } from './inputs.js';
import { isTerminal, TaskJobs } from './jobs.js';

export interface TaskApiOptions {
  root: string;
  profiles: string;
  token: string;
}

const maxBodyBytes = 1024 * 1024;
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function reply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBodyBytes) {
      req.resume();
      throw new TaskApiError(413, 'Task submission exceeds 1 MiB');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new TaskApiError(400, 'Expected a UTF-8 JSON body');
  }
}

function decodeSegments(url: string): string[] {
  try {
    return url.split('?')[0].split('/').map(segment => decodeURIComponent(segment));
  } catch {
    throw new TaskApiError(400, 'Invalid URL path');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, jobs: TaskJobs, expected: Buffer): Promise<void> {
  const provided = Buffer.from(req.headers.authorization ?? '');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    throw new TaskApiError(401, 'A valid task API token is required');
  }

  const [root, version, tasks, id, resource, ...segments] = decodeSegments(req.url ?? '');
  if (root !== '' || version !== 'v1' || tasks !== 'tasks') throw new TaskApiError(404, 'Not Found');
  if (req.method === 'POST' && id === undefined) {
    const job = await jobs.submit(parseTaskInput(await readBody(req)));
    res.setHeader('Location', '/v1/tasks/' + job.id);
    return reply(res, 202, job);
  }
  if (req.method !== 'GET' || !id || !jobIdPattern.test(id) || (resource !== undefined && resource !== 'artifacts')) {
    throw new TaskApiError(404, 'Not Found');
  }
  const job = await jobs.get(id);
  if (resource === undefined) return reply(res, 200, job);
  if (!isTerminal(job)) throw new TaskApiError(409, 'Artifacts are available when the task finishes');

  const output = jobs.output(id);
  if (segments.length === 0) return reply(res, 200, { artifacts: await listArtifacts(output) });
  const artifact = await findArtifact(output, segments);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': artifact.size,
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(segments.at(-1)!)
      .replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16)),
    'Cache-Control': 'no-store',
  });
  await pipeline(createReadStream(artifact.path), res);
}

/** 创建未监听的服务，供宿主机入口和接口测试复用。 */
export function createTaskApi(options: TaskApiOptions, docker: TaskDocker): Server {
  if (!options.token || !/^[!-~]+$/.test(options.token)) throw new Error('Invalid DIAGENT_TASK_API_TOKEN');
  const expected = Buffer.from('Bearer ' + options.token);
  const jobs = new TaskJobs(options.root, options.profiles, docker);
  return createServer((req, res) => {
    void handle(req, res, jobs, expected).catch(error => {
      if (res.headersSent) return res.destroy();
      if (error instanceof TaskApiError) return reply(res, error.status, { detail: error.message });
      reply(res, 500, { detail: 'Task API failed to process the request' });
    });
  });
}

if (import.meta.main) {
  const env = process.env;
  const server = createTaskApi({
    root: env.DIAGENT_TASK_API_ROOT || 'diagent-jobs',
    profiles: env.DIAGENT_TASK_PROFILES_DIR || 'diagent-task-profiles',
    token: env.DIAGENT_TASK_API_TOKEN ?? '',
  }, createTaskDocker(env.DIAGENT_TASK_IMAGE ?? '', env.DIAGENT_TASK_DOCKER_NETWORK));
  const port = Number(env.DIAGENT_TASK_API_PORT ?? 8001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DIAGENT_TASK_API_PORT');
  server.listen(port, env.DIAGENT_TASK_API_HOST || '127.0.0.1');
}

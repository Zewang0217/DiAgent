/** 在独立 Linux UID 下代理任务推理，刷新凭据只由代理进程读取。 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, chown, copyFile, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import type { TaskConfig } from './config.js';

const brokerUid = 65534;
const textRequestLimit = 1024 * 1024;
// DSH 发送 Base64 图像时，需要为原始图片预算和消息结构预留空间。
const imageRequestLimit = 32 * textRequestLimit;
interface BridgeOptions {
  model: TaskConfig['model'];
  localKey: string;
  credentialFile: string;
  hostToolsEnabled: boolean;
}

class RefreshRejected extends Error {
  constructor(readonly status: number) { super('Task model authorization could not be refreshed'); }
}

/** 迁移一次性引导文件并启动代理。DSH 启动前，代理会清除该文件。 */
export async function openTaskModelBridge(model: TaskConfig['model'], source: string, signal: AbortSignal, hostToolsEnabled = false) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('Task model refresh requires the Linux task image');
  }
  if (hostToolsEnabled) {
    const endpoint = new URL(model.baseURL);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
      throw new Error('Host tools require the managed local task proxy');
    }
  }
  const directory = await mkdtemp('/tmp/diagent-model-');
  const credentialFile = join(directory, 'refresh.json');
  try {
    await copyFile(source, credentialFile);
    await chmod(credentialFile, 0o400);
    await chown(credentialFile, brokerUid, brokerUid);
    await chown(directory, brokerUid, brokerUid);
    await unlink(source);
    const localKey = randomUUID();
    const child = fork(fileURLToPath(import.meta.url), ['serve'], {
      uid: brokerUid, gid: brokerUid, env: {}, execArgv: ['--disable-sigusr1'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      const address = once(child, 'message', { signal: ready });
      child.send({ model, localKey, credentialFile, hostToolsEnabled } satisfies BridgeOptions);
      const [port] = await Promise.race([address, once(child, 'exit', { signal: ready }).then(() => [])]);
      if (typeof port !== 'number') throw new Error('Model bridge failed to start');
      await rm(directory, { recursive: true, force: true });
      return {
        model: { ...model, baseURL: `http://127.0.0.1:${port}/v1`, apiKey: localKey },
        async [Symbol.asyncDispose]() {
          child.kill();
        },
      };
    } catch (error) {
      child.kill();
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function serveBridge({ model, localKey, credentialFile, hostToolsEnabled }: BridgeOptions): Promise<void> {
  const { refresh_token: refreshToken } = JSON.parse(await readFile(credentialFile, 'utf8'));
  await unlink(credentialFile);
  if (typeof refreshToken !== 'string' || !/^[\w-]{43}$/.test(refreshToken)) throw new Error('Invalid refresh credential');
  const base = model.baseURL.replace(/\/+$/, '');
  const requestLimit = model.inputModalities?.includes('image') ? imageRequestLimit : textRequestLimit;
  let accessToken = model.apiKey;
  let refreshing: Promise<void> | undefined;

  async function refreshAccess(): Promise<void> {
    const response = await fetch(base + '/grants/refresh', {
      method: 'POST', headers: { Authorization: `Bearer ${refreshToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RefreshRejected(response.status);
    }
    const { access_token: token } = await response.json();
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw new Error('Invalid replacement credential');
    accessToken = token;
  }

  const server = createServer(async (request, response) => {
    const hostCall = hostToolsEnabled && request.url === '/tools/call';
    if (request.method !== 'POST' || (!hostCall && request.url !== '/v1/chat/completions') || request.headers.authorization !== `Bearer ${localKey}`) {
      response.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > (hostCall ? 256 * 1024 : requestLimit)) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const endpoint = hostCall ? new URL('/tools/call', base).href : base + '/chat/completions';
      const infer = (token: string) => fetch(endpoint, {
        method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        redirect: 'error', signal: controller.signal,
      });
      const sent = accessToken;
      let upstream = await infer(sent);
      // DiOS 的 401 出现在转发前。只重发这一次推理，流式响应和工具不会被重放。
      if (!hostCall && upstream.status === 401) {
        await upstream.body?.cancel();
        if (sent === accessToken) {
          refreshing ??= refreshAccess().finally(() => { refreshing = undefined; });
          await refreshing;
        }
        upstream = await infer(accessToken);
      }
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      // Node 的 fetch 与 stream/web 使用同一种流，两个声明的 read() 结果类型不同。
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream), response);
      else response.end();
    } catch (error) {
      if (response.headersSent) response.destroy();
      else response.writeHead(error instanceof RefreshRejected && [401, 429].includes(error.status) ? error.status : 502).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address && typeof address === 'object') process.send?.(address.port);
  process.once('disconnect', () => {
    server.close();
    server.closeAllConnections();
  });
}

if (process.argv[2] === 'serve') {
  process.once('message', (options: BridgeOptions) => {
    void serveBridge(options).catch(() => process.exit(1));
  });
}

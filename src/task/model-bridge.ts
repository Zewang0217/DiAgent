/** 在独立 Linux UID 下代理任务推理，刷新凭据只由代理进程读取。 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, chown, copyFile, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
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

/** 宿主提供的受管模型入口；socket 与 refresh 至少设置一个。 */
export interface TaskModelBridgeOptions {
  socketPath?: string;
  refreshFile?: string;
}

interface BridgeOptions {
  model: TaskConfig['model'];
  localKey: string;
  credentialFile?: string;
  hostToolsEnabled: boolean;
}

class RefreshRejected extends Error {
  constructor(readonly status: number) { super('Task model authorization could not be refreshed'); }
}

/** 把宿主 Unix socket 暴露为 broker 子进程可访问的本地 HTTP 端口。 */
function socketRelay(socketPath: string, sockets: Set<Socket>) {
  return createNetServer(client => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    const upstream = createConnection(socketPath);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
}

/**
 * 迁移一次性引导文件并启动代理。DSH 启动前，代理会清除该文件。
 * Unix socket 由父进程以 root 转发到 broker 子进程的本地端口，保持子进程 UID 不变。
 */
export async function openTaskModelBridge(
  model: TaskConfig['model'],
  source: TaskModelBridgeOptions | string,
  signal: AbortSignal,
  hostToolsEnabled = false,
) {
  const options = typeof source === 'string' ? { refreshFile: source } : source;
  const socketPath = options.socketPath;
  const refreshFile = options.refreshFile;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('Task model bridge requires the Linux task image');
  }
  if (!socketPath && !refreshFile) {
    throw new Error('Task model bridge requires a Unix socket or a refresh file');
  }
  if (hostToolsEnabled && !socketPath) {
    const endpoint = new URL(model.baseURL);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
      throw new Error('Host tools require the managed local task proxy');
    }
  }

  let directory: string | undefined;
  let credentialFile: string | undefined;
  let relay: NetServer | undefined;
  const sockets = new Set<Socket>();
  let child: ChildProcess | undefined;
  try {
    if (refreshFile) {
      directory = await mkdtemp('/tmp/diagent-model-');
      credentialFile = join(directory, 'refresh.json');
      await copyFile(refreshFile, credentialFile);
      await chmod(credentialFile, 0o400);
      await chown(credentialFile, brokerUid, brokerUid);
      await chown(directory, brokerUid, brokerUid);
      await unlink(refreshFile);
    }

    let upstreamBaseURL = model.baseURL;
    if (socketPath) {
      relay = socketRelay(socketPath, sockets);
      relay.listen(0, '127.0.0.1');
      await once(relay, 'listening');
      const address = relay.address();
      if (!address || typeof address !== 'object') throw new Error('Model socket relay failed to start');
      // broker 仍按 OpenAI 兼容路径拼接 /chat/completions，宿主 socket 提供 /v1 与 /tools。
      upstreamBaseURL = `http://127.0.0.1:${address.port}/v1`;
    }

    const localKey = randomUUID();
    child = fork(fileURLToPath(import.meta.url), ['serve'], {
      uid: brokerUid, gid: brokerUid, env: {}, execArgv: ['--disable-sigusr1'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const address = once(child, 'message', { signal: ready });
    child.send({
      model: { ...model, baseURL: upstreamBaseURL }, localKey, credentialFile, hostToolsEnabled,
    } satisfies BridgeOptions);
    const [port] = await Promise.race([address, once(child, 'exit', { signal: ready }).then(() => [])]);
    if (typeof port !== 'number') throw new Error('Model bridge failed to start');
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
    return {
      model: { ...model, baseURL: `http://127.0.0.1:${port}/v1`, apiKey: localKey },
      async [Symbol.asyncDispose]() {
        child?.kill();
        relay?.close();
        for (const socket of sockets) socket.destroy();
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    child?.kill();
    relay?.close();
    for (const socket of sockets) socket.destroy();
    throw error;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function serveBridge({ model, localKey, credentialFile, hostToolsEnabled }: BridgeOptions): Promise<void> {
  const refreshToken = credentialFile
    ? JSON.parse(await readFile(credentialFile, 'utf8')).refresh_token
    : undefined;
  if (credentialFile) await unlink(credentialFile);
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || !/^[\w-]{43}$/.test(refreshToken))) {
    throw new Error('Invalid refresh credential');
  }
  const base = model.baseURL.replace(/\/+$/, '');
  const requestLimit = model.inputModalities?.includes('image') ? imageRequestLimit : textRequestLimit;
  let accessToken = model.apiKey;
  let refreshing: Promise<void> | undefined;

  async function refreshAccess(): Promise<void> {
    if (!refreshToken) throw new RefreshRejected(401);
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

  const server = createHttpServer(async (request, response) => {
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
      if (!hostCall && upstream.status === 401 && refreshToken) {
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

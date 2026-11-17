/** 常驻 DiAgent 的 HTTP 入口，保留 DiOS 的健康检查契约。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ChatRequestError, completeChat, type ChatCompletionIdentity, type ChatModelGrant } from './chat.js';
import { legacyEventChat } from './legacy-event.js';
import { LegacySessions, legacySessionId, withSessionHistory } from './legacy-sessions.js';
import { discoverLegacyTools, standaloneMcpConnections } from './legacy-tools.js';
import type { ChatHistoryMessage } from '../dsh/plugins/chat-history.js';

function sendJson(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function requestGrant(request: IncomingMessage): ChatModelGrant {
  const grant = request.headers['x-diagent-model-grant'];
  const contextLength = request.headers['x-diagent-model-context-length'];
  return { token: typeof grant === 'string' ? grant : undefined,
    contextLength: typeof contextLength === 'string' ? contextLength : undefined };
}

function startChatStream(response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
}

function chatChunk(identity: ChatCompletionIdentity, delta: object, finishReason: 'stop' | null): string {
  const { id, created, model } = identity;
  return 'data: ' + JSON.stringify({ id, created, model, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }) + '\n\n';
}

/** 读入有大小限制的 JSON。执行期间断开连接或超时会取消 DSH。 */
async function handleChat(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, sessions: LegacySessions): Promise<void> {
  const disconnected = new AbortController();
  response.once('close', () => disconnected.abort());
  let signal = disconnected.signal;
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 1_048_576) {
        request.resume();
        response.setHeader('Connection', 'close');
        sendJson(response, 413, { detail: 'Chat request is too large' });
        return;
      }
      chunks.push(chunk);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(response, 400, { detail: 'Invalid JSON' });
      return;
    }
    const [path, query] = (request.url ?? '').split('?', 2);
    const event = path === '/v1/events' ? legacyEventChat(input) : undefined;
    if (event) input = { messages: event.messages, model: new URLSearchParams(query).get('model') ?? undefined };
    signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(290_000)]);
    const isStreaming = typeof input === 'object' && input !== null && 'stream' in input && input.stream === true;
    const modelGrant = requestGrant(request);
    const sessionId = legacySessionId(input);
    if (sessionId && env.DIAGENT_MODEL_PROXY_URL) {
      throw new ChatRequestError('Use DiOS to manage sessions for proxied Chat', 403);
    }
    let sentRole = false;
    const run = async (chatInput: unknown) => completeChat(chatInput, env, signal, modelGrant, isStreaming ? async (identity, output) => {
      signal.throwIfAborted();
      if (!response.headersSent) startChatStream(response);
      let frame;
      if ('event' in output) {
        frame = 'event: ' + output.type + '\ndata: ' + JSON.stringify(output.event) + '\n\n';
      } else {
        const delta = output.type === 'reasoning' ? { reasoning_content: output.text } : { content: output.text };
        frame = chatChunk(identity, sentRole ? delta : { role: 'assistant', ...delta }, null);
        sentRole = true;
      }
      if (!response.write(frame)) await once(response, 'drain', { signal });
    } : undefined);
    const result = sessionId ? await sessions.serialize(sessionId, async () => {
      signal.throwIfAborted();
      const history = sessions.get(sessionId);
      const chatInput = input as { messages?: ChatHistoryMessage[] };
      const completion = await run(withSessionHistory(chatInput, history));
      signal.throwIfAborted();
      const user = chatInput.messages?.at(-1);
      const assistant = completion.choices[0].message;
      if (user) sessions.append(sessionId, history, assistant.content
        ? [{ role: 'user', content: user.content }, assistant] : [{ role: 'user', content: user.content }]);
      return completion;
    }) : await run(input);
    if (response.destroyed) return;
    if (isStreaming) {
      if (!response.headersSent) startChatStream(response);
      response.end(chatChunk(result, {}, 'stop') + 'data: [DONE]\n\n');
    } else if (event) {
      sendJson(response, 200, { status: 'processed', event_id: event.id, response: result.choices[0].message.content });
    } else {
      sendJson(response, 200, result);
    }
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) {
      const detail = signal.aborted ? 'Chat execution timed out' : 'DSH chat execution failed';
      response.end('data: ' + JSON.stringify({ error: detail }) + '\n\n');
    } else if (error instanceof ChatRequestError) {
      sendJson(response, error.status, { detail: error.message });
    } else if (signal.aborted) {
      sendJson(response, 504, { detail: 'Chat execution timed out' });
    } else {
      sendJson(response, 502, { detail: 'DSH chat execution failed' });
    }
  }
}

async function handleTools(response: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.DIAGENT_MODEL_PROXY_URL) {
    sendJson(response, 403, { detail: 'Use the DiOS MCP catalog for managed tooling' });
    return;
  }
  const disconnected = new AbortController();
  response.once('close', () => disconnected.abort());
  try {
    const connections = await standaloneMcpConnections(env, disconnected.signal);
    const tools = (await discoverLegacyTools(connections, disconnected.signal)).map(entry => entry.tool);
    if (!response.destroyed) {
      response.setHeader('Cache-Control', 'no-store');
      sendJson(response, 200, { tools, total: tools.length });
    }
  } catch {
    if (response.destroyed) return;
    sendJson(response, 502, { detail: 'MCP tool discovery failed' });
  }
}

async function handleSessions(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, sessions: LegacySessions): Promise<void> {
  if (env.DIAGENT_MODEL_PROXY_URL) {
    sendJson(response, 403, { detail: 'Use DiOS to manage sessions for proxied Chat' });
    return;
  }
  const path = (request.url ?? '').split('?', 1)[0];
  if (path === '/v1/sessions' && request.method === 'GET') {
    sendJson(response, 200, { sessions: sessions.list() });
    return;
  }
  const segment = /^\/v1\/sessions\/([^/]+)$/.exec(path)?.[1];
  if (!segment || (request.method !== 'GET' && request.method !== 'DELETE')) {
    sendJson(response, 404, { detail: 'Not Found' });
    return;
  }
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    sendJson(response, 400, { detail: 'Invalid session ID encoding' });
    return;
  }
  if (request.method === 'DELETE') {
    const deleted = await sessions.serialize(id, async () => sessions.delete(id));
    if (deleted) {
      sendJson(response, 200, { status: 'deleted', session_id: id });
      return;
    }
  } else {
    const messages = sessions.get(id);
    if (messages.length) {
      sendJson(response, 200, { session_id: id, messages });
      return;
    }
  }
  sendJson(response, 404, { detail: 'Session not found' });
}

/** 创建尚未监听的 HTTP 服务，部署入口负责选择绑定地址。 */
export function createServiceServer(env: NodeJS.ProcessEnv = process.env): Server {
  const sessions = new LegacySessions(env);
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"healthy"}');
      return;
    }
    if (request.method === 'POST' && (request.url === '/v1/chat/completions' || request.url?.split('?')[0] === '/v1/events')) {
      void handleChat(request, response, env, sessions);
      return;
    }
    if (request.method === 'GET' && request.url?.split('?')[0] === '/v1/tools') {
      void handleTools(response, env);
      return;
    }
    if (/^\/v1\/sessions(?:[/?]|$)/.test(request.url ?? '')) {
      void handleSessions(request, response, env, sessions);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"detail":"Not Found"}');
  });
}

if (import.meta.main) {
  createServiceServer().listen(8000, '0.0.0.0');
}

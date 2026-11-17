/** 将调用方提供的 Chat 历史和工具选择映射到独立 DSH 会话。 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { mcpProfileRows, writeChatProfile } from '../dsh/profile.js';
import type { ChatHistoryMessage } from '../dsh/plugins/chat-history.js';
import { runDshTurn } from '../dsh/task-runtime.js';
import { parseModelConfig, TaskConfigError, type TaskConfig } from '../task/config.js';
import { chatToolStream, type ChatStreamOutput } from './chat-tool-events.js';

/** 表示调用方输入不符合当前在线接口契约。 */
export class ChatRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** 一次 Chat 响应的标识，流式分片和完成帧共用同一组值。 */
export interface ChatCompletionIdentity {
  id: string;
  created: number;
  model: string;
}

/** 推理地址由部署配置，单轮凭据和上下文上限由调度方下发。 */
export interface ChatModelGrant {
  token: string | undefined;
  contextLength: string | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function containsModelCredential(models: Record<string, unknown>): boolean {
  return Object.values(models).some(entry => Boolean(record(entry).api_key));
}

async function legacyCatalogContainsModelCredential(path: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (record(error).code === 'ENOENT') return false;
    throw error;
  }
  return containsModelCredential(record(record(parse(source)).models));
}

function parseToolSelection(value: unknown, env: NodeJS.ProcessEnv): string[] {
  if (value == null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatRequestError('tool_selection must be an object');
  }
  const { tool_ids: toolIds = [], tool_config: toolConfig } = record(value);
  if (!Array.isArray(toolIds)) throw new ChatRequestError('tool_selection.tool_ids must be an array');
  if (toolConfig != null) throw new ChatRequestError('tool_selection.tool_config is not supported');
  const selected = new Set<string>();
  for (const toolId of toolIds) {
    if (toolId !== 'shell' && toolId !== 'publish_event' && toolId !== 'skill'
      && !(toolId === 'mcp' && env.DIAGENT_MODEL_PROXY_URL)) {
      throw new ChatRequestError('Unsupported Chat tool ID');
    }
    if (toolId === 'shell' && process.platform !== 'linux') throw new ChatRequestError('shell requires the Linux service image');
    if (toolId === 'publish_event' && env.DIAGENT_ENABLE_DIOS_EVENTS === 'false') {
      throw new ChatRequestError('publish_event is disabled by deployment');
    }
    if (toolId === 'publish_event' && env.DIAGENT_ENABLE_DIOS_EVENTS != null && env.DIAGENT_ENABLE_DIOS_EVENTS !== 'true') {
      throw new Error('DIAGENT_ENABLE_DIOS_EVENTS must be true or false');
    }
    selected.add(toolId);
  }
  return [...selected];
}

function configuredSkillNames(env: NodeJS.ProcessEnv): string[] {
  const names: unknown = JSON.parse(env.DIAGENT_SKILL_NAMES || '[]');
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))) {
    throw new Error('DIAGENT_SKILL_NAMES must be an array of installed Skill names');
  }
  if (!names.length) throw new ChatRequestError('skill requires assigned Skills in the deployment');
  return [...new Set<string>(names)];
}

function parseMessages(value: unknown): { system: string[]; history: ChatHistoryMessage[]; prompt: string } {
  const messages = (Array.isArray(value) ? value : []).map(item => {
    const { role, content, tool_calls: toolCalls, tool_call_id: toolCallId, function_call: functionCall } = record(item);
    if (typeof content !== 'string' || toolCallId != null || functionCall != null
      || (toolCalls != null && (!Array.isArray(toolCalls) || toolCalls.length > 0))) {
      throw new ChatRequestError('Chat messages must contain text without tool calls');
    }
    return { role, content };
  });
  const current = messages.pop();
  if (current?.role !== 'user' || !current.content.trim()) {
    throw new ChatRequestError('Expected a final user text message');
  }
  const system: string[] = [];
  const history: ChatHistoryMessage[] = [];
  for (const { role, content } of messages) {
    if (role === 'system' && history.length === 0) {
      system.push(content);
    } else if (role === 'user' || role === 'assistant') {
      history.push({ role, content });
    } else {
      throw new ChatRequestError('Expected leading system messages followed by user or assistant text');
    }
  }
  return { system, history, prompt: current.content };
}

async function resolveChatModel(
  requestedModel: string | undefined, env: NodeJS.ProcessEnv, workspace: string, hasShell: boolean,
  grant: ChatModelGrant, signal: AbortSignal,
): Promise<{ model: TaskConfig['model']; mcpPlugins: ReturnType<typeof mcpProfileRows> }> {
  const legacyCatalogPath = join(workspace, 'models.yaml');
  const fallbackApiKey = env.LLM_OPENAI_API_KEY || env.OPENAI_API_KEY;
  // Linux 回退策略只限制写入。保留本地密钥时，不能开启 Shell。
  const hasLocalCredential = fallbackApiKey || process.env.LLM_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const credentialError = 'shell is unavailable with locally configured model API credentials';
  const proxyURL = env.DIAGENT_MODEL_PROXY_URL;
  if (proxyURL) {
    if (env.LLM_MODELS_CONFIG_PATH) throw new Error('Model proxy and local model catalog cannot be configured together');
    if (hasShell && (hasLocalCredential || await legacyCatalogContainsModelCredential(legacyCatalogPath))) {
      throw new ChatRequestError(credentialError);
    }
    if (!grant.token || !/^[A-Za-z0-9._~+/-]{1,2048}={0,2}$/.test(grant.token)) {
      throw new ChatRequestError('A per-turn model proxy grant is required');
    }
    const name = requestedModel || env.LLM_DEFAULT_MODEL;
    if (!name) throw new ChatRequestError('A model is required for proxied Chat');
    const contextWindow = grant.contextLength === undefined ? undefined : Number(grant.contextLength);
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
      throw new ChatRequestError('Invalid model context length');
    }
    const url = new URL(proxyURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid deployment model proxy URL');
    }
    const agentId = env.DIAGENT_MODEL_PROXY_AGENT_ID;
    if (!agentId) throw new Error('Model proxy requires a deployment Agent ID');
    // 必须在模型或工具运行前核对授权归属。请求体无法更改容器自己的 Agent ID。
    const verification = await fetch(proxyURL.replace(/\/+$/, '') + '/grants/check', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + grant.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, model: name }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      redirect: 'error',
    });
    if (verification.status === 401 || verification.status === 403 || verification.status === 429) {
      await verification.body?.cancel();
      throw new ChatRequestError('Model proxy grant is invalid for this Agent or exhausted', verification.status);
    }
    const model = { name, baseURL: proxyURL, apiKey: grant.token, contextWindow };
    if (verification.status === 204) return { model, mcpPlugins: [] };
    if (verification.status === 200) {
      const response = await verification.json();
      return { model, mcpPlugins: managedMcpPlugins(url, record(response).mcp_servers) };
    }
    await verification.body?.cancel();
    throw new Error('Model proxy grant verification failed');
  }

  const catalogPath = resolve(env.LLM_MODELS_CONFIG_PATH || legacyCatalogPath);
  const catalog = record(parse(await readFile(catalogPath, 'utf8')));
  const models = record(catalog.models);
  if (hasShell && (hasLocalCredential || containsModelCredential(models)
    || (catalogPath !== legacyCatalogPath && await legacyCatalogContainsModelCredential(legacyCatalogPath)))) {
    throw new ChatRequestError(credentialError);
  }
  const keys = Object.keys(models);
  const defaultModel = typeof catalog.default_model === 'string' ? catalog.default_model : undefined;
  const modelKey = requestedModel || env.LLM_DEFAULT_MODEL || defaultModel || (keys.length === 1 ? keys[0] : '');
  if (!modelKey || !Object.hasOwn(models, modelKey)) {
    throw new ChatRequestError('Select a model from the configured model catalog');
  }
  try {
    return { model: parseModelConfig(models, modelKey, fallbackApiKey), mcpPlugins: [] };
  } catch (error) {
    if (error instanceof TaskConfigError) throw new Error('Invalid configured model', { cause: error });
    throw error;
  }
}

function managedMcpPlugins(proxyUrl: URL, claims: unknown): ReturnType<typeof mcpProfileRows> {
  const prefix = proxyUrl.pathname.match(/^(.*)\/api\/internal\/model-proxy\/v1\/?$/)?.[1];
  if (prefix === undefined || claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('Invalid managed MCP configuration');
  }
  const servers = Object.fromEntries(Object.entries(claims).map(([name, value]) => {
    const { grant_id: grantId, token } = record(value);
    if (typeof grantId !== 'string' || !/^[0-9a-f]{32}$/.test(grantId)
      || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error('Invalid managed MCP grant');
    }
    // 代理凭据只能交给当前部署的 DiOS 网关，授权响应只带标识。
    const endpoint = new URL(proxyUrl);
    endpoint.pathname = prefix + '/api/internal/e2ag/mcp/' + grantId;
    return [name, { transport: 'streamable_http', url: endpoint.href,
      headers: { Authorization: 'Bearer ' + token } }];
  }));
  return mcpProfileRows(servers);
}

/** 使用本次请求提供的历史执行一轮问答，并返回 DiOS 可读取的 completion。 */
export async function completeChat(
  input: unknown, env: NodeJS.ProcessEnv, signal: AbortSignal,
  grant: ChatModelGrant,
  onStream?: (identity: ChatCompletionIdentity, output: ChatStreamOutput) => Promise<void>,
): Promise<ChatCompletionIdentity & {object: string; choices: object[]}> {
  const request = record(input);
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw new ChatRequestError('stream must be a boolean');
  }
  const { system, history, prompt } = parseMessages(request.messages);
  const toolIds = parseToolSelection(request.tool_selection, env);
  const hasShell = toolIds.includes('shell');
  const hasEventTool = toolIds.includes('publish_event');
  const skillNames = toolIds.includes('skill') ? configuredSkillNames(env) : [];
  for (const field of ['session_id', 'tools', 'custom_fields', 'max_tokens', 'top_p', 'stop']) {
    if (request[field] != null) throw new ChatRequestError(field + ' is not supported by this Chat entry yet');
  }
  if (request.model != null && typeof request.model !== 'string') {
    throw new ChatRequestError('model must be a string');
  }
  const temperature = request.temperature ?? 0.7;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new ChatRequestError('temperature must be a number between 0 and 2');
  }
  const workspace = resolve(env.AGENT_WORKSPACE || 'workspace');
  const requestedModel = typeof request.model === 'string' ? request.model : undefined;
  const { model, mcpPlugins: grantedMcpPlugins } = await resolveChatModel(requestedModel, env, workspace, hasShell, grant, signal);
  const mcpPlugins = toolIds.includes('mcp') ? grantedMcpPlugins : [];
  const builtInTools = toolIds.filter(id => id !== 'mcp');

  const identity = { id: 'chatcmpl-' + randomUUID(), created: Math.floor(Date.now() / 1000), model: model.name };
  const sendStream = request.stream === true && onStream;
  const hasTools = builtInTools.length > 0 || mcpPlugins.length > 0;
  const sendDelta = !hasTools && sendStream;
  const personaPrefix = system.length > 0 ? system.join('\n') : env.AGENT_SYSTEM_PROMPT || '你是用户的助理。';
  let streamedText = '';
  const writeProfile = (home: string) => writeChatProfile({
    model, personaPrefix, temperature, skillNames, mcpPlugins, history,
    skillsDir: resolve(workspace, env.SKILLS_DIR || 'skills'),
    toolIds: builtInTools, streamText: Boolean(sendDelta),
  }, home);
  const content = await runDshTurn({ workspace, prompt, model, stepLimit: 100 }, writeProfile, signal, () => {}, {
    toolEnv: {
      DIOS_API: hasEventTool ? env.DIOS_API : '',
      DIAGENT_EVENT_ACCESS_TOKEN: hasEventTool ? env.DIAGENT_EVENT_ACCESS_TOKEN : '',
      GIT_PLATFORM_TOKEN: hasShell ? env.GIT_PLATFORM_TOKEN : '',
    },
    permissionMode: hasShell ? 'workspace-write' : 'read-only',
    onTextDelta: sendDelta ? async text => {
      streamedText += text;
      await sendDelta(identity, { type: 'content', text });
    } : undefined,
    onToolStreamEvent: sendStream && hasTools
      ? chatToolStream(output => sendStream(identity, output)) : undefined,
  });
  if (sendDelta) {
    if (!content.startsWith(streamedText)) throw new Error('DSH Chat stream differs from its final text');
    const remaining = content.slice(streamedText.length);
    if (remaining) await sendDelta(identity, { type: 'content', text: remaining });
  }
  return {
    ...identity, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

/** 为 Task 和 Chat 生成私有的 DSH profile，按入口保留既有能力规则。 */
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStreamableHttpTransport, TaskConfigError, taskFileTools, type TaskConfig } from '../task/config.js';
import type { ChatHistoryMessage } from './plugins/chat-history.js';

const sharedDisabled = [
  'session-log-deepseek', 'session-telemetry-otel', 'plugin-package-inventory-deepseek',
];
const taskDisabled = [
  'tool-web', 'tool-plugin-manager', 'tool-schedule', 'tool-ask-user', 'tool-goal',
  'tool-office', 'skill-office', 'agent-instructions',
];
const taskSubagentDisabled = ['tool-subagent', 'tool-subagent-fork', 'tool-agent-team'];

interface ProfileSettings {
  model: TaskConfig['model'];
  personaPrefix: string;
  skillRoots: readonly string[];
  hasShell: boolean;
  hasNamedSubagents?: boolean;
  hasSubagentMcp?: boolean;
}

interface ChatProfileConfig {
  model: TaskConfig['model'];
  personaPrefix: string;
  temperature: number;
  skillsDir: string;
  skillNames: string[];
  toolIds: string[];
  mcpPlugins: ReturnType<typeof mcpProfileRows>;
  mcpToolIds?: string[];
  history: ChatHistoryMessage[];
  streamText: boolean;
  stepLimit: number;
  maxToolRounds?: number;
}

function localPlugin(name: string, config?: object): object {
  return {
    id: 'diagent-' + name,
    name: fileURLToPath(new URL('./plugins/' + name + '.js', import.meta.url)),
    ...(config === undefined ? {} : { config }),
  };
}

async function writeProfile(
  home: string, entry: 'task' | 'chat', settings: ProfileSettings, plugins: readonly object[],
): Promise<string> {
  const { model, personaPrefix, skillRoots, hasShell } = settings;
  const modelRow = modelProfileRow(model);
  const sharedRows = [
    { id: 'system-prompt', config: { personaPrefix } },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: skillRoots, watch: false } },
    ...(hasShell ? [
      { id: 'bash-sandbox', config: { maxTimeoutMs: 1_800_000 } },
      // 旧 shell 超时必须终止命令，底层 Bash 工具不能转入后台。
      { id: 'tool-bash', config: { promoteOnTimeout: false } },
    ] : []),
  ];
  const disabled = (entry === 'task'
    ? [...sharedDisabled, ...taskDisabled, ...(settings.hasNamedSubagents ? taskSubagentDisabled : []),
      ...(settings.hasSubagentMcp ? ['mcp-resources'] : [])]
    : sharedDisabled)
    .map(id => ({ id, disabled: true }));
  const rows = entry === 'task' ? [...disabled, ...sharedRows, modelRow] : [modelRow, ...sharedRows, ...disabled];
  const file = join(home, entry + '.cordis.yml');
  // JSON 是 YAML 的子集，序列化可保留路径、提示词等字段里的换行和引号。
  await writeFile(file, JSON.stringify([...rows, { insert: plugins }]), { mode: 0o600 });
  return file;
}

/** 使用本次运行选中的模型配置生成 DSH 的 OpenAI 兼容路由。 */
export function modelProfileRow(model: TaskConfig['model']): object {
  return { id: 'llm-pi-ai', config: { providers: { 'diagent-model': {
    apiKeyEnv: 'DIAGENT_MODEL_API_KEY',
    api: 'openai-completions',
    baseURL: model.baseURL,
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: [{ id: model.name, contextWindow: model.contextWindow }],
  } } } };
}

/** 建立本轮私有的 Skill 视图，DSH 只发现显式指定的目录。 */
export async function selectedSkillRoots(
  skillsDir: string, skillNames: string[], home: string, viewName = 'selected-skills',
): Promise<string[]> {
  if (skillNames.length === 0) return [];
  const selectedRoot = join(home, viewName);
  await mkdir(selectedRoot);
  for (const name of skillNames) {
    const directory = join(skillsDir, name);
    try {
      if (!(await stat(join(directory, 'SKILL.md'))).isFile()) throw new Error('Not a file');
    } catch {
      throw new TaskConfigError('Selected skill has no readable SKILL.md: ' + name);
    }
    await symlink(directory, join(selectedRoot, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return [selectedRoot];
}

async function mcpRows(path: string | undefined) {
  if (!path) return [];
  let servers: unknown;
  try {
    servers = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new TaskConfigError('Cannot read or parse MCP config: ' + path);
  }
  return mcpProfileRows(servers);
}

/** 将已授权的 Streamable HTTP 连接转换成 DSH 插件配置。 */
export function mcpProfileRows(servers: unknown) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new TaskConfigError('MCP config must be a server map');
  }
  return Object.entries(servers).map(([name, server]) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || !server || typeof server !== 'object'
      || Array.isArray(server) || !isStreamableHttpTransport(server.transport)
      || typeof server.url !== 'string' || !URL.canParse(server.url)
      || !['http:', 'https:'].includes(new URL(server.url).protocol)) {
      throw new TaskConfigError('Unsupported MCP configuration for server ' + name + '; expected Streamable HTTP');
    }
    if (server.headers != null && (typeof server.headers !== 'object' || Array.isArray(server.headers)
      || !Object.values(server.headers).every(value => typeof value === 'string'))) {
      throw new TaskConfigError('MCP headers must be strings for server ' + name);
    }
    return {
      id: 'diagent-mcp-' + name,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: name,
        transport: 'streamable-http' as const,
        url: server.url,
        headers: (server.headers ?? undefined) as Record<string, string> | undefined,
        failOnStartupError: true,
      },
    };
  });
}

async function namedSubagentProfile(config: TaskConfig, home: string, personaPrefix: string, runDirectory: string) {
  const rootPreset = 'diagent-task-root';
  const roles = await Promise.all(config.subagents.map(async role => {
    const skillRoots = await selectedSkillRoots(
      role.skillsDir ? resolve(config.workspace, role.skillsDir) : config.skillsDir,
      role.skillNames, home, 'selected-skills-' + role.name,
    );
    const mcp = role.mcpConfigPath ? await mcpRows(resolve(config.workspace, role.mcpConfigPath)) : [];
    if (role.mcpConfigPath && mcp.length === 0) {
      throw new TaskConfigError('Subagent MCP configuration has no servers: ' + role.name);
    }
    return {
      ...role, preset: 'diagent-role-' + role.name, toolName: 'delegate_' + role.name,
      resources: { skillRoots, mcp: mcp.map(row => row.config) },
    };
  }));
  const menu = roles.map(role => `- ${role.toolName} — ${role.description}`).join('\n');
  const rootPersona = personaPrefix + '\n\n可委托的子 Agent：\n' + menu;
  const presetRow = (id: string, prefix: string): object => ({
    id, name: '@deepseek-ai/dsh-agent-preset',
    config: { id, plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix } }] },
  });
  return {
    plugins: [
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: rootPreset } },
      { id: rootPreset, name: '@deepseek-ai/dsh-agent-preset', config: { id: rootPreset, plugins: [] } },
      ...roles.flatMap(role => [
        presetRow(role.preset, role.prompt + '\n\n本次任务的产物目录：' + runDirectory),
        { id: role.toolName, name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'spawn', agentPreset: role.preset, toolName: role.toolName, maxDepth: 1 } },
      ]),
    ],
    personaPrefix: rootPersona,
    tools: [...roles.map(role => role.toolName), 'wait_agent'],
    toolIdsByPreset: Object.fromEntries(roles.map(role => [role.preset, role.toolIds.filter(id => id !== 'mcp')])),
    resourcesByPreset: Object.fromEntries(roles.map(role => [role.preset, role.resources])),
  };
}

/**
 * 在本次运行的 DSH home 写入 profile 补丁。
 * @param home - 由调用方创建并清理的任务私有目录。
 * @returns 启动 DSH 时加载的补丁路径。
 * @throws TaskConfigError 指定的 Skill 不可用，或 MCP 配置无效。
 */
export async function writeTaskProfile(config: TaskConfig, home: string, runDirectory: string): Promise<string> {
  const skillRoots = config.toolIds !== undefined && !config.toolIds.includes('skill') ? []
    : config.skillNames.length === 0 ? (config.subagents.some(role => role.skillNames.length) ? [] : [config.skillsDir])
      : await selectedSkillRoots(config.skillsDir, config.skillNames, home);
  const mcpPlugins = await mcpRows(config.mcpConfigPath);
  if (config.toolIds?.includes('mcp') && mcpPlugins.length === 0) {
    throw new TaskConfigError('task.tool_selection mcp requires at least one configured MCP server');
  }
  const plugins: object[] = [...mcpPlugins];
  // DSH 在原生 Windows 上提供 PowerShell，Linux 镜像才是本工具的交付环境。
  const hasShell = process.platform === 'linux' && (config.toolIds === undefined || config.toolIds.includes('shell'));
  if (hasShell) plugins.push(localPlugin('legacy-shell', config.toolIds && { bashDelegationOnly: true }));
  if (config.subagents.some(role => role.toolIds.some(id => taskFileTools.includes(id)))
      || config.toolIds?.some(id => taskFileTools.includes(id))) {
    plugins.push(localPlugin('task-file-scope', { workspace: config.workspace }));
  }
  plugins.push(localPlugin('model-request', { temperature: config.temperature }));
  let selectedMcpTools: string[] | undefined;
  if (mcpPlugins.length > 0 && config.mcpToolNames.length > 0) {
    const serverNames = mcpPlugins.map(plugin => plugin.config.serverName);
    // DSH 对原名做拼接和有损归一化。只接受能唯一对应原名的配置。
    if (serverNames.some(name => name.endsWith('_') || name.includes('__'))) {
      throw new TaskConfigError('Explicit MCP tool lists require unambiguous server names');
    }
    const toolNames = serverNames.flatMap(server => config.mcpToolNames.map(tool => `mcp__${server}__${tool}`));
    if (toolNames.some(name => name.length > 64 || /[^A-Za-z0-9_-]/.test(name) || /_[a-f0-9]{12}$/.test(name))) {
      throw new TaskConfigError('Explicit MCP tool lists require names that DSH can represent without normalization or alias ambiguity');
    }
    selectedMcpTools = toolNames;
  }
  const personaPrefix = config.toolIds === undefined || config.toolIds.includes('shell') || config.toolIds.includes('write')
    ? config.systemPrompt + '\n\n本次任务的文件产物请写到：' + runDirectory
    : config.systemPrompt;
  const namedSubagents = config.subagents.length
    ? await namedSubagentProfile(config, home, personaPrefix, runDirectory) : undefined;
  if (namedSubagents) {
    plugins.push(...namedSubagents.plugins);
    plugins.push(localPlugin('task-agent-resources', {
      root: { skillRoots, mcp: [] }, children: namedSubagents.resourcesByPreset,
      rootMcpServerNames: mcpPlugins.map(row => row.config.serverName),
    }));
  }
  if (config.toolIds !== undefined || namedSubagents) {
    plugins.push(localPlugin('tool-selection', {
      toolIds: config.toolIds && [...config.toolIds, ...(selectedMcpTools ?? []), ...(namedSubagents?.tools ?? [])],
      mcpServerNames: selectedMcpTools === undefined ? mcpPlugins.map(plugin => plugin.config.serverName) : [],
      subagentTools: namedSubagents?.toolIdsByPreset,
    }));
  }
  if (config.toolIds === undefined && selectedMcpTools !== undefined) {
    plugins.push(localPlugin('mcp-tool-selection', { toolNames: selectedMcpTools }));
  }
  if (config.maxToolRounds !== undefined) {
    plugins.push(localPlugin('tool-round-limit', { maxToolRounds: config.maxToolRounds }));
  }
  if (config.isDiosEventPublishingEnabled) {
    plugins.unshift(localPlugin('publish-event'));
  }
  return writeProfile(home, 'task', {
    model: config.model, skillRoots: namedSubagents ? [] : skillRoots, hasShell, hasNamedSubagents: Boolean(namedSubagents),
    // 子角色只订阅 MCP 工具。资源读取工具会绕过全局名单并注册到该会话。
    hasSubagentMcp: config.subagents.some(role => role.toolIds.includes('mcp')),
    personaPrefix: namedSubagents?.personaPrefix ?? personaPrefix,
  }, plugins);
}

/** 用已校验的模型路由、工具选择与会话历史生成一轮 Chat 的私有 DSH 补丁。 */
export async function writeChatProfile(config: ChatProfileConfig, home: string): Promise<string> {
  const { model, personaPrefix, temperature, toolIds, mcpPlugins, mcpToolIds, history, streamText, stepLimit, maxToolRounds } = config;
  const skillRoots = await selectedSkillRoots(config.skillsDir, config.skillNames, home);
  const hasShell = toolIds.includes('shell');
  const plugins = [
    ...mcpPlugins,
    ...(hasShell ? [localPlugin('legacy-shell', { bashDelegationOnly: true })] : []),
    ...(toolIds.includes('publish_event') ? [localPlugin('publish-event')] : []),
    localPlugin('tool-selection', { toolIds: mcpToolIds ? [...toolIds, ...mcpToolIds] : toolIds,
      mcpServerNames: mcpToolIds ? [] : mcpPlugins.map(plugin => plugin.config.serverName) }),
    ...(history.length > 0 ? [localPlugin('chat-history', { history, personaPrefix })] : []),
    ...(streamText ? [localPlugin('chat-stream')] : []),
    ...(maxToolRounds === undefined ? [] : [localPlugin('tool-round-limit', { maxToolRounds })]),
    localPlugin('model-request', { temperature, stepLimit }),
  ];
  return writeProfile(home, 'chat', { model, personaPrefix, skillRoots, hasShell }, plugins);
}

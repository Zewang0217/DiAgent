/** 将一次性任务文件和部署环境转换为 DSH 执行配置，保留 DiOS 的输入兼容性。 */
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import type { HostToolDescriptor } from '../dsh/plugins/host-tools.js';

type ConfigObject = Record<string, unknown>;
/** DSH 文件工具使用本地工作区，并受任务的路径限制。 */
export const taskFileTools = ['read', 'write', 'edit'];
/** 只能在已隔离模型凭据的任务中显式启用的工作区工具。 */
export const taskWorkspaceTools = ['shell', ...taskFileTools];

/** 识别任务入口和容器使用的 Streamable HTTP 连接类型。 */
export function isStreamableHttpTransport(value: unknown): boolean {
  return value === 'streamable_http' || value === 'streamable-http' || value === 'http';
}

/** 任务内委托的角色定义。子 Agent 使用任务的模型路由。 */
interface TaskSubagent {
  name: string;
  description: string;
  prompt: string;
  toolIds: string[];
  skillNames: string[];
  skillsDir?: string;
  mcpConfigPath?: string;
}

/** 已校验的任务配置。路径按各字段的约定解析，事件工具开关由部署环境决定。 */
export interface TaskConfig {
  prompt: string;
  systemPrompt: string;
  workspace: string;
  outputDir: string;
  resultFile: string;
  logFile: string;
  stepLimit: number;
  maxToolRounds?: number;
  temperature: number;
  skillsDir: string;
  skillNames: string[];
  toolIds?: string[];
  hostTools?: HostToolDescriptor[];
  extraSkillRoots?: string[];
  subagents: TaskSubagent[];
  mcpToolNames: string[];
  mcpConfigPath?: string;
  isDiosEventPublishingEnabled: boolean;
  model: {
    name: string;
    baseURL: string;
    apiKey: string;
    contextWindow?: number;
    inputModalities?: string[];
  };
}

/** 标识任务无法启动的输入错误，由命令入口映射为退出码 2。 */
export class TaskConfigError extends Error {}

/** 宿主工具只能来自受管入口，模型任务文件不能自行开放外部服务权限。 */
function parseHostTools(value: unknown, env: NodeJS.ProcessEnv, model: TaskConfig['model']): HostToolDescriptor[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new TaskConfigError('task.host_tools must be a bounded array');
  if (value.length === 0) return undefined;
  const endpoint = new URL(model.baseURL);
  if (env.DIAGENT_TASK_HOST_TOOL_BRIDGE !== 'true' || !env.DIAGENT_TASK_MODEL_REFRESH_PATH
      || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
    throw new TaskConfigError('Business tools require the managed host tool bridge');
  }
  const reserved = new Set(['skill', 'mcp', 'publish_event', 'office', ...taskWorkspaceTools,
    'office_convert', 'office_render', 'office_recalculate', 'run_code', 'wait_agent', 'send_message',
    'list_agents', 'interrupt_agent', 'spawn_agent', 'fork_agent']);
  const names = new Set<string>();
  return value.map((raw, index) => {
    const field = 'task.host_tools[' + index + ']';
    const row = object(raw, field);
    if (Object.keys(row).some(key => !['name', 'description', 'parameters'].includes(key))) {
      throw new TaskConfigError(field + ' contains unsupported fields');
    }
    const name = requiredText(row.name, field + '.name');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || reserved.has(name) || names.has(name)) {
      throw new TaskConfigError(field + '.name must be unique and cannot shadow a native tool');
    }
    names.add(name);
    const description = requiredText(row.description, field + '.description');
    const parameters = object(row.parameters, field + '.parameters');
    if (description.length > 4096 || parameters.type !== 'object' || JSON.stringify(parameters).length > 65536) {
      throw new TaskConfigError(field + ' exceeds the supported tool schema limits');
    }
    return { name, description, parameters };
  });
}

/** 解析 task 与 service 共用的 OpenAI 兼容模型配置。 */
export function parseModelConfig(
  models: unknown, modelKey: string, fallbackApiKey?: unknown,
): TaskConfig['model'] {
  const model = object(object(models, 'models.models')[modelKey], 'model ' + modelKey);
  const provider = requiredText(model.provider, 'model.provider').toLowerCase();
  if (provider !== 'openai' && provider !== 'vllm') {
    throw new TaskConfigError('Unsupported model provider for the DSH runner: ' + provider);
  }
  const baseURL = requiredText(model.base_url, 'model.base_url');
  if (!URL.canParse(baseURL) || !['http:', 'https:'].includes(new URL(baseURL).protocol)) {
    throw new TaskConfigError('model.base_url must be an HTTP(S) URL');
  }
  const inputModalities = model.input_modalities == null ? undefined
    : stringList(model.input_modalities, 'model.input_modalities');
  if (inputModalities && (!inputModalities.includes('text') || inputModalities.some(value => value !== 'text' && value !== 'image'))) {
    throw new TaskConfigError('model.input_modalities must include text and may include image');
  }
  return {
    name: requiredText(model.model, 'model.model'),
    baseURL,
    apiKey: text(model.api_key || fallbackApiKey, 'model.api_key', 'not-needed'),
    contextWindow: model.context_length == null ? undefined
      : positiveInteger(model.context_length, 'model.context_length'),
    ...(inputModalities ? { inputModalities } : {}),
  };
}

function object(value: unknown, field: string): ConfigObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskConfigError(field + ' must be an object');
  }
  return value as ConfigObject;
}

function optionalObject(value: unknown, field: string): ConfigObject {
  return value == null ? {} : object(value, field);
}

function text(value: unknown, field: string, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new TaskConfigError(field + ' must be a string');
  return value;
}

function requiredText(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result.trim()) throw new TaskConfigError(field + ' is required');
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TaskConfigError(field + ' must be a positive integer');
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new TaskConfigError(field + ' must be a list of strings');
  }
  return value;
}

function parseSubagents(value: unknown, modelKey: string, modelName: string, env: NodeJS.ProcessEnv): TaskSubagent[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TaskConfigError('task.subagents must be a list of objects');
  const names = new Set<string>();
  return value.map((item, index) => {
    const field = `task.subagents[${index}]`;
    const role = object(item, field);
    const name = requiredText(role.name, field + '.name').trim();
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name) || names.has(name)) {
      throw new TaskConfigError(field + '.name must be a unique tool-safe identifier');
    }
    names.add(name);
    const model = text(role.model, field + '.model');
    if (model && model !== modelKey && model !== modelName) {
      throw new TaskConfigError(field + '.model must use the task model');
    }
    if (role.task) {
      throw new TaskConfigError(field + ' cannot yet override the delegated task prompt');
    }
    if (role.tools != null) {
      throw new TaskConfigError(field + '.tools is a legacy tool list; use tool_selection.tool_ids for DSH file tools');
    }
    const selection = object(role.tool_selection, field + '.tool_selection');
    if (!Array.isArray(selection.tool_ids) || selection.tool_config != null) {
      throw new TaskConfigError(field + '.tool_selection requires tool_ids and does not accept tool_config');
    }
    const toolIds = [...new Set(stringList(selection.tool_ids, field + '.tool_selection.tool_ids'))];
    if (toolIds.some(id => !['skill', 'mcp', ...taskFileTools].includes(id))) {
      throw new TaskConfigError(field + '.tool_selection can only select skill, mcp, read, write, or edit');
    }
    if (toolIds.some(id => taskFileTools.includes(id)) && !env.DIAGENT_TASK_MODEL_REFRESH_PATH) {
      throw new TaskConfigError('Subagent file tools require the managed task model bridge');
    }
    const skillNames = [...new Set(stringList(role.skill_names, field + '.skill_names'))];
    const skillsDir = text(role.skills_dir, field + '.skills_dir') || undefined;
    if (skillNames.some(name => name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
      throw new TaskConfigError(field + '.skill_names must contain valid Skill names');
    }
    if (toolIds.includes('skill') !== (skillNames.length > 0) || (skillsDir && !skillNames.length)) {
      throw new TaskConfigError(field + '.skill requires tool selection and an explicit Skill list');
    }
    const mcpConfigPath = text(role.mcp_config_path, field + '.mcp_config_path') || undefined;
    if (toolIds.includes('mcp') !== Boolean(mcpConfigPath)) {
      throw new TaskConfigError(field + '.mcp requires tool selection and an explicit connection config');
    }
    return {
      name, toolIds, skillNames, skillsDir, mcpConfigPath,
      description: requiredText(role.description, field + '.description'),
      prompt: requiredText(role.prompt ?? role.system_prompt, field + '.prompt'),
    };
  });
}

function fileName(value: unknown, field: string, fallback: string): string {
  const name = requiredText(value ?? fallback, field);
  if (isAbsolute(name) || basename(name) !== name || name === '.' || name === '..') {
    throw new TaskConfigError(field + ' must be a file name within the run directory');
  }
  return name;
}

async function readConfig(path: string): Promise<ConfigObject> {
  const format = extname(path).toLowerCase();
  try {
    const source = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
    return object(format === '.yaml' || format === '.yml' ? parse(source) : JSON.parse(source), 'config');
  } catch (error) {
    if (error instanceof TaskConfigError) throw error;
    throw new TaskConfigError('Cannot read or parse task configuration: ' + path);
  }
}

/**
 * 从部署环境中的 `TASK_CONFIG` 读取一次性任务。
 * @throws TaskConfigError 配置不可读、字段无效，或任务要求当前执行器尚未支持的行为。
 */
export async function loadTaskConfig(env: NodeJS.ProcessEnv): Promise<TaskConfig> {
  const configPath = resolve(requiredText(env.TASK_CONFIG, 'TASK_CONFIG'));
  const config = await readConfig(configPath);
  const task = typeof config.task === 'string' ? config : object(config.task, 'task');
  const app = optionalObject(config.app, 'app');
  const output = optionalObject(task.output, 'task.output');
  const trigger = optionalObject(task.trigger, 'task.trigger');
  const mode = env.TRIGGER_MODE ?? trigger.mode ?? 'once';
  if (mode !== 'once') throw new TaskConfigError('The DSH task runner currently supports trigger.mode=once');
  const diosEvents = env.DIAGENT_ENABLE_DIOS_EVENTS ?? 'true';
  if (diosEvents !== 'true' && diosEvents !== 'false') {
    throw new TaskConfigError('DIAGENT_ENABLE_DIOS_EVENTS must be true or false');
  }
  if (task.thread_id || task.middleware_config != null) {
    throw new TaskConfigError('Task checkpoints and middleware_config require the Python runner');
  }

  const workspace = resolve(text(task.workspace, 'task.workspace', 'workspace'));
  try {
    if (!(await stat(workspace)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new TaskConfigError('Workspace is not an accessible directory: ' + workspace);
  }

  const modelsFile = text(app.LLM_MODELS_CONFIG_PATH ?? env.LLM_MODELS_CONFIG_PATH, 'LLM_MODELS_CONFIG_PATH');
  const models = config.models == null && modelsFile
    ? await readConfig(resolve(modelsFile))
    : object(config.models, 'models');
  const modelKey = requiredText(
    text(task.model, 'task.model') || app.LLM_DEFAULT_MODEL || models.default_model || env.LLM_DEFAULT_MODEL,
    'task.model or models.default_model',
  );
  const model = parseModelConfig(
    models.models, modelKey, app.LLM_OPENAI_API_KEY || env.LLM_OPENAI_API_KEY || env.OPENAI_API_KEY,
  );
  const subagents = parseSubagents(task.subagents, modelKey, model.name, env);
  const hostTools = parseHostTools(task.host_tools, env, model);
  if (hostTools && subagents.length) throw new TaskConfigError('Host tools cannot be enabled with named subagents');

  const skillsDir = resolve(workspace, text(task.skills_dir, 'task.skills_dir', 'skills'));
  const skillNames = [...new Set(stringList(task.skill_names, 'task.skill_names'))];
  const extraSkillRoots = [...new Set(stringList(task.extra_skill_roots, 'task.extra_skill_roots').map(path => resolve(workspace, path)))];
  if (extraSkillRoots.length > 32 || (extraSkillRoots.length && (env.DIAGENT_TASK_CUSTOM_SKILLS !== 'true' || subagents.length))) {
    throw new TaskConfigError('Extra skill roots require the managed readonly skill snapshot');
  }
  for (const root of extraSkillRoots) {
    try {
      if (!(await stat(root)).isDirectory() || !(await stat(resolve(root, 'SKILL.md'))).isFile()) throw new Error('Not a skill');
    } catch {
      throw new TaskConfigError('Extra skill snapshot is unavailable');
    }
  }
  if (skillNames.some(name => !name || name === '.' || name === '..' || /[\\/:]/.test(name))) {
    throw new TaskConfigError('task.skill_names must contain directory names');
  }

  const selectedTools = stringList(task.tools, 'task.tools');
  let toolIds: string[] | undefined;
  if (Object.hasOwn(task, 'tool_selection')) {
    const selection = object(task.tool_selection, 'task.tool_selection');
    if (!Array.isArray(selection.tool_ids) || selection.tool_config != null) {
      throw new TaskConfigError('task.tool_selection requires tool_ids and does not accept tool_config');
    }
    toolIds = [...new Set(stringList(selection.tool_ids, 'task.tool_selection.tool_ids'))];
    if (toolIds.some(id => !['skill', 'mcp', 'publish_event', 'office', ...taskWorkspaceTools,
      ...(hostTools ?? []).map(tool => tool.name)].includes(id))) {
      throw new TaskConfigError('task.tool_selection contains an unsupported tool');
    }
    if (toolIds.includes('office')) {
      if (subagents.length > 0) throw new TaskConfigError('Office tools cannot be enabled with named subagents');
      if (!env.DIAGENT_TASK_MODEL_REFRESH_PATH) {
        throw new TaskConfigError('Office tools require the managed task model bridge');
      }
    }
    if (toolIds.some(id => taskWorkspaceTools.includes(id)) && !env.DIAGENT_TASK_MODEL_REFRESH_PATH) {
      throw new TaskConfigError('Shell and file tools require the managed task model bridge');
    }
    if (toolIds.includes('skill') && skillNames.length === 0 && extraSkillRoots.length === 0) {
      throw new TaskConfigError('task.tool_selection skill requires task.skill_names');
    }
    if (toolIds.includes('publish_event') && diosEvents === 'false') {
      throw new TaskConfigError('task.tool_selection publish_event is disabled by deployment');
    }
  }
  if (hostTools?.some(tool => !toolIds?.includes(tool.name))) {
    throw new TaskConfigError('Host tools require an explicit matching task.tool_selection');
  }
  if (extraSkillRoots.length && !toolIds?.includes('skill')) {
    throw new TaskConfigError('Extra skill roots require an explicit skill tool grant');
  }
  const taskMcpPath = text(task.mcp_config_path, 'task.mcp_config_path');
  const defaultMcpPath = text(app.MCP_CONFIG_PATH ?? env.MCP_CONFIG_PATH, 'MCP_CONFIG_PATH');
  // 显式空工具列表或空 MCP 路径表示关闭 MCP。省略时才允许使用部署默认路径。
  const mcpConfigPath = (toolIds !== undefined && !toolIds.includes('mcp'))
    || (Array.isArray(task.tools) && selectedTools.length === 0) || task.mcp_config_path === '' ? undefined
    : taskMcpPath ? resolve(workspace, taskMcpPath)
    : defaultMcpPath ? resolve(defaultMcpPath) : undefined;
  if (toolIds?.includes('mcp') && !mcpConfigPath) {
    throw new TaskConfigError('task.tool_selection mcp requires an enabled MCP configuration');
  }

  if (subagents.some(role => role.mcpConfigPath) && (toolIds === undefined || toolIds.includes('shell'))) {
    throw new TaskConfigError('Subagent MCP requires an explicit parent tool_selection without shell');
  }

  const temperature = task.temperature;
  if (temperature != null && (typeof temperature !== 'number'
    || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new TaskConfigError('task.temperature must be a number between 0 and 2');
  }
  const outputDir = env.OUTPUT_DIR ? resolve(env.OUTPUT_DIR)
    : task.output_dir ? resolve(workspace, requiredText(task.output_dir, 'task.output_dir'))
    : process.cwd();
  const resultFile = fileName(output.result_file, 'task.output.result_file', 'task_result.txt');
  const logFile = fileName(output.log_file, 'task.output.log_file', 'task.log');
  if (resultFile.toLowerCase() === logFile.toLowerCase()) {
    throw new TaskConfigError('Task result and log must use different files');
  }

  return {
    prompt: requiredText(task.task, 'task.task'),
    systemPrompt: text(task.system_prompt || app.AGENT_SYSTEM_PROMPT || env.AGENT_SYSTEM_PROMPT,
      'task.system_prompt', '你是用户的助理。按用户给定的任务完成工作，并清楚说明结果。'),
    workspace,
    outputDir,
    resultFile,
    logFile,
    stepLimit: positiveInteger(task.recursion_limit ?? 100, 'task.recursion_limit'),
    maxToolRounds: task.max_tool_rounds == null
      ? undefined : positiveInteger(task.max_tool_rounds, 'task.max_tool_rounds'),
    temperature: temperature ?? 0.7,
    skillsDir,
    skillNames,
    toolIds,
    hostTools,
    extraSkillRoots,
    subagents,
    mcpToolNames: selectedTools,
    mcpConfigPath,
    isDiosEventPublishingEnabled: diosEvents === 'true' && (toolIds === undefined || toolIds.includes('publish_event')),
    model,
  };
}

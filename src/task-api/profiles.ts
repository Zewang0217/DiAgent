/** 从部署目录装配独立任务使用的模型网关、MCP 和 Skills。 */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingPath, isObject, isPathSegment, TaskApiError } from './inputs.js';

function profilePath(value: unknown): string {
  if (typeof value !== 'string') throw new TaskApiError(500, 'Invalid deployed profile asset path');
  const relative = value.replace(/^\/profile\//, '');
  if (!relative.split('/').every(isPathSegment)) {
    throw new TaskApiError(500, 'Profile assets must be under /profile');
  }
  return relative;
}

function gatewayUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}

async function readMcpProfile(profile: string, relative: string): Promise<unknown> {
  let path = profile;
  for (const segment of relative.split('/')) {
    if (!(await lstat(path)).isDirectory()) throw new TaskApiError(500, 'Invalid profile MCP path');
    path = join(path, segment);
  }
  if (!(await lstat(path)).isFile()) throw new TaskApiError(500, 'Invalid profile MCP path');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

/** 模型和 MCP 使用部署网关。任务可读的配置和附件只包含非机密内容。 */
export async function loadTaskProfile(profile: string, prompt: string): Promise<Record<string, unknown>> {
  const path = join(profile, 'agent-task.json');
  let template: unknown;
  try {
    if (!(await lstat(profile)).isDirectory() || !(await lstat(path)).isFile()) {
      throw new TaskApiError(404, 'Task profile not found');
    }
    template = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (isMissingPath(error)) throw new TaskApiError(404, 'Task profile not found');
    if (error instanceof SyntaxError) throw new TaskApiError(500, 'Invalid deployed task profile JSON');
    throw error;
  }

  if (!isObject(template) || !isObject(template.task) || !isObject(template.models) || template.app !== undefined
    || !isObject(template.models.models)) {
    throw new TaskApiError(500, 'Expected task and inline models in the deployed task profile');
  }
  for (const model of Object.values(template.models.models)) {
    if (!isObject(model) || model.api_key != null || !gatewayUrl(model.base_url)) {
      throw new TaskApiError(500, 'Configure a model gateway URL without credentials or query parameters');
    }
  }

  const { task, models } = template;
  const skills = profilePath(task.skills_dir ?? 'skills');
  const mcp = task.mcp_config_path === '' || task.mcp_config_path == null ? '' : profilePath(task.mcp_config_path);
  if (mcp) {
    let servers: unknown;
    try {
      servers = await readMcpProfile(profile, mcp);
    } catch (error) {
      if (isMissingPath(error) || error instanceof SyntaxError) {
        throw new TaskApiError(500, 'Cannot read deployed MCP profile as JSON');
      }
      throw error;
    }
    if (!isObject(servers) || Object.values(servers).some(server => !isObject(server)
      || !gatewayUrl(server.url) || server.headers != null)) {
      throw new TaskApiError(500, 'Configure MCP gateway URLs without credentials, headers or query parameters');
    }
  }

  return {
    models,
    task: {
      ...task, task: prompt, workspace: '/workspace',
      skills_dir: '/profile/' + skills,
      mcp_config_path: mcp ? '/profile/' + mcp : '',
    },
  };
}

/** 发现部署允许的 MCP 工具，并保留旧工具目录使用的原始名称。 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mcpProfileRows } from '../dsh/profile.js';

type Connections = ReturnType<typeof mcpProfileRows>;
const publicNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
const reservedNames = new Set(['shell', 'skill', 'publish_event', 'mcp']);

interface LegacyTool {
  id: string;
  name: string;
  description: string;
  server: 'mcp';
  parameters: object;
}

/** 读取独立服务的 MCP 文件。沿用旧默认路径的空配置兼容行为。 */
export async function standaloneMcpConnections(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Connections> {
  const path = resolve(env.MCP_CONFIG_PATH || 'configs/mcp_servers.json');
  let source: string;
  try {
    source = await readFile(path, { encoding: 'utf8', signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return mcpProfileRows(JSON.parse(source.replace(/^\uFEFF/, '')));
}

/** 检查工作区配置中的连接数据是否可能携带静态凭据。 */
export function hasLocalMcpCredentials(connections: Connections): boolean {
  return connections.some(({ config }) => {
    const url = new URL(config.url);
    return Boolean(url.username || url.password || url.search || Object.keys(config.headers ?? {}).length);
  });
}

interface DiscoveredTool {
  tool: LegacyTool;
  publicId: string;
  connection: Connections[number];
}

async function listServerTools(connection: Connections[number], signal: AbortSignal): Promise<DiscoveredTool[]> {
  const client = new Client({ name: 'DiAgent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), {
    requestInit: { headers: connection.config.headers, redirect: 'error' },
    fetch: (input, options) => fetch(input, { ...options, signal: options?.signal
      ? AbortSignal.any([signal, options.signal]) : signal }),
  });
  try {
    await client.connect(transport, { signal });
    if (!client.getServerCapabilities()?.tools) return [];
    const { tools } = await client.listTools(undefined, { signal });
    return tools.map(({ name, description, inputSchema }) => ({ connection,
      publicId: `mcp__${connection.config.serverName}__${name}`,
      tool: { id: name, name, description: description ?? '', server: 'mcp', parameters: inputSchema } }));
  } finally {
    try {
      if (transport.sessionId && !signal.aborted) await transport.terminateSession();
    } finally {
      await transport.close();
    }
  }
}

/** 只公布能用旧原始名称唯一选择的 DSH 工具。 */
export async function discoverLegacyTools(connections: Connections, signal: AbortSignal): Promise<DiscoveredTool[]> {
  const discovery = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const tools = (await Promise.all(connections.map(connection => listServerTools(connection, discovery)))).flat();
  const counts = new Map<string, number>();
  for (const { tool } of tools) counts.set(tool.id, (counts.get(tool.id) ?? 0) + 1);
  return tools.filter(({ tool, publicId, connection }) => counts.get(tool.id) === 1 && !reservedNames.has(tool.id)
    && publicNamePattern.test(publicId) && !/_[a-f0-9]{12}$/.test(publicId)
    && !connection.config.serverName.includes('__') && !connection.config.serverName.endsWith('_'));
}

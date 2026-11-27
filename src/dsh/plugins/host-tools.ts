/** 通过受管任务代理调用宿主批准的业务工具，不持有外部服务凭据。 */
import { request } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';

export const name = 'diagent-host-tools';
export const inject = ['tools'];

export interface HostToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface HostToolConfig {
  url: string;
  grant: string;
  tools: HostToolDescriptor[];
}

// 宿主允许 64 KiB 原始文本；JSON 对控制字符最多使用六字节转义，另留信封空间。
const responseLimit = 6 * 64 * 1024 + 1024;

/** 不自动重试或重定向；不确定外部副作用由宿主持久记录决定能否恢复。 */
async function invoke(
  config: HostToolConfig, tool: string, args: unknown, callId: string, signal: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({ call_id: callId, tool, arguments: args });
  return new Promise((accept, reject) => {
    const sending = request(config.url, {
      method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + config.grant, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const receive = async (): Promise<string> => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > responseLimit) {
            response.destroy();
            throw new Error('Host tool response exceeds its size limit');
          }
          chunks.push(bytes);
        }
        let result: unknown;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new Error('Host tool returned an invalid response');
        }
        if (!result || typeof result !== 'object') throw new Error('Host tool returned an invalid response');
        if (response.statusCode !== 200) {
          const code = 'error_code' in result && typeof result.error_code === 'string'
            && /^[a-z_]{1,64}$/.test(result.error_code) ? result.error_code : 'host_tool_failed';
          throw new Error('Host tool failed: ' + code);
        }
        if (!('result' in result) || typeof result.result !== 'string') {
          throw new Error('Host tool returned an invalid response');
        }
        return result.result;
      };
      void receive().then(accept, reject);
    });
    sending.once('error', reject);
    sending.end(body);
  });
}

/** 原生工具拥有原 schema 与真实执行身份，不接受模型自行提供代理地址或调用标识。 */
export function apply(ctx: Context, config: HostToolConfig): void {
  const endpoint = new URL(config.url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/tools/call' || endpoint.search || endpoint.hash || !config.grant) {
    throw new Error('Host tools require the managed local task proxy');
  }
  for (const tool of config.tools) {
    ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: (args, execution) => invoke(config, tool.name, args, execution.callId, execution.signal),
    });
  }
}

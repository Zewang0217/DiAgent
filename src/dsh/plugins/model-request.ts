/** 在 DSH 子进程内应用模型温度和请求前的步数限制。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';

export const name = 'diagent-model-request';
export const inject = ['agents'];

/** 在实际模型调用前检查预算，避免父进程的 SSE 背压延迟拦截。 */
export function apply(ctx: Context, config: { temperature: number; stepLimit?: number }): void {
  // 固定版本的 DSH 尚无替代的逐请求温度接口，此事件也只在实际请求前触发。
  ctx.on('agent/request', async ({ step }, next) => {
    if (config.stepLimit !== undefined && step > config.stepLimit) {
      throw new Error('Chat exceeded its configured step limit');
    }
    return { ...await next(), temperature: config.temperature };
  }, { global: true });
}

/** 将显式授予的原生文件工具限制在任务工作区。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';

export const name = 'diagent-task-file-scope';
export const inject = ['tools', 'fs', 'workingDirectory'];

/** 校验文件工具的规范化目标，DSH 仍执行实际文件操作和写入策略。 */
export function apply(ctx: Context, { workspace }: { workspace: string }): void {
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!['read', 'write', 'edit'].includes(execution.name)) return next();
    const args = execution.arguments;
    if (!args || typeof args !== 'object' || !('file_path' in args) || typeof args.file_path !== 'string') return next();
    const { agent, signal } = execution;
    const cwd = agent ? await ctx.workingDirectory.ensure(agent, signal) : undefined;
    const root = await ctx.fs.resolve(workspace, { signal });
    const target = await ctx.fs.resolve(args.file_path, { cwd, signal });
    if (!ctx.fs.contains(root, target)) {
      return { kind: 'deny', reason: 'Task file tools only operate inside the workspace' };
    }
    return next();
  }, { prepend: true });
}

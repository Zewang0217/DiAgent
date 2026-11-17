/** DSH 与工具子进程沿用工作区 UID，但不能切换为持有刷新凭据的代理 UID。 */
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('lib/bin.js', import.meta.resolve('@deepseek-ai/dsh/package.json')));
if (!process.execve) throw new Error('Task model refresh requires execve support');
process.execve('/usr/bin/setpriv', [
  'setpriv', '--bounding-set=-setuid,-setgid,-sys_ptrace', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
  process.execPath, '--disable-sigusr1', cli, ...process.argv.slice(2),
], process.env);

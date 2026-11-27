/** 终态产物清单覆盖运行目录内的嵌套文件，并排除日志和结果文件。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { TaskResultProtocol } from '../dist/task/result-protocol.js';

test('completed results list nested artifacts and exclude logs', async context => {
  await mkdir(resolve('.cache'), { recursive: true });
  const directory = await mkdtemp(resolve('.cache/task-artifacts-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'work');
  const output = join(workspace, 'output');
  const control = join(directory, 'control');
  const runDirectory = join(output, 'run-task');
  await mkdir(join(runDirectory, 'nested'), { recursive: true });
  await writeFile(join(runDirectory, 'a.txt'), 'a');
  await writeFile(join(runDirectory, 'nested', 'b.txt'), 'b');
  await writeFile(join(runDirectory, 'task.log'), 'log');
  await writeFile(join(runDirectory, 'task_result.md'), 'result');

  const config = {
    workspace, outputDir: output, logFile: 'task.log', resultFile: 'task_result.md',
    subagents: [], toolIds: [], isDiosEventPublishingEnabled: false,
  };
  const protocol = await TaskResultProtocol.open({ DIAGENT_TASK_PROTOCOL_DIR: control }, config);
  await protocol.finish('completed', config, 'done');

  const result = JSON.parse(await readFile(join(control, 'result.json'), 'utf8'));
  assert.deepEqual(result.artifacts, ['output/run-task/a.txt', 'output/run-task/nested/b.txt']);
});

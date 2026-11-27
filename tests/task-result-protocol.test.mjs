/** 回放两个独立 Task 进程使用同一个检查点。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { writeFailureResult } from '../dist/task/result-protocol.js';

const exec = promisify(execFile);

test('a config failure publishes a stable result code', async () => {
  const directory = await mkdtemp(resolve('.task-protocol-failure-'));
  try {
    await writeFailureResult({ DIAGENT_TASK_PROTOCOL_DIR: directory }, 'invalid_config');
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));

    assert.equal(result.version, 2);
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'invalid_config');
    assert.equal(result.error, 'invalid_config');
    assert.equal(result.steps, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pauses before a new model request and restores the completed shell result', {
  skip: process.platform !== 'linux',
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(resolve('.task-protocol-'));
  const workspace = join(directory, 'work');
  const control = join(directory, 'control');
  await mkdir(workspace);
  await mkdir(control);
  const requests = [];
  const replyPrefix = '从原工作区完成任务';
  const longReply = replyPrefix + 'a'.repeat(4095 - replyPrefix.length) + '🙂';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const hasToolResult = body.messages.some(message => message.role === 'tool'
      && message.content?.includes('fixture-written'));
    const delta = hasToolResult ? { content: longReply } : {
      tool_calls: [{ index: 0, type: 'function', id: 'write-fixture', function: {
        name: 'shell',
        arguments: JSON.stringify({ command: "printf x >> effect.txt; printf fixture-written" }),
      } }],
    };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [part, reason] of [[{ role: 'assistant' }, null], [delta, null], [{}, hasToolResult ? 'stop' : 'tool_calls']]) {
      response.write('data: ' + JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: part, finish_reason: reason }],
      }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });

  const configPath = join(control, 'task.json');
  const refreshPath = join(control, 'refresh.json');
  const env = {
    ...process.env,
    TASK_CONFIG: configPath,
    OUTPUT_DIR: join(workspace, 'output'),
    TRIGGER_MODE: 'once',
    DIAGENT_ENABLE_DIOS_EVENTS: 'false',
    DIAGENT_TASK_MODEL_REFRESH_PATH: refreshPath,
    DIAGENT_TASK_PROTOCOL_DIR: control,
    DIAGENT_TASK_PAUSE_ON_LIMIT: 'true',
    DIAGENT_TASK_TIMEOUT_MS: '20000',
  };

  async function segment(stepLimit, checkpoint = '') {
    await writeFile(configPath, JSON.stringify({
      models: { default_model: 'fixture', models: { fixture: {
        provider: 'openai', model: 'fixture-model',
        base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'fixture-key',
      } } },
      task: { task: '运行一次写入工具', workspace, recursion_limit: stepLimit, tool_selection: { tool_ids: ['shell'] } },
    }));
    await writeFile(refreshPath, JSON.stringify({ refresh_token: 'a'.repeat(43) }));
    await exec(process.execPath, ['--disable-sigusr1', 'dist/task/main.js'], {
      env: { ...env, DIAGENT_TASK_RESUME_SESSION: checkpoint }, timeout: 25000,
    });
    return JSON.parse(await readFile(join(control, 'result.json'), 'utf8'));
  }

  try {
    const first = await segment(1);
    assert.equal(first.status, 'paused');
    assert.equal(first.steps, 1);
    assert.equal(requests.length, 1);
    assert.equal(await readFile(join(workspace, 'effect.txt'), 'utf8'), 'x');
    const events = (await readFile(join(control, 'events.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.type === 'tool_started' && event.tool === 'shell'));
    assert.ok(events.some(event => event.type === 'tool_finished' && event.success));

    const second = await segment(2, first.checkpoint_ref);
    assert.equal(second.status, 'completed');
    assert.match(second.summary, /从原工作区完成任务/);
    assert.equal(second.summary.length, 4096);
    assert.ok(second.summary.isWellFormed());
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(message => message.role === 'tool'));
    assert.equal(await readFile(join(workspace, 'effect.txt'), 'utf8'), 'x');
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

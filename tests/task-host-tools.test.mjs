/** 原生宿主工具只转发实际调用身份，参数与真实服务授权在宿主核对。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { apply } from '../dist/dsh/plugins/host-tools.js';
import { loadTaskConfig } from '../dist/task/config.js';
import { TaskResultProtocol } from '../dist/task/result-protocol.js';
import { openTaskModelBridge } from '../dist/task/model-bridge.js';

async function taskFixture(context) {
  await mkdir(resolve('.cache'), { recursive: true });
  const directory = await mkdtemp(resolve('.cache/host-task-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'work');
  const control = join(directory, 'control');
  await mkdir(workspace);
  await mkdir(control);
  const path = join(control, 'task.json');
  await writeFile(path, JSON.stringify({
    models: { default_model: 'fixture', models: { fixture: {
      provider: 'openai', model: 'fixture', base_url: 'http://127.0.0.1:8765/v1', api_key: 'task-grant',
    } } },
    task: { task: '生成配图', workspace, tool_selection: { tool_ids: ['image_generator'] }, host_tools: [{
      name: 'image_generator', description: '生成配图',
      parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    }] },
  }));
  return { env: {
    TASK_CONFIG: path, OUTPUT_DIR: join(workspace, 'output'), DIAGENT_ENABLE_DIOS_EVENTS: 'false',
    DIAGENT_TASK_MODEL_REFRESH_PATH: join(control, 'refresh.json'), DIAGENT_TASK_HOST_TOOL_BRIDGE: 'true',
    DIAGENT_TASK_PROTOCOL_DIR: control, DIAGENT_TASK_PAUSE_ON_LIMIT: 'true',
  } };
}

test('only the managed host bridge can enable checkpointed business tools', async context => {
  const { env } = await taskFixture(context);

  const config = await loadTaskConfig(env);
  const protocol = await TaskResultProtocol.open(env, config);

  assert.deepEqual(config.hostTools.map(tool => tool.name), ['image_generator']);
  assert.ok(protocol.checkpoint);
});

test('a managed model socket enables host tools without a refresh file', async context => {
  const { env } = await taskFixture(context);
  const config = await loadTaskConfig({
    ...env, DIAGENT_TASK_MODEL_REFRESH_PATH: '',
    DIAGENT_TASK_MODEL_SOCKET: join(process.cwd(), '.cache', 'host-task.sock'),
  });

  assert.deepEqual(config.hostTools.map(tool => tool.name), ['image_generator']);
  assert.equal(config.managedModelRefresh, undefined);
  assert.equal(config.managedModelSocket, join(process.cwd(), '.cache', 'host-task.sock'));
});

test('checkpointed host tools accept a managed model socket', async context => {
  const { env } = await taskFixture(context);
  const socketEnv = {
    ...env, DIAGENT_TASK_MODEL_REFRESH_PATH: '',
    DIAGENT_TASK_MODEL_SOCKET: join(process.cwd(), '.cache', 'host-checkpoint.sock'),
  };
  const config = await loadTaskConfig(socketEnv);
  const protocol = await TaskResultProtocol.open(socketEnv, config);

  assert.ok(protocol?.checkpoint);
});

test('task config cannot self-authorize a host bridge', async context => {
  const { env } = await taskFixture(context);

  await assert.rejects(loadTaskConfig({ ...env, DIAGENT_TASK_HOST_TOOL_BRIDGE: '' }), /managed host/i);
});

test('managed model proxy forwards approved host calls once without authorization retries', {
  skip: process.platform !== 'linux', timeout: 20000,
}, async context => {
  const { env } = await taskFixture(context);
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error_code: 'unauthorized' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  await writeFile(env.DIAGENT_TASK_MODEL_REFRESH_PATH, JSON.stringify({ refresh_token: 'r'.repeat(43) }));
  await using bridge = await openTaskModelBridge({
    name: 'fixture', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'host-only-task-grant',
  }, env.DIAGENT_TASK_MODEL_REFRESH_PATH, new AbortController().signal, true);

  const body = { call_id: 'managed-call', tool: 'image_generator', arguments: { prompt: 'school' } };
  const response = await fetch(new URL('/tools/call', bridge.model.baseURL), {
    method: 'POST', headers: { Authorization: 'Bearer ' + bridge.model.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.text();

  assert.equal(response.status, 401);
  assert.deepEqual(requests, [{ path: '/tools/call', authorization: 'Bearer host-only-task-grant', body }]);
  assert.notEqual(bridge.model.apiKey, 'host-only-task-grant');
});

async function fixture(context, handle) {
  const server = createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const tools = [];
  const schema = { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] };
  apply({ tools: { register: tool => tools.push(tool) } }, {
    url: 'http://127.0.0.1:' + server.address().port + '/tools/call', grant: 'temporary-task-grant',
    tools: [{ name: 'image_generator', description: '生成配图', parameters: schema }],
  });
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].parameters, schema);
  return tools[0];
}

test('host tool forwards native call id and the exact parameters once', async context => {
  const requests = [];
  const tool = await fixture(context, async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ body: JSON.parse(raw), authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ result: 'generated.png' }));
  });

  const result = await tool.execute({ prompt: 'school' }, { callId: 'native-id', signal: new AbortController().signal });

  assert.equal(result, 'generated.png');
  assert.deepEqual(requests, [{
    authorization: 'Bearer temporary-task-grant',
    body: { call_id: 'native-id', tool: 'image_generator', arguments: { prompt: 'school' } },
  }]);
});

test('an unknown external outcome is an explicit failure without a retry', async context => {
  let calls = 0;
  const tool = await fixture(context, (_request, response) => {
    calls += 1;
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error_code: 'tool_outcome_unknown' }));
  });

  await assert.rejects(tool.execute({ prompt: 'school' }, {
    callId: 'native-id', signal: new AbortController().signal,
  }), /tool_outcome_unknown/);
  assert.equal(calls, 1);
});

test('a bounded host result remains readable after worst case JSON escaping', async context => {
  const result = '\u0000'.repeat(64 * 1024);
  const tool = await fixture(context, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ result }));
  });

  assert.equal(await tool.execute({ prompt: 'school' }, {
    callId: 'escaped-id', signal: new AbortController().signal,
  }), result);
});

test('host tool observes cancellation while the external service is pending', async context => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const tool = await fixture(context, (_request, _response) => started());
  const abort = new AbortController();
  const running = tool.execute({ prompt: 'school' }, { callId: 'cancel-id', signal: abort.signal });
  const rejected = assert.rejects(running);
  await ready;

  abort.abort();

  await rejected;
});

test('real DSH resumes the completed host tool result in another process without a second submission', {
  skip: process.platform !== 'linux', timeout: 60000,
}, async context => {
  const { env } = await taskFixture(context);
  const calls = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url === '/tools/call') {
      calls.push(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ result: 'host-generated-once' }));
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    requests.push(body);
    const completed = body.messages.some(message => message.role === 'tool' && message.content?.includes('host-generated-once'));
    const delta = completed ? { content: '已完成配图' } : { tool_calls: [{
      index: 0, type: 'function', id: 'external-image-call',
      function: { name: 'image_generator', arguments: JSON.stringify({ prompt: 'school' }) },
    }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [part, reason] of [[{ role: 'assistant' }, null], [delta, null], [{}, completed ? 'stop' : 'tool_calls']]) {
      response.write('data: ' + JSON.stringify({
        id: 'host-tool-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: part, finish_reason: reason }],
      }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const execute = promisify(execFile);
  async function segment(stepLimit, checkpoint = '') {
    const configuration = JSON.parse(await readFile(env.TASK_CONFIG, 'utf8'));
    configuration.models.models.fixture.base_url = 'http://127.0.0.1:' + server.address().port + '/v1';
    configuration.task.recursion_limit = stepLimit;
    await writeFile(env.TASK_CONFIG, JSON.stringify(configuration));
    await writeFile(env.DIAGENT_TASK_MODEL_REFRESH_PATH, JSON.stringify({ refresh_token: 'r'.repeat(43) }));
    await execute(process.execPath, [resolve('dist/task/main.js')], {
      cwd: process.cwd(), timeout: 30000,
      env: { ...process.env, ...env, DIAGENT_TASK_TIMEOUT_MS: '25000', DIAGENT_TASK_RESUME_SESSION: checkpoint },
    });
    return JSON.parse(await readFile(join(env.DIAGENT_TASK_PROTOCOL_DIR, 'result.json'), 'utf8'));
  }

  const paused = await segment(1);
  assert.equal(paused.status, 'paused');
  assert.equal(calls.length, 1);
  const completed = await segment(2, paused.checkpoint_ref);

  assert.equal(completed.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].call_id, 'external-image-call');
  assert.deepEqual(calls[0].arguments, { prompt: 'school' });
  assert.equal(requests.length, 2);
});

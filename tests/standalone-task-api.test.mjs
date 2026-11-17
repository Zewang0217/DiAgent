/** 通过独立任务的 HTTP 入口验证提交、状态与产物回收。 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { link, mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTaskApi } from '../dist/task-api/server.js';

async function fixture(run) {
  await mkdir('.cache', { recursive: true });
  await using scratch = await mkdtempDisposable(join(process.cwd(), '.cache', 'task-api-'));
  const profiles = join(scratch.path, 'profiles');
  const profile = join(profiles, 'reviewer');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'agent-task.json'), JSON.stringify({
    task: { workspace: '/old', task: 'Template prompt', mcp_config_path: 'mcp.json' },
    models: { default_model: 'fixture', models: { fixture: { base_url: 'http://model/v1' } } },
  }));
  await writeFile(join(profile, 'mcp.json'), '{}');
  const options = { root: join(scratch.path, 'jobs'), profiles, token: 'fixture-controller-token' };
  await run(options);
}

async function callApi(options, docker, run) {
  await using server = createTaskApi(options, docker);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await run((path, request = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...request, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + options.token, ...request.headers },
  }));
}

test('an external scheduler submits one job, resumes polling after restart and downloads its artifact', () => fixture(async options => {
  let started;
  let state = { status: 'running' };
  let removed = 0;
  const docker = {
    async start(task) { started = task; },
    async inspect() { return state; },
    async remove() { removed += 1; state = undefined; },
  };
  let id;
  await callApi(options, docker, async request => {
    const response = await request('/v1/tasks', { method: 'POST', body: JSON.stringify({
      profile: 'reviewer', prompt: 'Read draft.txt', files: { 'draft.txt': 'fixture draft' },
    }) });
    assert.equal(response.status, 202, await response.clone().text());
    id = (await response.json()).id;
    assert.equal((await (await request('/v1/tasks/' + id)).json()).status, 'running');
    assert.equal((await request('/v1/tasks/' + id + '/artifacts')).status, 409);
  });
  assert.equal(await readFile(join(started.workspace, 'draft.txt'), 'utf8'), 'fixture draft');
  const workerConfig = JSON.parse(await readFile(started.config, 'utf8'));
  assert.deepEqual(workerConfig.task, {
    workspace: '/workspace', task: 'Read draft.txt', mcp_config_path: '/profile/mcp.json', skills_dir: '/profile/skills',
  });
  assert.equal(workerConfig.models.default_model, 'fixture');
  const output = join(started.workspace, 'output', 'run-fixture');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'task_result.txt'), 'review result');
  await link(started.config, join(output, 'hidden.txt'));
  state = { status: 'exited', exitCode: 0 };
  await callApi(options, docker, async request => {
    const task = await (await request('/v1/tasks/' + id)).json();
    assert.equal(task.status, 'completed');
    assert.equal(task.exit_code, 0);
    const index = await (await request('/v1/tasks/' + id + '/artifacts')).json();
    assert.deepEqual(index.artifacts, [{ path: 'run-fixture/task_result.txt', size: 13 }]);
    const artifact = await request('/v1/tasks/' + id + '/artifacts/run-fixture/task_result.txt');
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'review result');
    assert.equal((await request('/v1/tasks/' + id + '/artifacts/run-fixture/hidden.txt')).status, 404);
    assert.equal((await request('/v1/tasks/' + id + '/artifacts/run-fixture/..%2F..%2Ftask.json')).status, 404);
    assert.equal(removed, 1);
  });
}));

test('the controller refuses a deployment profile with model keys or MCP authorization headers', () => fixture(async options => {
  const profile = join(options.profiles, 'reviewer');
  const configPath = join(profile, 'agent-task.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const docker = { async start() { assert.fail('A profile containing a credential started a worker'); } };
  await callApi(options, docker, async request => {
    const submit = () => request('/v1/tasks', { method: 'POST', body: JSON.stringify({ profile: 'reviewer', prompt: 'Run' }) });
    const withKey = structuredClone(config);
    withKey.models.models.fixture.api_key = 'test-vendor-key';
    await writeFile(configPath, JSON.stringify(withKey));
    assert.equal((await submit()).status, 500);
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(profile, 'mcp.json'), JSON.stringify({
      fixture: { url: 'http://mcp/', headers: { Authorization: 'Bearer test-mcp-key' } },
    }));
    assert.equal((await submit()).status, 500);
  });
}));

test('an interrupted launch left in created is reported as failed and cleaned up', () => fixture(async options => {
  let removed = 0;
  const docker = {
    async start() { throw new Error('Docker could not start the container'); },
    async inspect() { return { status: 'created', exitCode: 0 }; },
    async remove() { removed += 1; },
  };
  await callApi(options, docker, async request => {
    const submitted = await request('/v1/tasks', {
      method: 'POST', body: JSON.stringify({ profile: 'reviewer', prompt: 'Review' }),
    });
    assert.equal(submitted.status, 202);
    const task = await (await request(submitted.headers.get('Location'))).json();
    assert.equal(task.status, 'failed');
    assert.equal(task.exit_code, undefined);
    assert.equal(removed, 1);
  });
}));

test('the controller resolves child MCP assets under the deployed profile and rejects credentials', () => fixture(async options => {
  const profile = join(options.profiles, 'reviewer');
  const configPath = join(profile, 'agent-task.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.task.tool_selection = { tool_ids: [] };
  config.task.subagents = [{
    name: 'reviser', description: 'Revise', prompt: 'Revise.', tool_selection: { tool_ids: ['mcp'] },
    mcp_config_path: 'child-mcp.json',
  }];
  await writeFile(configPath, JSON.stringify(config));
  let started;
  const docker = { async start(task) { started = task; } };
  await callApi(options, docker, async request => {
    const submit = () => request('/v1/tasks', { method: 'POST', body: JSON.stringify({ profile: 'reviewer', prompt: 'Run' }) });
    const path = join(profile, 'child-mcp.json');
    await writeFile(path, JSON.stringify({ fixture: { url: 'http://gateway/mcp', headers: { Authorization: 'fixture' } } }));
    assert.equal((await submit()).status, 500);
    assert.equal(started, undefined);
    await writeFile(path, JSON.stringify({ fixture: { url: 'http://gateway/mcp' } }));
    assert.equal((await submit()).status, 500);
    await writeFile(path, JSON.stringify({
      fixture: { transport: 'streamable-http', url: 'http://gateway/mcp' },
    }));
    const response = await submit();
    assert.equal(response.status, 202, await response.clone().text());
    const worker = JSON.parse(await readFile(started.config, 'utf8'));
    assert.equal(worker.task.subagents[0].mcp_config_path, '/profile/child-mcp.json');
  });
}));

test('authentication and validation reject requests before creating a container', () => fixture(async options => {
  const docker = {
    async start() { assert.fail('Invalid submission started a worker'); },
  };
  await callApi(options, docker, async request => {
    const submit = (data, headers) => request('/v1/tasks', { method: 'POST', body: JSON.stringify(data), headers });
    const input = { profile: 'reviewer', prompt: 'Review' };
    assert.equal((await submit(input, { Authorization: 'Bearer incorrect' })).status, 401);
    assert.equal((await submit({ ...input, profile: '../reviewer' })).status, 400);
    assert.equal((await submit({ ...input, profile: 'missing' })).status, 404);
    assert.equal((await submit({ ...input, image: 'another-image' })).status, 400);
    assert.equal((await submit({ ...input, files: { 'a.txt': '1', 'A.TXT': '2' } })).status, 400);
    assert.equal((await submit({ ...input, files: { '../state.json': '1' } })).status, 400);
    assert.equal((await submit({ ...input, prompt: 'x'.repeat(1024 * 1024) })).status, 413);
  });
}));

test('a temporary Docker outage preserves the task and concurrent polls reconcile a failed exit once', () => fixture(async options => {
  let unavailable = true;
  let removed = 0;
  const docker = {
    async start() {},
    async inspect() {
      if (unavailable) throw new Error('Docker connection unavailable');
      return { status: 'exited', exitCode: 2 };
    },
    async remove() { removed += 1; },
  };
  await callApi(options, docker, async request => {
    const submitted = await request('/v1/tasks', {
      method: 'POST', body: JSON.stringify({ profile: 'reviewer', prompt: 'Review' }),
    });
    assert.equal(submitted.status, 202, await submitted.clone().text());
    const location = submitted.headers.get('location');
    assert.equal((await request(location)).status, 503);
    unavailable = false;
    const responses = await Promise.all([request(location), request(location)]);
    for (const response of responses) {
      const task = await response.json();
      assert.equal(task.status, 'failed');
      assert.equal(task.exit_code, 2);
    }
    assert.equal(removed, 1);
  });
}));

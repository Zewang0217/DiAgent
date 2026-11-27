/** 宿主只读技能快照与镜像内置技能使用同一原生技能提供器。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadTaskConfig } from '../dist/task/config.js';
import { writeTaskProfile } from '../dist/dsh/profile.js';

async function fixture(context) {
  await mkdir(resolve('.cache'), { recursive: true });
  const directory = await mkdtemp(resolve('.cache/custom-skills-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'work');
  const primary = join(directory, 'bundled');
  const custom = join(directory, 'snapshot/policy');
  await mkdir(workspace);
  await mkdir(join(directory, 'home'));
  await mkdir(join(primary, 'docx'), { recursive: true });
  await mkdir(custom, { recursive: true });
  await writeFile(join(primary, 'docx/SKILL.md'), '---\nname: docx\ndescription: fixture\n---\nBundled skill.');
  await writeFile(join(custom, 'SKILL.md'), '---\nname: policy\ndescription: fixture policy\n---\nApproved custom policy.');
  const path = join(directory, 'task.json');
  await writeFile(path, JSON.stringify({
    models: { default_model: 'fixture', models: { fixture: {
      provider: 'openai', model: 'fixture', base_url: 'http://127.0.0.1:8765/v1', api_key: 'task-grant',
    } } },
    task: { task: '读取授权技能', workspace, tool_selection: { tool_ids: ['skill'] },
      skills_dir: primary, skill_names: ['docx'], extra_skill_roots: [custom] },
  }));
  return { directory, custom, env: { TASK_CONFIG: path, DIAGENT_ENABLE_DIOS_EVENTS: 'false', DIAGENT_TASK_CUSTOM_SKILLS: 'true' } };
}

test('approved custom snapshot augments the selected bundled skill roots', async context => {
  const { directory, custom, env } = await fixture(context);

  const config = await loadTaskConfig(env);
  const profile = await writeTaskProfile(config, join(directory, 'home'), join(config.workspace, 'output/run-task'));
  const rows = JSON.parse(await readFile(profile, 'utf8'));

  assert.deepEqual(config.extraSkillRoots, [custom]);
  assert.ok(rows.find(row => row.id === 'skill-filesystem').config.customSkillDirs.includes(custom));
});

test('task configuration cannot self-authorize extra host skill roots', async context => {
  const { env } = await fixture(context);

  await assert.rejects(loadTaskConfig({ ...env, DIAGENT_TASK_CUSTOM_SKILLS: '' }), /managed.*skill/i);
});

test('real DSH discovers and reads the approved custom skill', {
  skip: process.platform !== 'linux', timeout: 30000,
}, async context => {
  const { env } = await fixture(context);
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const loaded = body.messages.some(message => message.role === 'tool' && message.content?.includes('Approved custom policy.'));
    const delta = loaded ? { content: 'CUSTOM_SKILL_SEEN' } : { tool_calls: [{
      index: 0, type: 'function', id: 'read-custom-policy',
      function: { name: 'skill', arguments: JSON.stringify({ name: 'policy' }) },
    }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [part, reason] of [[{ role: 'assistant' }, null], [delta, null], [{}, loaded ? 'stop' : 'tool_calls']]) {
      response.write('data: ' + JSON.stringify({
        id: 'skill-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
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
  const configuration = JSON.parse(await readFile(env.TASK_CONFIG, 'utf8'));
  configuration.models.models.fixture.base_url = 'http://127.0.0.1:' + server.address().port + '/v1';
  await writeFile(env.TASK_CONFIG, JSON.stringify(configuration));

  const result = await promisify(execFile)(process.execPath, [resolve('dist/task/main.js')], {
    cwd: process.cwd(), timeout: 25000, env: { ...process.env, ...env, DIAGENT_TASK_TIMEOUT_MS: '20000' },
  });

  const completed = /\[complete\] (.+)/.exec(result.stdout);
  assert.ok(completed);
  assert.equal(await readFile(completed[1].trim(), 'utf8'), 'CUSTOM_SKILL_SEEN');
  assert.equal(requests.length, 2);
});

/** 通过真实 DSH 子进程验证一次性任务，模型和 MCP 服务使用本机模拟端点。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtempDisposable, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeTaskProfile } from '../dist/dsh/profile.js';
import { loadTaskConfig } from '../dist/task/config.js';

const project = fileURLToPath(new URL('../', import.meta.url));

async function officeProfileRows({ toolIds, subagents = [] } = {}) {
  const cacheDir = join(project, '.cache');
  await mkdir(cacheDir, { recursive: true });
  await using home = await mkdtempDisposable(join(cacheDir, 'diagent-office-profile-'));
  const profile = await writeTaskProfile({
    model: { name: 'fixture-model', baseURL: 'http://model.test/v1', apiKey: 'fixture' },
    workspace: home.path, systemPrompt: 'Fixture assistant', temperature: 0,
    skillsDir: join(home.path, 'skills'), skillNames: [], mcpToolNames: [], subagents, toolIds,
    isDiosEventPublishingEnabled: false,
  }, home.path, home.path);
  return JSON.parse(await readFile(profile, 'utf8'));
}

test('the default task profile keeps the SDK Office tools and skills available', async () => {
  const rows = await officeProfileRows();
  const disabled = rows.filter(row => row.disabled).map(row => row.id);
  assert.ok(!disabled.includes('skill-office'), 'The default task must discover the Office skills');
  assert.ok(!disabled.includes('tool-office'), 'The default task must expose the Office tools after skill activation');
});

test('an explicit task tool selection keeps the bundled Office skills and tools closed', async () => {
  const rows = await officeProfileRows({ toolIds: ['skill'] });
  const disabled = rows.filter(row => row.disabled).map(row => row.id);
  assert.ok(disabled.includes('skill-office'), 'Selecting custom Skills must preserve the assigned Skill catalogue');
  assert.ok(disabled.includes('tool-office'), 'The Office tools require an applicable tool grant');
});

test('a task with named subagents does not register globally visible Office skills', async () => {
  const rows = await officeProfileRows({ subagents: [{
    name: 'reviewer', description: 'Review a draft', prompt: 'Review the draft', toolIds: [], skillNames: [],
  }] });
  assert.equal(rows.find(row => row.id === 'skill-office').disabled, true);
});

async function officeTaskConfig({ subagents, managed = true } = {}) {
  const cacheDir = join(project, '.cache');
  await mkdir(cacheDir, { recursive: true });
  await using workspace = await mkdtempDisposable(join(cacheDir, 'diagent-office-config-'));
  const path = join(workspace.path, 'task.json');
  await writeFile(path, JSON.stringify({
    models: { default_model: 'fixture', models: { fixture: {
      provider: 'openai', model: 'fixture-model', base_url: 'http://model.test/v1',
    } } },
    task: { task: 'Edit the attached deck', workspace: workspace.path, subagents,
      tool_selection: { tool_ids: ['office'] } },
  }));
  return await loadTaskConfig({
    TASK_CONFIG: path, DIAGENT_TASK_MODEL_REFRESH_PATH: managed ? join(workspace.path, 'refresh.json') : '',
  });
}

test('the explicit Office grant loads bundled tools without loading custom Skills', async () => {
  const config = await officeTaskConfig();
  const rows = await officeProfileRows({ toolIds: config.toolIds });
  const disabled = rows.filter(row => row.disabled).map(row => row.id);
  assert.equal(disabled.includes('skill-office'), false);
  assert.equal(disabled.includes('tool-office'), false);
  assert.deepEqual(rows.find(row => row.id === 'skill-filesystem').config.customSkillDirs, []);
  const selection = rows.at(-1).insert.find(row => row.id === 'diagent-tool-selection');
  assert.deepEqual(selection.config.toolIds, ['skill', 'office_convert', 'office_render', 'office_recalculate']);
});

test('the explicit Office grant requires the managed task model bridge', async () => {
  await assert.rejects(officeTaskConfig({ managed: false }), /Office tools require the managed task model bridge/);
});

test('the explicit Office grant rejects roles that would share the bundled Skill provider', async () => {
  await assert.rejects(officeTaskConfig({ subagents: [{
    name: 'reviewer', description: 'Review a draft', prompt: 'Review the draft',
    tool_selection: { tool_ids: [] },
  }] }), /Office tools cannot be enabled with named subagents/);
});

function namedReviewReply(messages) {
  const childPersona = messages.find(message => message.role === 'system'
    && message.content?.includes('Reviewer fixture persona'));
  const toolResults = messages.filter(message => message.role === 'tool').map(message => message.content);
  if (childPersona) {
    if (toolResults.length) return 'reviewer-result: ' + toolResults.join('\n');
    if (childPersona.content.includes('Use assigned Skill fixture')) {
      return [['skill', { name: 'review-skill' }], ['skill', { name: 'smoke-skill' }]];
    }
    if (childPersona.content.includes('Write an artifact fixture')) {
      const runDirectory = childPersona.content.match(/本次任务的产物目录：([^\n]+)/)?.[1];
      if (!runDirectory) return 'reviewer-result: missing run directory';
      return [['write', { file_path: join(runDirectory, 'reviewer-report.md'), content: 'reviewer artifact fixture' }]];
    }
    return [
      ['read', { file_path: 'skills/smoke-skill/SKILL.md' }],
      ['write', { file_path: 'unauthorized-review.txt', content: 'must not be written' }],
    ];
  }
  const reviewCompletion = messages.find(message => message.role === 'user' && message.content?.includes('reviewer-result:'));
  if (reviewCompletion) {
    return reviewCompletion.content;
  }
  return toolResults.length ? [['wait_agent', { timeout_ms: 10000 }]]
    : [['delegate_reviewer', { name: 'reviewer', description: 'Review fixture file', prompt: 'Review the fixture file.' }]];
}

function namedMcpReply(messages) {
  const role = messages.find(message => message.role === 'system')
    ?.content?.match(/MCP child (alpha|beta)/)?.[1];
  const results = messages.filter(message => message.role === 'tool').map(message => message.content);
  if (role) {
    return results.length ? `${role}-result: ${results.join('\n')}` : [
      [`mcp__scope__${role}`, {}], [`mcp__scope__${role === 'alpha' ? 'beta' : 'alpha'}`, {}],
    ];
  }
  const alpha = messages.find(message => message.role === 'user' && message.content?.includes('alpha-result:'));
  const beta = messages.find(message => message.role === 'user' && message.content?.includes('beta-result:'));
  if (alpha && beta) return alpha.content + '\n' + beta.content;
  const next = alpha ? 'beta' : 'alpha';
  return results.includes(`started subagent ${next}`) ? [['wait_agent', { timeout_ms: 10000 }]]
    : [[`delegate_${next}`, { name: next, description: 'Read the assigned source', prompt: 'Read your source.' }]];
}

function officeReply(toolResults, outsideDocument) {
  if (toolResults.length === 0) return [['skill', { name: 'office-pptx' }]];
  if (toolResults.length === 1) return [
    ['skill', { name: 'smoke-skill' }],
    ['office_convert', { input: outsideDocument, format: 'pdf' }],
  ];
  return toolResults.map(message => message.content).join('\n');
}

test('DSH task preserves the input, MCP and result contract with DiOS events disabled', { timeout: 120_000 }, async () => {
  const cacheDir = join(project, '.cache');
  await mkdir(cacheDir, { recursive: true });
  await using scratch = await mkdtempDisposable(join(cacheDir, 'diagent-smoke-'));
  await using outside = await mkdtempDisposable(join(cacheDir, 'diagent-outside-'));
  const workspace = scratch.path;
  const outsideRead = join(outside.path, 'outside.txt');
  await writeFile(outsideRead, 'fixture outside the workspace');
  const outsideDocument = join(outside.path, 'outside.docx');
  await writeFile(outsideDocument, 'fixture document outside the workspace');
  const skillDirectory = join(workspace, 'skills', 'smoke-skill');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'),
    '---\nname: smoke-skill\ndescription: DiAgent smoke skill marker\n---\nTest instructions.\n');
  const reviewSkillDirectory = join(workspace, 'skills', 'review-skill');
  await mkdir(reviewSkillDirectory, { recursive: true });
  await writeFile(join(reviewSkillDirectory, 'SKILL.md'),
    '---\nname: review-skill\ndescription: Reviewer skill marker\n---\nReview Skill loaded.\n');

  const modelRequests = [];
  const mcpRequests = [];
  const refreshCalls = [];
  const refreshFile = join(workspace, 'refresh-private.json');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/v1/grants/refresh') {
      refreshCalls.push(request.headers.authorization === 'Bearer ' + 'r'.repeat(43));
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: 'a'.repeat(43) }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (['/mcp', '/mcp-alpha', '/mcp-beta'].includes(request.url)) {
      const role = request.url.split('-')[1];
      mcpRequests.push({ method: body.method, name: body.params?.name, authorization: request.headers.authorization, role });
      // 模拟工具发现晚于连接建立。测试直接检查模型首轮请求里的工具声明。
      if (body.method === 'tools/list') await delay(1500);
      const results = {
        initialize: { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'smoke', version: '1' },
          instructions: role ? `MCP instructions for ${role} only` : 'MCP instructions for parent only' },
        'tools/list': { tools: role ? [{ name: role, description: 'Look up the role source',
          inputSchema: { type: 'object', properties: {} } }] : [{ name: 'lookup', description: 'Look up a test value',
          inputSchema: { type: 'object', properties: {} } }, {
          name: 'unselected', description: 'An MCP tool excluded by task configuration',
          inputSchema: { type: 'object', properties: {} },
        }] },
        'tools/call': { content: [{ type: 'text', text: role ? `mcp-${role}-ok` : 'mcp-ok' }] },
      };
      if (body.id === undefined) {
        response.writeHead(202).end();
      } else if (Object.hasOwn(results, body.method)) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] }));
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
      }
      return;
    }

    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    if (body.messages.some(message => message.content === 'refresh-smoke')) {
      const isContinuation = body.messages.some(message => message.role === 'tool');
      const expected = isContinuation ? 'a'.repeat(43) : 'smoke-model-key';
      if (request.headers.authorization !== 'Bearer ' + expected) {
        response.writeHead(401).end();
        return;
      }
    }
    modelRequests.push(body);
    if (body.messages.some(message => message.role === 'user' && message.content === 'fail-smoke')) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'intentional provider failure' } }));
      return;
    }

    const toolResults = body.messages.filter(message => message.role === 'tool');
    const isBudgetTask = body.messages.some(message => message.role === 'user' && message.content === 'tool-budget');
    const isSelectionTask = body.messages.some(message => message.role === 'user' && message.content === 'selected-mcp');
    const isTextTask = body.messages.some(message => message.role === 'user' && message.content === 'selected-task-tools');
    const isManagedToolTask = body.messages.some(message => message.role === 'user' && message.content === 'managed-tools');
    const isOfficeTask = body.messages.some(message => message.role === 'user' && message.content === 'managed-office');
    const isNamedReview = body.messages.some(message => message.content?.includes('Reviewer fixture persona')
      || message.content === 'named-review');
    const isNamedMcp = body.messages.some(message => message.content?.includes('MCP child ')
      || message.content === 'named-mcp');
    const shellPrompt = body.messages.find(message => message.role === 'user' && message.content.startsWith('legacy-shell'));
    const isCredentialTask = shellPrompt?.content === 'legacy-shell-credentials';
    const isUnconfiguredCredentialTask = shellPrompt?.content === 'legacy-shell-unconfigured';
    const isShellTask = Boolean(shellPrompt);
    const hasToolResult = toolResults.length > 0;
    const toolCall = { index: 0, id: 'call-smoke', type: 'function',
      function: { name: 'mcp__smoke__lookup', arguments: '{}' } };
    const fixtureReply = isNamedReview ? namedReviewReply(body.messages) : isNamedMcp ? namedMcpReply(body.messages)
      : isOfficeTask ? officeReply(toolResults, outsideDocument) : undefined;
    const needsTool = isNamedReview || isNamedMcp || isOfficeTask ? Array.isArray(fixtureReply)
      : !isTextTask && (isBudgetTask ? toolResults.length < 3 : !hasToolResult);
    const toolCalls = isManagedToolTask ? [
      ['shell', { command: 'test -z "$DIAGENT_TASK_MODEL_REFRESH_PATH" && test ! -e refresh-private.json && printf shell-ok' }],
      ['read', { file_path: 'skills/smoke-skill/SKILL.md' }],
      ['read', { file_path: outsideRead }],
      ['write', { file_path: 'managed-result.txt', content: 'authorized write' }],
      ['write', { file_path: join(outside.path, 'rejected.txt'), content: 'must not be written' }],
    ].map(([name, args], index) => ({ index, id: `call-managed-${index}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } })) : isShellTask ? [{ index: 0, id: 'call-legacy-shell', type: 'function',
      function: { name: 'shell', arguments: JSON.stringify({
        command: isCredentialTask
          ? [
            'test "$GIT_PLATFORM_TOKEN" = "$FIXTURE_EXPECTED_GIT_VALUE"',
            'test "$GIT_PLATFORM_BASE_URL:$GIT_REPO" = "https://example.test:org/repo"',
            'test "$GIT_USER_NAME:$GIT_USER_EMAIL" = "Fixture User:fixture@example.test"',
            'test -z "$DSH_DIAGENT_GIT_PLATFORM_TOKEN$DIAGENT_MODEL_API_KEY$DIAGENT_EVENT_ACCESS_TOKEN$UNRELATED_TOKEN"',
            'printf "credential-scope-ok"',
          ].join(' && ')
          : isUnconfiguredCredentialTask ? 'test -z "$GIT_PLATFORM_TOKEN" && printf "no-injected-credential"'
          : shellPrompt.content === 'legacy-shell-timeout' ? 'sleep 10'
          : "test -f SKILL.md || exit 9; printf 'shell-stdout'; printf 'shell-stderr' >&2; exit 7",
        ...(shellPrompt.content === 'legacy-shell' ? { cwd: 'skills/smoke-skill' } : {}),
        timeout: shellPrompt.content === 'legacy-shell-timeout' ? 1 : 5,
      }) } }, ...(isCredentialTask ? [{ index: 1, id: 'call-native-bash', type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({
        description: 'Check credentials are unavailable to native Bash',
        command: 'test -z "$GIT_PLATFORM_TOKEN$DSH_DIAGENT_GIT_PLATFORM_TOKEN" && printf "native-bash-clean"',
      }) } }] : [])] : isBudgetTask && !hasToolResult
      ? [toolCall, { ...toolCall, index: 1, id: 'call-smoke-second' }]
      : isSelectionTask ? [toolCall, { index: 1, id: 'call-unselected', type: 'function',
        function: { name: 'mcp__smoke__unselected', arguments: '{}' } }]
      : [{ ...toolCall, id: isBudgetTask ? 'call-smoke-next-round' : toolCall.id }];
    const fixtureCalls = Array.isArray(fixtureReply) ? fixtureReply.map(([name, args], index) => ({
      index, id: `call-role-${body.messages.length}-${index}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })) : undefined;
    const delta = needsTool ? { tool_calls: fixtureCalls ?? toolCalls } : {
      content: fixtureReply ?? (isBudgetTask || isShellTask || isManagedToolTask
        ? toolResults.map(message => message.content).join('\n') : 'pilot-ok'),
    };
    const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke-model' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [part, finish] of [[{ role: 'assistant' }, null], [delta, null], [{}, needsTool ? 'tool_calls' : 'stop']]) {
      response.write('data: ' + JSON.stringify({
        ...base, choices: [{ index: 0, delta: part, finish_reason: finish }],
      }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const baseURL = 'http://127.0.0.1:' + server.address().port;
  await writeFile(join(workspace, 'mcp.json'), JSON.stringify({
    smoke: { transport: 'streamable_http', url: baseURL + '/mcp', headers: { Authorization: 'Bearer smoke-mcp' } },
  }));

  async function run(prompt, label, mcpPath, taskOptions = {}, taskEnv = {}) {
    const taskConfig = join(workspace, label + '.json');
    const outputRoot = join(workspace, label);
    await writeFile(taskConfig, JSON.stringify({
      models: { default_model: 'alias', models: { alias: {
        provider: 'openai', model: 'smoke-model', base_url: baseURL + '/v1', api_key: 'smoke-model-key',
      } } },
      task: {
        task: prompt, workspace, system_prompt: 'Smoke system prompt.',
        skill_names: ['smoke-skill'], mcp_config_path: mcpPath, output_dir: outputRoot,
        output: { log_file: 'task.log', result_file: 'task_result.md' }, trigger: { mode: 'once' },
        ...taskOptions,
      },
    }));
    const child = spawn(process.execPath, ['dist/task/main.js'], {
      cwd: project,
      env: { ...process.env, TASK_CONFIG: taskConfig, OUTPUT_DIR: outputRoot, TRIGGER_MODE: 'once',
        DIAGENT_ENABLE_DIOS_EVENTS: 'false',
        DIAGENT_TASK_TIMEOUT_MS: '35000', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
        TMPDIR: workspace, TEMP: workspace, TMP: workspace, ...taskEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code === 2) return { code, output };
    const [runDirectory] = await readdir(outputRoot);
    return {
      code, output,
      runDirectory: join(outputRoot, runDirectory),
      result: await readFile(join(outputRoot, runDirectory, 'task_result.md'), 'utf8'),
      log: await readFile(join(outputRoot, runDirectory, 'task.log'), 'utf8'),
    };
  }

  try {
    if (process.platform === 'linux' && process.getuid() === 0) {
      await writeFile(refreshFile, JSON.stringify({ refresh_token: 'r'.repeat(43) }), { mode: 0o400 });
      const refreshed = await run('refresh-smoke', 'refreshed', 'mcp.json', { tool_selection: { tool_ids: ['mcp'] } },
        { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      assert.equal(refreshed.code, 0, refreshed.output);
      assert.equal(refreshed.result, 'pilot-ok');
      assert.deepEqual(refreshCalls, [true]);
      await assert.rejects(stat(refreshFile), { code: 'ENOENT' });
      await writeFile(refreshFile, JSON.stringify({ refresh_token: 'r'.repeat(43) }), { mode: 0o400 });
      const requestIndex = modelRequests.length;
      const tools = await run('managed-tools', 'managed', '', { tool_selection: { tool_ids: ['shell', 'read', 'write'] } },
        { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      assert.equal(tools.code, 0, tools.output);
      assert.deepEqual(modelRequests[requestIndex].tools.map(tool => tool.function.name).sort(), ['read', 'shell', 'write']);
      assert.match(tools.result, /shell-ok/);
      assert.match(tools.result, /Test instructions/);
      assert.doesNotMatch(tools.result, /fixture outside the workspace/);
      assert.equal(await readFile(join(workspace, 'managed-result.txt'), 'utf8'), 'authorized write');
      await assert.rejects(stat(join(outside.path, 'rejected.txt')), { code: 'ENOENT' });

      await writeFile(refreshFile, JSON.stringify({ refresh_token: 'r'.repeat(43) }), { mode: 0o400 });
      const officeRequest = modelRequests.length;
      const office = await run('managed-office', 'office', '', { tool_selection: { tool_ids: ['office', 'skill', 'shell'] } },
        { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      assert.equal(office.code, 0, office.output);
      const officeToolNames = request => request.tools.map(tool => tool.function.name).sort();
      assert.deepEqual(officeToolNames(modelRequests[officeRequest]), ['shell', 'skill']);
      assert.deepEqual(officeToolNames(modelRequests[officeRequest + 1]),
        ['office_convert', 'office_recalculate', 'office_render', 'shell', 'skill']);
      assert.match(office.result, /python-pptx/);
      assert.match(office.result, /Test instructions/);
      assert.match(office.result, /Task file tools only operate inside the workspace/);

      const reviewer = {
        name: 'reviewer', description: 'Review the submitted artifact',
        prompt: 'Reviewer fixture persona', tool_selection: { tool_ids: ['read'] },
      };
      const reviewOptions = {
        recursion_limit: 12,
        subagents: [reviewer],
      };
      const reviewRequestIndex = modelRequests.length;
      await writeFile(refreshFile, JSON.stringify({ refresh_token: 'r'.repeat(43) }), { mode: 0o400 });
      const review = await run('named-review', 'named-review', '', {
        ...reviewOptions, tool_selection: { tool_ids: ['read', 'write'] },
      }, { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      const reviewRequests = modelRequests.slice(reviewRequestIndex);
      assert.equal(review.code, 0, review.output + JSON.stringify(reviewRequests.map(request => ({
        tools: request.tools?.map(tool => tool.function.name),
        results: request.messages.filter(message => message.role === 'tool').map(message => message.content),
      }))));
      const childRequests = reviewRequests.filter(request => request.messages.some(message =>
        message.role === 'system' && message.content?.includes('Reviewer fixture persona')));
      const parentTools = reviewRequests[0].tools.map(tool => tool.function.name).sort();
      assert.deepEqual(parentTools, ['delegate_reviewer', 'read', 'wait_agent', 'write']);
      assert.ok(childRequests.length > 0, 'The model must receive the reviewer system prompt');
      for (const request of childRequests) {
        assert.deepEqual(request.tools.map(tool => tool.function.name), ['read']);
        assert.equal(request.model, reviewRequests[0].model);
        assert.ok(!request.messages.some(message => message.role === 'system'
          && message.content?.includes('Smoke system prompt.')));
      }
      assert.match(JSON.stringify(reviewRequests[0].messages), /Review the submitted artifact/);
      assert.match(review.result, /reviewer-result: .*Test instructions/s);
      assert.match(review.result, /unknown tool "write"/);
      await assert.rejects(stat(join(workspace, 'unauthorized-review.txt')), { code: 'ENOENT' });

      const legacyRequestIndex = modelRequests.length;
      await writeFile(refreshFile, JSON.stringify({ refresh_token: 'r'.repeat(43) }), { mode: 0o400 });
      const legacyReview = await run('named-review', 'legacy-named-review', '', reviewOptions,
        { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      assert.equal(legacyReview.code, 0, legacyReview.output);
      const legacyTools = modelRequests[legacyRequestIndex].tools.map(tool => tool.function.name);
      assert.ok(legacyTools.includes('delegate_reviewer'));
      assert.ok(legacyTools.includes('write'));
      assert.ok(!legacyTools.includes('subagent') && !legacyTools.includes('subagent_fork'));
      assert.match(legacyReview.result, /reviewer-result: .*Test instructions/s);
      await assert.rejects(stat(join(workspace, 'unauthorized-review.txt')), { code: 'ENOENT' });

      const emptyRootRequestIndex = modelRequests.length;
      await writeFile(refreshFile, JSON.stringify({ refresh_token: 'r'.repeat(43) }), { mode: 0o400 });
      const emptyRootReview = await run('named-review', 'delegation-only', '', {
        ...reviewOptions, tool_selection: { tool_ids: [] },
        subagents: [{
          ...reviewer, prompt: reviewer.prompt + '. Write an artifact fixture.',
          tool_selection: { tool_ids: ['write'] },
        }],
      }, { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      assert.equal(emptyRootReview.code, 0, emptyRootReview.output);
      assert.deepEqual(modelRequests[emptyRootRequestIndex].tools.map(tool => tool.function.name).sort(),
        ['delegate_reviewer', 'wait_agent']);
      assert.match(emptyRootReview.result, /reviewer-result:/);
      assert.equal(await readFile(join(emptyRootReview.runDirectory, 'reviewer-report.md'), 'utf8'), 'reviewer artifact fixture');

      const oldToolList = await run('named-review', 'legacy-tool-list', '', {
        ...reviewOptions, subagents: [{
          name: reviewer.name, description: reviewer.description, prompt: reviewer.prompt, tools: ['read'],
        }],
      }, { DIAGENT_TASK_MODEL_REFRESH_PATH: refreshFile });
      assert.equal(oldToolList.code, 2, oldToolList.output);
      assert.match(oldToolList.output, /task\.subagents\[0\]\.tools is a legacy tool list/);

      const noToolsReview = await run('named-review', 'tool-free-review', '', {
        ...reviewOptions, tool_selection: { tool_ids: [] },
        subagents: [{ ...reviewer, tool_selection: { tool_ids: [] } }],
      }, { DIAGENT_TASK_MODEL_REFRESH_PATH: '' });
      assert.equal(noToolsReview.code, 0, noToolsReview.output);
      assert.match(noToolsReview.result, /unknown tool "read"/);
      await assert.rejects(stat(join(workspace, 'unauthorized-review.txt')), { code: 'ENOENT' });
      modelRequests.length = 0;
      mcpRequests.length = 0;
    }
    const success = await run('/literal-smoke', 'success', 'mcp.json');
    assert.equal(success.code, 0, success.output);
    assert.equal(success.result, 'pilot-ok');
    assert.match(success.log, /\[complete\]/);
    assert.equal(modelRequests[0].model, 'smoke-model');
    assert.ok(modelRequests[0].tools?.some(tool => tool.function.name === 'mcp__smoke__lookup'),
      'The first model request must include the MCP tool after initial discovery');
    assert.match(JSON.stringify(modelRequests[0].messages), /Smoke system prompt/);
    assert.ok(modelRequests[0].messages.some(message => message.role === 'user' && message.content === '/literal-smoke'));
    assert.match(JSON.stringify(modelRequests[0]), /DiAgent smoke skill marker/);
    assert.ok(modelRequests.some(request => request.messages.some(message =>
      message.role === 'tool' && message.content.includes('mcp-ok'))));
    assert.ok(mcpRequests.some(request => request.method === 'tools/call' && request.authorization === 'Bearer smoke-mcp'));

    const skillRequestIndex = modelRequests.length;
    const scopedSkills = await run('named-review', 'role-skills', '', {
      tool_selection: { tool_ids: ['skill'] },
      subagents: [{
        name: 'reviewer', description: 'Review with a Skill',
        prompt: 'Reviewer fixture persona. Use assigned Skill fixture.',
        tool_selection: { tool_ids: ['skill'] }, skill_names: ['review-skill'],
      }],
    });
    assert.equal(scopedSkills.code, 0, scopedSkills.output);
    const skillRequests = modelRequests.slice(skillRequestIndex);
    const childSkillRequest = skillRequests.find(request => request.messages.some(message =>
      message.role === 'system' && message.content?.includes('Reviewer fixture persona')));
    assert.match(JSON.stringify(skillRequests[0]), /DiAgent smoke skill marker/);
    assert.doesNotMatch(JSON.stringify(skillRequests[0]), /Reviewer skill marker/);
    assert.match(JSON.stringify(childSkillRequest), /Reviewer skill marker/);
    assert.doesNotMatch(JSON.stringify(childSkillRequest), /DiAgent smoke skill marker/);
    assert.match(scopedSkills.result, /Review Skill loaded/);
    assert.doesNotMatch(scopedSkills.result, /Test instructions/);
    const defaultRootRequestIndex = modelRequests.length;
    const childOnlySkills = await run('named-review', 'child-only-skills', '', {
      skill_names: [],
      subagents: [{
        name: 'reviewer', description: 'Review with a Skill',
        prompt: 'Reviewer fixture persona. Use assigned Skill fixture.',
        tool_selection: { tool_ids: ['skill'] }, skill_names: ['review-skill'],
      }],
    });
    assert.equal(childOnlySkills.code, 0, childOnlySkills.output);
    assert.doesNotMatch(JSON.stringify(modelRequests[defaultRootRequestIndex]), /Reviewer skill marker/);

    const roles = ['alpha', 'beta'];
    for (const name of roles) {
      await writeFile(join(workspace, name + '-mcp.json'), JSON.stringify({
        scope: { transport: 'streamable-http', url: baseURL + '/mcp-' + name },
      }));
    }
    const mcpRequestIndex = modelRequests.length;
    const scopedMcp = await run('named-mcp', 'role-mcp', 'mcp.json', {
      tool_selection: { tool_ids: ['mcp'] }, tools: ['lookup'],
      subagents: roles.map(name => ({
        name, description: 'Consult ' + name, prompt: 'MCP child ' + name,
        tool_selection: { tool_ids: ['mcp'] }, mcp_config_path: name + '-mcp.json',
      })),
    });
    assert.equal(scopedMcp.code, 0, scopedMcp.output);
    const roleRequests = modelRequests.slice(mcpRequestIndex);
    const toolNames = request => request.tools.map(tool => tool.function.name).sort();
    assert.deepEqual(toolNames(roleRequests[0]), ['delegate_alpha', 'delegate_beta', 'mcp__smoke__lookup', 'wait_agent']);
    assert.match(JSON.stringify(roleRequests[0].messages), /MCP instructions for parent only/);
    for (const name of roles) {
      const requests = roleRequests.filter(request => request.messages.some(message =>
        message.role === 'system' && message.content?.includes('MCP child ' + name)));
      assert.ok(requests.length, name + ' must run');
      assert.deepEqual(toolNames(requests[0]), [`mcp__scope__${name}`]);
      assert.match(JSON.stringify(requests[0].messages), new RegExp(`MCP instructions for ${name} only`));
      assert.doesNotMatch(JSON.stringify(requests[0].messages), /MCP instructions for parent only/);
      assert.match(scopedMcp.result, new RegExp(`mcp-${name}-ok`));
    }
    const childCalls = mcpRequests.filter(request => request.role && request.method === 'tools/call');
    assert.deepEqual(childCalls.map(({ role, name }) => [role, name]), [['alpha', 'alpha'], ['beta', 'beta']]);

    const mcpRequestCount = mcpRequests.length;
    for (const [label, toolIds] of [['text-only', []], ['skill-only', ['skill']]]) {
      const requestIndex = modelRequests.length;
      const selected = await run('selected-task-tools', label, 'does-not-exist.json', {
        tool_selection: { tool_ids: toolIds },
      });
      assert.equal(selected.code, 0, selected.output);
      assert.equal(selected.result, 'pilot-ok');
      assert.deepEqual(modelRequests[requestIndex].tools?.map(tool => tool.function.name) ?? [], toolIds);
    }
    assert.equal(mcpRequests.length, mcpRequestCount);

    const failure = await run('fail-smoke', 'failure', '');
    assert.equal(failure.code, 1, failure.output);
    assert.match(failure.result, /任务执行失败/);
    assert.match(failure.log, /\[error\]/);
    assert.doesNotMatch(success.output + failure.output + success.log + failure.log, /smoke-model-key|smoke-mcp/);

    const previousCalls = mcpRequests.filter(request => request.method === 'tools/call').length;
    const budget = await run('tool-budget', 'budget', 'mcp.json', { max_tool_rounds: 1 });
    assert.equal(budget.code, 0, budget.output);
    assert.equal(mcpRequests.filter(request => request.method === 'tools/call').length - previousCalls, 2);
    assert.match(budget.result, /max_tool_rounds/);

    const invalidBudget = await run('tool-budget', 'invalid-budget', 'mcp.json', { max_tool_rounds: 0 });
    assert.equal(invalidBudget.code, 2, invalidBudget.output);
    assert.match(invalidBudget.output, /task\.max_tool_rounds must be a positive integer/);

    const requestCount = modelRequests.length;
    const selected = await run('selected-mcp', 'selected', 'mcp.json', { tools: ['lookup'], temperature: 0 });
    assert.equal(selected.code, 0, selected.output);
    assert.equal(selected.result, 'pilot-ok');
    const visibleTools = modelRequests[requestCount].tools.map(tool => tool.function.name);
    assert.deepEqual(visibleTools.filter(name => name.startsWith('mcp__')), ['mcp__smoke__lookup']);
    assert.ok(visibleTools.includes('read'), 'Selecting MCP tools must preserve the built-in file reader');
    assert.ok(!mcpRequests.some(request => request.name === 'unselected'),
      'Calling a hidden tool must not reach the MCP server');
    assert.equal(modelRequests[0].temperature, 0.7, 'Omitting temperature must preserve the legacy task default');
    assert.deepEqual(modelRequests.slice(requestCount).map(request => request.temperature), [0, 0],
      'Explicit zero temperature must be sent for the initial request and tool continuation');

    const managedRequestIndex = modelRequests.length;
    const explicitMcp = await run('selected-mcp', 'task-mcp-only', 'mcp.json', {
      tool_selection: { tool_ids: ['mcp'] }, tools: ['lookup'],
    });
    assert.equal(explicitMcp.code, 0, explicitMcp.output);
    assert.deepEqual(modelRequests[managedRequestIndex].tools.map(tool => tool.function.name), ['mcp__smoke__lookup']);

    const ambiguous = await run('selected-mcp', 'ambiguous', 'mcp.json', { tools: ['lookup_000000000000'] });
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.output + (ambiguous.log ?? ''), /alias ambiguity/);

    if (process.platform === 'linux') {
      const shellRequest = modelRequests.length;
      const shell = await run('legacy-shell', 'shell', '', { max_tool_rounds: 1 });
      assert.equal(shell.code, 0, shell.output);
      assert.ok(modelRequests[shellRequest].tools.some(tool => tool.function.name === 'shell'));
      assert.equal(shell.result, 'exit_code: 7\nstdout:\nshell-stdout\nstderr:\nshell-stderr');
      const timedOut = await run('legacy-shell-timeout', 'shell-timeout', '');
      assert.equal(timedOut.code, 0, timedOut.output);
      assert.equal(timedOut.result, 'exit_code: -1\nstdout:\n\nstderr:\ncommand timed out after 1s');
      await writeFile(join(workspace, '.env'), 'GIT_PLATFORM_TOKEN=fixture-workspace-credential\n');
      const credentialRequest = modelRequests.length;
      const fakeGitValue = "fixture-git-credential ' \" $ ` \\";
      const credentials = await run('legacy-shell-credentials', 'shell-credentials', '', {}, {
        GIT_PLATFORM_TOKEN: fakeGitValue,
        FIXTURE_EXPECTED_GIT_VALUE: fakeGitValue,
        GIT_PLATFORM_BASE_URL: 'https://example.test',
        GIT_REPO: 'org/repo',
        GIT_USER_NAME: 'Fixture User',
        GIT_USER_EMAIL: 'fixture@example.test',
        DIAGENT_EVENT_ACCESS_TOKEN: 'fixture-event-credential',
        UNRELATED_TOKEN: 'fixture-unrelated-credential',
      });
      assert.equal(credentials.code, 0, credentials.output);
      assert.match(credentials.result, /^exit_code: 0\nstdout:\ncredential-scope-ok\nstderr:\n/);
      assert.match(credentials.result, /native-bash-clean/);
      assert.doesNotMatch(JSON.stringify(modelRequests.slice(credentialRequest)) + credentials.output + credentials.log + credentials.result,
        /fixture-(git|workspace|event|unrelated)-credential/);

      const unconfigured = await run('legacy-shell-unconfigured', 'shell-unconfigured', '', {}, {
        GIT_PLATFORM_TOKEN: '',
      });
      assert.equal(unconfigured.code, 0, unconfigured.output);
      assert.equal(unconfigured.result, 'exit_code: 0\nstdout:\nno-injected-credential\nstderr:\n');
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

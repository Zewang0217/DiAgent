/** 验证 DiOS 用来探测常驻 DiAgent 的 HTTP 契约。 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeChatProfile } from '../dist/dsh/profile.js';
import { createServiceServer } from '../dist/service/server.js';

test('the default Chat profile gives DSH an explicit empty tool and Skill selection', async () => {
  await mkdir('.cache', { recursive: true });
  await using home = await mkdtempDisposable(join(process.cwd(), '.cache', 'diagent-chat-profile-'));
  const path = await writeChatProfile({
    model: { name: 'fixture-model', baseURL: 'http://model.test/v1', apiKey: 'fixture' },
    personaPrefix: 'Fixture assistant', temperature: 0.7,
    skillsDir: join(home.path, 'skills'), skillNames: [], toolIds: [],
    mcpPlugins: [], history: [], streamText: false,
  }, home.path);
  const rows = JSON.parse(await readFile(path, 'utf8'));
  const skills = rows.find(row => row.id === 'skill-filesystem');
  const entries = rows.flatMap(row => row.insert ?? []);
  const selection = entries.find(row => row.id === 'diagent-tool-selection');
  assert.deepEqual(skills.config, { includeDefaultRoots: false, customSkillDirs: [], watch: false });
  assert.deepEqual(selection.config, { toolIds: [], mcpServerNames: [] });
  assert.equal(rows.find(row => row.id === 'session-log-deepseek').disabled, true);
  assert.deepEqual(entries.map(row => row.id), ['diagent-tool-selection', 'diagent-task-temperature']);
});

test('GET /health reports the service is alive', async () => {
  const server = createServiceServer();
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'healthy' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

async function withChatFixture(run, {
  beforeFinish, interrupt = false, fixtureTool, env, catalogCredential, legacyCatalog, modelProxy,
  replyFor = () => 'A2A reply', onModelClose, skills = {}, mcp,
} = {}) {
  await mkdir('.cache', { recursive: true });
  await using workspace = await mkdtempDisposable(join(process.cwd(), '.cache', 'diagent-chat-'));
  const received = [];
  const modelProxyPath = mcp ? '/api/internal/model-proxy/v1' : '/v1';
  const skillsRoot = join(workspace.path, 'skills');
  for (const [name, instructions] of Object.entries(skills)) {
    const path = join(skillsRoot, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} catalog fixture\n---\n${instructions}\n`);
  }
  await using model = createServer(async (request, response) => {
    if (onModelClose) response.once('close', () => onModelClose(response.writableEnded));
    if (mcp && request.url === '/api/internal/e2ag/mcp/' + mcp.grantId) {
      await mcp.handle(request, response);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (modelProxy && request.url === modelProxyPath + '/grants/check') {
      assert.deepEqual(input, { agent_id: 'fixture-agent', model: 'fixture-model' });
      if (mcp && request.headers.authorization === 'Bearer fixture-model-grant') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ mcp_servers: { ledger: { grant_id: mcp.grantId, token: mcp.token } } }));
        return;
      }
      response.writeHead(request.headers.authorization === 'Bearer fixture-model-grant' ? 204 : 403).end();
      return;
    }
    received.push({ ...input, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' };
    const writeChunk = (delta, finish_reason) => response.write('data: ' + JSON.stringify({ ...base,
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (fixtureTool && (!mcp || input.tools?.some(tool => tool.function.name === fixtureTool.name))
      && !input.messages.some(message => message.role === 'tool')) {
      if (fixtureTool.preamble) writeChunk({ role: 'assistant', content: fixtureTool.preamble }, null);
      writeChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-chat-tool', type: 'function',
        function: { name: fixtureTool.name, arguments: JSON.stringify(fixtureTool.arguments) },
      }] }, null);
      writeChunk({}, 'tool_calls');
      response.end('data: [DONE]\n\n');
      return;
    }
    writeChunk({ role: 'assistant', content: replyFor(input) }, null);
    if (beforeFinish) {
      await beforeFinish;
      if (interrupt) {
        response.destroy();
        return;
      }
      writeChunk({ content: ' continued' }, null);
    }
    writeChunk({}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const modelsPath = join(workspace.path, legacyCatalog ? 'active-models.yaml' : 'models.yaml');
  if (legacyCatalog) await writeFile(join(workspace.path, 'models.yaml'), JSON.stringify(legacyCatalog));
  if (!modelProxy) await writeFile(modelsPath, JSON.stringify({ models: { 'fixture-model': {
    provider: 'openai', model: 'fixture-model', base_url: 'http://127.0.0.1:' + model.address().port + '/v1',
    api_key: catalogCredential,
  } } }));

  await using service = createServiceServer({
    AGENT_WORKSPACE: workspace.path,
    ...(modelProxy ? { DIAGENT_MODEL_PROXY_URL: 'http://127.0.0.1:' + model.address().port + modelProxyPath,
      DIAGENT_MODEL_PROXY_AGENT_ID: 'fixture-agent' }
      : { LLM_MODELS_CONFIG_PATH: modelsPath }),
    AGENT_SYSTEM_PROMPT: 'Reviewer role',
    SKILLS_DIR: skillsRoot,
    ...env,
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const send = (messages, stream = false, signal, toolSelection, modelGrant) => fetch('http://127.0.0.1:' + service.address().port + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(modelGrant ? { 'X-DiAgent-Model-Grant': modelGrant } : {}) },
    body: JSON.stringify({ model: 'fixture-model', stream, messages, tool_selection: toolSelection }), signal,
  });
  await run(send, received);
}

test('non-streaming A2A service request returns the DSH reply', { timeout: 45_000 }, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Review the draft' }]);
  const completion = await response.json();
  assert.equal(response.status, 200, JSON.stringify(completion));
  assert.equal(completion.choices[0].message.content, 'A2A reply');
  assert.equal(received[0].model, 'fixture-model');
  assert.ok(received[0].messages.some(message => message.role === 'user' && message.content === 'Review the draft'));
  assert.match(JSON.stringify(received[0].messages), /Reviewer role/);
  assert.equal(received[0].tools?.length ?? 0, 0);
}));

test('non-streaming Chat sends the supplied transcript to the model in order', { timeout: 45_000 }, () => withChatFixture(async (send, received) => {
  const transcript = [
    { role: 'user', content: 'Call this project Cedar.' },
    { role: 'assistant', content: 'I will call it Cedar.' },
    { role: 'user', content: 'What did we call the project?' },
  ];
  const response = await send([
    { role: 'system', content: 'Review project notes.' },
    transcript[0], { ...transcript[1], tool_calls: [] }, transcript[2],
  ]);
  assert.equal(response.status, 200, await response.text());
  const transcriptContents = new Set(transcript.map(message => message.content));
  assert.deepEqual(received[0].messages
    .filter(message => transcriptContents.has(message.content))
    .map(({ role, content }) => ({ role, content })), transcript);
  assert.match(received[0].messages[0].content, /Review project notes\./);
}));

test('non-streaming Chat rejects tool metadata on the current message', { timeout: 45_000 }, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Review the draft', tool_call_id: 'call-review' }]);
  assert.equal(response.status, 400, await response.text());
  assert.equal(received.length, 0);
}));

const linuxShellTest = { timeout: 45_000, skip: process.platform !== 'linux' };

test('managed Chat exposes only MCP tools the DiOS gateway grants', { timeout: 45_000 }, async () => {
  const grantId = '1'.repeat(32);
  const token = 'a'.repeat(43);
  const methods = [];
  const mcp = { grantId, token, async handle(request, response) {
    if (request.headers.authorization !== 'Bearer ' + token) return response.writeHead(401).end();
    if (request.method !== 'POST') return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(call.method);
    if (call.id === undefined) return response.writeHead(202).end();
    const results = {
      initialize: { protocolVersion: call.params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'ledger', version: '1' } },
      'tools/list': { tools: [{ name: 'lookup', description: 'Look up fixture data', inputSchema: { type: 'object' } }] },
      'tools/call': { content: [{ type: 'text', text: 'lookup-fixture-result' }] },
    };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(Object.hasOwn(results, call.method)
      ? { result: results[call.method] } : { error: { code: -32601, message: 'Method not found' } }) }));
  } };
  await withChatFixture(async (send, received) => {
    const response = await send([{ role: 'user', content: 'Look up the review' }], true, undefined, { tool_ids: ['mcp'] }, 'fixture-model-grant');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(received[0].tools.map(tool => tool.function.name), ['mcp__ledger__lookup']);
    assert.match(text, /event: tool_call/);
    assert.match(text, /lookup-fixture-result/);
    assert.equal(methods.filter(method => method === 'tools/call').length, 1);
    const afterLookup = methods.length;
    const textOnly = await send([{ role: 'user', content: 'Review without tools' }], false, undefined,
      { tool_ids: [] }, 'fixture-model-grant');
    assert.equal(textOnly.status, 200, await textOnly.text());
    assert.equal(received.at(-1).tools?.length ?? 0, 0);
    assert.equal(methods.length, afterLookup);
  }, { modelProxy: true, mcp, fixtureTool: { name: 'mcp__ledger__lookup', arguments: {} } });
});

test('Chat loads only the configured Skill through the native DSH skill tool', { timeout: 45_000 }, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Load the review skill' }], false, undefined, { tool_ids: ['skill'] });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(received[0].tools.map(tool => tool.function.name), ['skill']);
  assert.match(JSON.stringify(received[0].messages), /review-skill/);
  assert.doesNotMatch(JSON.stringify(received[0].messages), /private-skill/);
  assert.match(received[1].messages.find(message => message.role === 'tool')?.content, /review-instructions-fixture/);
}, {
  skills: { 'review-skill': 'review-instructions-fixture', 'private-skill': 'private-instructions-fixture' },
  fixtureTool: { name: 'skill', arguments: { name: 'review-skill' } },
  env: { DIAGENT_SKILL_NAMES: '["review-skill"]' },
}));

test('Chat runs shell using only the per-turn model proxy grant without a model catalog', linuxShellTest, () => withChatFixture(async (send, received) => {
  const messages = [{ role: 'user', content: 'Print the fixture marker' }];
  const selection = { tool_ids: ['shell'] };
  const denied = await send(messages, false, undefined, selection);
  assert.equal(denied.status, 400, await denied.text());
  assert.equal(received.length, 0);
  const foreignGrant = await send(messages, false, undefined, selection, 'other-agent-grant');
  assert.equal(foreignGrant.status, 403, await foreignGrant.text());
  assert.equal(received.length, 0);

  const response = await send(messages, false, undefined, selection, 'fixture-model-grant');
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(received.map(request => request.authorization), ['Bearer fixture-model-grant', 'Bearer fixture-model-grant']);
  assert.match(received[1].messages.find(message => message.role === 'tool')?.content, /chat-shell-output/);
}, { modelProxy: true, fixtureTool: { name: 'shell', arguments: { command: "printf 'chat-shell-output'" } } }));

test('Chat exposes only selected shell and returns its result to the model', linuxShellTest, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Print the fixture marker' }], false, undefined, { tool_ids: ['shell'] });
  const completion = await response.json();
  assert.equal(response.status, 200, JSON.stringify(completion));
  assert.deepEqual(received[0].tools.map(tool => tool.function.name), ['shell']);
  assert.match(JSON.stringify(received[1].messages.find(message => message.role === 'tool')?.content), /chat-shell-output/);
}, { fixtureTool: { name: 'shell', arguments: { command: "printf 'chat-shell-output'" } } }));

test('Chat rejects a model call to the internal Bash tool', linuxShellTest, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Print the fixture marker' }], false, undefined, { tool_ids: ['shell'] });
  assert.equal(response.status, 200, await response.text());
  const result = JSON.stringify(received[1].messages.find(message => message.role === 'tool')?.content);
  assert.match(result, /only available through shell|unknown tool|not available/i);
  assert.doesNotMatch(result, /unselected-bash-output/);
}, { fixtureTool: { name: 'bash', arguments: { command: "printf 'unselected-bash-output'", description: 'Fixture' } } }));

async function withEventToolFixture(status, run) {
  const submissions = [];
  const event = { event_type: 'ai4r.review.completed', source: 'ai4r/pilot', subject: 'pilot', data: {} };
  const responses = {
    '/api/os/events/catalog': { event_types: [{ type: event.event_type }] },
    '/api/os/connectors/source-patterns': [{ source_pattern: 'ai4r/*', event_types: [event.event_type] }],
    '/api/os/events/manual': { status, event_id: 'fixture-event' },
  };
  await using dios = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer fixture-event-token' || !Object.hasOwn(responses, request.url)) {
      response.writeHead(401).end('{}');
      return;
    }
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      submissions.push(JSON.parse(Buffer.concat(chunks).toString()));
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(responses[request.url]));
  });
  dios.listen(0, '127.0.0.1');
  await once(dios, 'listening');
  await withChatFixture((send, received) => run(send, received, submissions, event), {
    fixtureTool: { name: 'publish_event', arguments: event },
    env: { DIOS_API: 'http://127.0.0.1:' + dios.address().port, DIAGENT_EVENT_ACCESS_TOKEN: 'fixture-event-token' },
  });
}

test('Chat publishes selected events using only the deployed DiOS endpoint and credential', { timeout: 45_000 }, () =>
  withEventToolFixture('dispatched', async (send, received, submissions, event) => {
    const response = await send([{ role: 'user', content: 'Publish the review' }], false, undefined, { tool_ids: ['publish_event'] });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(received[0].tools.map(tool => tool.function.name), ['publish_event']);
    assert.deepEqual(submissions, [event]);
  }));

test('Chat streams a pending event approval returned by DiOS', { timeout: 45_000 }, () =>
  withEventToolFixture('approval_required', async (send, _received, submissions) => {
    const response = await send([{ role: 'user', content: 'Publish the review' }], true, undefined, { tool_ids: ['publish_event'] });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const approvalFrames = body.split('\n\n').filter(frame => frame.startsWith('event: event_approval\n'));
    assert.deepEqual(approvalFrames, ['event: event_approval\ndata: {"event_id":"fixture-event"}']);
    assert.equal(submissions.length, 1);
    assert.match(body, /data: \[DONE\]/);
  }));

test('Chat streams tool progress and keeps pre-tool text out of the answer', linuxShellTest, () => withChatFixture(async send => {
  const response = await send([{ role: 'user', content: 'Print the fixture marker' }], true, undefined, { tool_ids: ['shell'] });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const frames = body.trim().split('\n\n');
  assert.equal(frames.pop(), 'data: [DONE]');
  const chunks = frames.map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
  assert.deepEqual(chunks.map(chunk => chunk.type ?? chunk.choices[0].finish_reason
    ?? (chunk.choices[0].delta.reasoning_content ? 'reasoning' : 'content')),
  ['reasoning', 'tool_call_start', 'tool_call_end', 'content', 'stop']);
  const [reasoning, start, end, answer] = chunks;
  assert.equal(reasoning.choices[0].delta.reasoning_content, 'Checking. ');
  assert.equal(start.tool_name, 'shell');
  assert.equal(start.tool_call_id, end.tool_call_id);
  assert.deepEqual(start.arguments, { command: "printf 'chat-shell-output'" });
  assert.match(end.result, /chat-shell-output/);
  assert.ok(end.duration_ms >= 0);
  assert.equal(answer.choices[0].delta.content, 'A2A reply');
  assert.equal(frames.filter(frame => frame.startsWith('event: tool_call\n')).length, 2);
}, { fixtureTool: { name: 'shell', arguments: { command: "printf 'chat-shell-output'" }, preamble: 'Checking. ' } }));

test('a nonzero Shell exit streams a tool failure and the model can still respond', linuxShellTest, () => withChatFixture(async send => {
  const response = await send([{ role: 'user', content: 'Run the fixture' }], true, undefined, { tool_ids: ['shell'] });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /"type":"tool_call_error".*"error":".*fixture-stderr/);
  assert.doesNotMatch(body, /"type":"tool_call_end"/);
  assert.match(body, /A2A reply/);
}, { fixtureTool: { name: 'shell', arguments: { command: "printf '%s' fixture-stderr >&2; exit 7" } } }));

test('Chat rejects shell selection on a non-Linux host', { skip: process.platform === 'linux' }, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Review the draft' }], false, undefined, { tool_ids: ['shell'] });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /requires the Linux service image/);
  assert.equal(received.length, 0);
}));

test('Chat refuses shell when the model catalog contains a credential', linuxShellTest, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Review the draft' }], false, undefined, { tool_ids: ['shell'] });
  assert.equal(response.status, 400, await response.text());
  assert.equal(received.length, 0);
}, { catalogCredential: 'fixture-model-credential' }));

test('Chat uses an environment credential for text-only requests and refuses shell', linuxShellTest, () => withChatFixture(async (send, received) => {
  const messages = [{ role: 'user', content: 'Review the draft' }];
  const shell = await send(messages, false, undefined, { tool_ids: ['shell'] });
  assert.equal(shell.status, 400, await shell.text());
  assert.equal(received.length, 0);

  const text = await send(messages);
  assert.equal(text.status, 200, await text.text());
  assert.equal(received[0].authorization, 'Bearer fixture-model-credential');
}, { env: { LLM_OPENAI_API_KEY: 'fixture-model-credential' } }));

test('Chat refuses shell when a previous DiOS model catalog still contains a credential', linuxShellTest, () => withChatFixture(async (send, received) => {
  const response = await send([{ role: 'user', content: 'Review the draft' }], false, undefined, { tool_ids: ['shell'] });
  assert.equal(response.status, 400, await response.text());
  assert.equal(received.length, 0);
}, { legacyCatalog: { models: { 'previous-model': { api_key: 'fixture-legacy-credential' } } } }));

test('Chat rejects unknown tools and respects the deployment event switch', () => withChatFixture(async (send, received) => {
  const messages = [{ role: 'user', content: 'Review the draft' }];
  const unknown = await send(messages, false, undefined, { tool_ids: ['bash'] });
  assert.equal(unknown.status, 400);
  assert.match(await unknown.text(), /Unsupported Chat tool ID/);
  const disabled = await send(messages, true, undefined, { tool_ids: ['publish_event'] });
  assert.equal(disabled.status, 400);
  assert.match(await disabled.text(), /disabled by deployment/);
  assert.equal(received.length, 0);
}, { env: { DIAGENT_ENABLE_DIOS_EVENTS: 'false' } }));

async function withPausedChatStream(run, options = {}) {
  const finish = Promise.withResolvers();
  await withChatFixture(async (send, received) => {
    try {
      const response = await send([{ role: 'user', content: 'Review the draft' }], true, AbortSignal.timeout(35_000));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/event-stream/);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let early = '';
      while (!early.includes('A2A reply')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, early);
        early += chunk.value;
      }
      finish.resolve();
      let rest = '';
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += chunk.value;
      await run(early, rest, received);
    } finally {
      finish.resolve();
    }
  }, { ...options, beforeFinish: finish.promise });
}

test('streams the first text delta before the model completes', { timeout: 45_000 }, () => withPausedChatStream((early, rest) => {
  assert.doesNotMatch(early, /\[DONE\]/);
  const frames = (early + rest).trim().split('\n\n').map(line => line.slice('data: '.length));
  assert.equal(frames.pop(), '[DONE]');
  const chunks = frames.map(frame => JSON.parse(frame));
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), 'A2A reply continued');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, 1);
}));

test('an interrupted model stream emits an error without retrying visible output', { timeout: 45_000 }, () => withPausedChatStream((_early, rest, received) => {
  assert.match(rest, /"error":"DSH chat execution failed"/);
  assert.doesNotMatch(rest, /\[DONE\]|"finish_reason":"stop"/);
  assert.equal(received.length, 1);
}, { interrupt: true }));

test('cancelling a Chat SSE request closes the upstream model stream', { timeout: 45_000 }, async () => {
  const finish = Promise.withResolvers();
  const upstreamClosed = Promise.withResolvers();
  await withChatFixture(async send => {
    try {
      const abort = new AbortController();
      const response = await send([{ role: 'user', content: 'Review the draft' }], true, abort.signal);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /A2A reply/);
      abort.abort();
      await assert.rejects(reader.read(), { name: 'AbortError' });
      assert.equal(await Promise.race([
        upstreamClosed.promise,
        once(AbortSignal.timeout(5_000), 'abort').then(() => false),
      ]), true);
    } finally {
      finish.resolve();
    }
  }, { beforeFinish: finish.promise, onModelClose: ended => upstreamClosed.resolve(!ended) });
});

test('concurrent Chat requests keep their output and tool records separate', linuxShellTest, () => withChatFixture(async send => {
  const prompts = ['Draft Cedar', 'Draft Maple'];
  const rounds = await Promise.all(prompts.map(async prompt => {
    const response = await send([{ role: 'user', content: prompt }], true, undefined, { tool_ids: ['shell'] });
    assert.equal(response.status, 200);
    const text = await response.text();
    const chunks = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.equal(chunks.filter(chunk => chunk.type === 'tool_call_end').length, 1);
    const reply = chunks.find(chunk => chunk.choices?.[0].delta.content);
    assert.equal(reply?.choices[0].delta.content, 'Reviewed ' + prompt);
    assert.doesNotMatch(text, new RegExp(prompts.find(value => value !== prompt)));
    return reply.id;
  }));
  assert.notEqual(rounds[0], rounds[1]);
}, {
  fixtureTool: { name: 'shell', arguments: { command: 'printf concurrency-fixture' } },
  replyFor: input => 'Reviewed ' + input.messages.find(message => /^Draft (Cedar|Maple)$/.test(message.content)).content,
}));

test('rejects a non-boolean stream option before starting DSH', async () => {
  await using service = createServiceServer({});
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const response = await fetch('http://127.0.0.1:' + service.address().port + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: 'yes', messages: [{ role: 'user', content: 'Review the draft' }] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).detail, /stream/);
});

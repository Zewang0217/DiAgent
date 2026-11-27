/** 工具关联事件不依赖完成顺序，且不携带命令和内部参数。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { TaskResultProtocol } from '../dist/task/result-protocol.js';

async function makeProtocol(context) {
  await mkdir(resolve('.cache'), { recursive: true });
  const directory = await mkdtemp(resolve('.cache/tool-events-'));
  const workspace = join(directory, 'work');
  const output = join(workspace, 'output');
  const control = join(directory, 'control');
  await mkdir(workspace);
  const protocol = await TaskResultProtocol.open({ DIAGENT_TASK_PROTOCOL_DIR: control }, {
    workspace, outputDir: output, toolIds: ['shell'], subagents: [],
    isDiosEventPublishingEnabled: false,
  });
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { protocol, file: join(control, 'events.ndjson') };
}

test('pairs tool starts and out-of-order results by call id', async context => {
  const { protocol, file } = await makeProtocol(context);
  await protocol.observe({ type: 'tool/call', data: { callId: 'slow-call', name: 'shell', arguments: 'private-command' } });
  await protocol.observe({ type: 'tool/call', data: { callId: 'fast-call', name: 'shell', arguments: 'private-command' } });
  await protocol.observe({ type: 'tool/result', data: { message: { toolCallId: 'fast-call', isError: false } } });
  await protocol.observe({ type: 'tool/result', data: { message: { toolCallId: 'slow-call', isError: false } } });
  const text = await readFile(file, 'utf8');
  const events = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(event => event.type === 'tool_started').map(event => event.call_id), ['slow-call', 'fast-call']);
  assert.deepEqual(events.filter(event => event.type === 'tool_finished').map(event => event.call_id), ['fast-call', 'slow-call']);
  assert.ok(!text.includes('private-command'));
});

test('skill events carry the invoked skill name without a product prefix', async context => {
  const { protocol, file } = await makeProtocol(context);
  await protocol.observe({
    type: 'tool/call',
    data: { callId: 'skill-call', name: 'skill', arguments: JSON.stringify({ name: 'docx' }) },
  });
  const events = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);

  assert.equal(events.find(event => event.type === 'tool_started').skill, 'docx');
});

test('does not expose malformed call ids as paths or unbounded text', async context => {
  const { protocol, file } = await makeProtocol(context);
  await protocol.observe({ type: 'tool/call', data: { callId: '/private/host/path', name: 'shell', arguments: 'private-command' } });
  await protocol.observe({ type: 'tool/result', data: { message: { toolCallId: '/private/host/path', isError: false } } });
  const text = await readFile(file, 'utf8');
  const events = text.trim().split('\n').map(JSON.parse).filter(event => event.type.startsWith('tool_'));
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.call_id === undefined));
  assert.ok(!text.includes('/private/host/path'));
  assert.ok(!text.includes('private-command'));
});

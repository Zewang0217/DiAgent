/** 校验发布给调度器的 Task 配置、结果和事件 schema。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('../', import.meta.url));
const ajv = new Ajv({ allErrors: true, strict: false });

async function schema(name) {
  return JSON.parse(await readFile(join(root, 'schema', name), 'utf8'));
}

test('the bundled DSH task config satisfies the published schema', async () => {
  const validate = ajv.compile(await schema('task-config.schema.json'));
  const config = JSON.parse(await readFile(join(root, 'workspace/agent-task.dsh.json'), 'utf8'));

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test('a failed result requires a stable error code', async () => {
  const validate = ajv.compile(await schema('task-result.schema.json'));
  const failed = { version: 2, status: 'failed', summary: '', artifacts: [], steps: 1 };

  assert.equal(validate(failed), false);
  assert.equal(validate({ ...failed, error_code: 'step_limit', error: 'step_limit' }), true,
    JSON.stringify(validate.errors));
});

test('task events carry their type-specific fields', async () => {
  const validate = ajv.compile(await schema('task-events.schema.json'));
  const events = [
    { version: 1, seq: 1, at: 1, type: 'started' },
    { version: 1, seq: 2, at: 2, type: 'step_started', steps: 1 },
    { version: 1, seq: 3, at: 3, type: 'tool_started', tool: 'shell', call_id: 'call-1' },
    { version: 1, seq: 4, at: 4, type: 'tool_finished', success: true, call_id: 'call-1' },
    { version: 1, seq: 5, at: 5, type: 'finished', status: 'failed', error: 'step_limit' },
  ];

  for (const event of events) {
    assert.equal(validate(event), true, JSON.stringify({ event, errors: validate.errors }));
  }
  assert.equal(validate({ version: 1, seq: 6, at: 6, type: 'tool_started' }), false);
});

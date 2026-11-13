import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextAction, initialMessages } from '../dist/provider.js';
import { validateAction } from '../dist/policy.js';

const start = {
  type: 'start', protocolVersion: 5, taskId: 'test', terminalId: 'test',
  context: 'List files', cwd: '/tmp', shell: '/bin/zsh', history: [],
  api: { url: 'http://example.invalid/v1', key: 'test-key', model: 'test-model' },
};
const messages = () => initialMessages(start, { recentInteractions: [], preferences: [] });
const command = { kind: 'command', command: { shell: 'ls', reason: 'List files' } };
const completion = (value) => new Response(JSON.stringify({
  choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }],
}));
const plan = (signal = new AbortController().signal) => nextAction(start, messages(), signal);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('Action validation reports field errors together and rejects non-object actions', () => {
  assert.deepEqual(validateAction(command).action, command);
  for (const value of [null, [], 5, {}, { kind: 'other' }, { kind: 'done', summary: ' ' }, { kind: 'command', command: [] }]) {
    assert.ok(validateAction(value).errors.length > 0);
  }
  assert.deepEqual(validateAction({ kind: 'command', command: { shell: 123 } }).errors, [
    'command.shell must be a string.', 'command.reason must be a string.',
  ]);
  const errors = validateAction({ kind: 'command', command: { shell: `echo ${'x'.repeat(210)}\n`, reason: 'x'.repeat(501) } }).errors;
  assert.equal(errors.length, 3);
  assert.match(validateAction({ kind: 'command', command: { shell: 'ask test', reason: '' } }).errors[0], /must not invoke ask/);
});

test('All field errors are sent together for correction, with no review request', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return completion(calls.length === 1 ? { kind: 'command', command: { shell: 123 } } : command);
  });
  const initial = messages();
  assert.deepEqual(await nextAction(start, initial, new AbortController().signal), command);
  assert.equal(calls.length, 2);
  const feedback = JSON.parse(calls[1].messages.at(-1).content);
  assert.deepEqual(feedback.errors, ['command.shell must be a string.', 'command.reason must be a string.']);
  assert.equal(initial.length, 2, 'Repair messages must not mutate the task conversation');
});

test('Invalid JSON and a missing API content field get specific feedback', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return completion('{invalid');
    if (calls.length === 2) return new Response('{}');
    return completion({ kind: 'done', summary: 'Finished' });
  });
  assert.equal((await plan()).summary, 'Finished');
  assert.match(JSON.parse(calls[1].messages.at(-1).content).errors[0], /valid JSON/);
  assert.match(JSON.parse(calls[2].messages.at(-1).content).errors[0], /choices\[0\]/);
});

test('An invalid API JSON body is retried with a specific correction', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++calls === 1) return new Response('not JSON');
    assert.match(JSON.parse(JSON.parse(options.body).messages.at(-1).content).errors[0], /API response body/);
    return completion(command);
  });
  assert.deepEqual(await plan(), command);
});

test('Network failures are retried and may recover', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls < 3) throw new TypeError('fetch failed');
    return completion(command);
  });
  assert.deepEqual(await plan(), command);
  assert.equal(calls, 3);
});

for (const failure of ['network', 'HTTP']) {
  test(`${failure} failures stop after three attempts with an unavailable error`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (failure === 'network') throw new TypeError('fetch failed');
      return new Response('unavailable', { status: 503 });
    });
    await assert.rejects(plan(), /The LLM is currently unavailable\. Please try again later\./);
    assert.equal(calls, 3);
  });
}

for (const phase of ['connection', 'body']) {
  test(`Each ${phase} attempt has its own 30 second deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
      calls++;
      const waitForAbort = () => new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return phase === 'connection' ? waitForAbort() : Promise.resolve({ ok: true, text: waitForAbort });
    });
    const finished = assert.rejects(plan(), /LLM is currently unavailable/);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await flush();
      assert.equal(calls, attempt);
      t.mock.timers.tick(29_999);
      await flush();
      assert.equal(calls, attempt, 'No early timeout');
      t.mock.timers.tick(1);
      await flush();
    }
    await finished;
    assert.equal(calls, 3);
  });
}

test('User cancellation aborts the current request without retry or fallback', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const finished = assert.rejects(plan(controller.signal), /User cancelled/);
  controller.abort(new Error('User cancelled'));
  await finished;
  assert.equal(calls, 1);
  await assert.rejects(plan(controller.signal), /User cancelled/);
  assert.equal(calls, 1);
});

test('Transport and validation retries share a single three-attempt budget', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new Error('offline');
    return completion({ kind: 'command', command: {} });
  });
  const result = await plan();
  assert.equal(result.kind, 'done');
  assert.match(result.summary, /valid command after 3 attempts/);
  assert.equal(calls, 3);
});

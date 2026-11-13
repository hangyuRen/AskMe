import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { validCommand } from '../dist/policy.js';
import { colorsEnabled, paint, safeText } from '../dist/color.js';
import { recentHistory } from '../dist/history.js';
import { invokesAsk, serviceIntent } from '../dist/self.js';
import { execute } from '../dist/client.js';

const entry = resolve('dist/cli.js');

test('AI configuration requires ASKME-prefixed variables', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ask-no-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, API_URL: 'http://127.0.0.1:1/v1', API_KEY: 'legacy-key', API_MODEL: 'legacy-model' };
  delete env.ASKME_API_URL;
  delete env.ASKME_API_KEY;
  delete env.ASKME_API_MODEL;
  const result = await run(['List files'], env, process.cwd());
  assert.equal(result.code, 2);
  for (const name of ['ASKME_API_URL', 'ASKME_API_KEY', 'ASKME_API_MODEL']) {
    assert.ok(result.stderr.includes(`${process.platform === 'win32' ? '$env:' : 'export '}${name}=`));
  }
  assert.doesNotMatch(result.stderr, /export API_(?:URL|KEY|MODEL)=/);
});

test('Executed commands do not inherit the AskMe API key', async () => {
  const previous = process.env.ASKME_API_KEY;
  process.env.ASKME_API_KEY = 'test-key';
  try {
    const result = await execute({ shell: process.platform === 'win32' ? 'if (Test-Path Env:ASKME_API_KEY) { exit 1 }' : 'test -z "${ASKME_API_KEY+x}"', reason: 'Check environment isolation' }, process.cwd());
    assert.equal(result.exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.ASKME_API_KEY;
    else process.env.ASKME_API_KEY = previous;
  }
});

function run(args, env, cwd, answers = []) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let answered = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`ask 超时\n${stdout}\n${stderr}`)); }, process.platform === 'win32' ? 45_000 : 15_000);
    child.stdout.on('data', (bytes) => {
      stdout += bytes.toString().replace(/\r\n/g, '\n');
      while ((stdout.match(/Execute\?/g) ?? []).length > answered && answered < answers.length) {
        const answer = answers[answered];
        answered++;
        child.stdin.write(`${answer}\n`);
      }
    });
    child.stderr.on('data', (bytes) => { stderr += bytes.toString().replace(/\r\n/g, '\n'); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
  });
}

async function plannerRequest(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  assert.ok(parsed.messages[0].content.startsWith('You plan shell commands'));
  return parsed;
}

test('模型只能提出单条有效命令', () => {
  assert.equal(validCommand({ shell: 'echo a\necho b', reason: '' }), false);
  assert.equal(validCommand({ shell: 'echo preference-accepted && docker images', reason: '查看磁盘和镜像' }), true);
  assert.equal(validCommand({ shell: 'echo ' + 'x'.repeat(200), reason: '' }), false);
});

test('含糊的 ask ask 不会沿用上一任务', async () => {
  const env = { ...process.env };
  delete env.ASKME_API_URL;
  delete env.ASKME_API_KEY;
  delete env.ASKME_API_MODEL;
  const result = await run(['ask', 'ask'], env, process.cwd());
  assert.equal(result.code, 2);
  assert.match(result.stdout, /Please describe a specific task after ask/);
  assert.doesNotMatch(result.stdout, /Docker|Command 1/);
});

for (const oversized of [false, true]) {
  test(oversized ? 'Overlong commands are rewritten locally without review requests' : 'Valid commands are proposed without a second model review', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ask-no-review-'));
    const requests = [];
    const api = http.createServer(async (request, response) => {
      const parsed = await plannerRequest(request);
      requests.push(parsed);
      const action = oversized && requests.length === 1
        ? { kind: 'command', command: { shell: `echo ${'x'.repeat(220)}`, reason: 'Too long' } }
        : parsed.messages.some((message) => message.role === 'user' && message.content.includes('"exitCode":'))
          ? { kind: 'done', summary: 'Finished' }
          : { kind: 'command', command: { shell: 'echo direct-command', reason: 'Run the requested command' } };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
    });
    await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
    const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
    try {
      const result = await run(['Print direct-command'], env, home, ['y']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((result.stdout.match(/Execute\?/g) ?? []).length, 1);
      assert.match(result.stdout, /direct-command/);
      assert.match(result.stdout, /Finished/);
      assert.doesNotMatch(result.stdout, /Too long/);
      assert.equal(requests.length, oversized ? 3 : 2);
      if (oversized) assert.match(requests[1].messages.at(-1).content, /at most 200 characters/);
    } finally {
      await run(['daemon', 'stop'], env, home);
      api.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

test('识别服务请求与直接递归命令', () => {
  assert.equal(serviceIntent('启动ask服务'), 'start');
  assert.equal(serviceIntent('帮我启动 ask 后台服务'), 'start');
  assert.equal(serviceIntent('查看 ask 服务状态'), 'status');
  assert.equal(serviceIntent('停止ask服务'), 'stop');
  assert.equal(serviceIntent('如何启动 ask 服务'), undefined);
  assert.equal(invokesAsk('ask "再次提问"'), true);
  assert.equal(invokesAsk('echo ok && command /opt/homebrew/bin/ask x'), true);
  assert.equal(invokesAsk('echo ask'), false);
});

test('启动 ask 服务请求由客户端直接处理，无需 API 配置', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-service-intent-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ASKME_API_URL;
  delete env.ASKME_API_KEY;
  delete env.ASKME_API_MODEL;
  try {
    const result = await run(['启动ask服务'], env, home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /The ask daemon is running, PID \d+/);
    assert.doesNotMatch(result.stdout + result.stderr, /API_|Execute\?/);
  } finally {
    await run(['daemon', 'stop'], env, home);
    await rm(home, { recursive: true, force: true });
  }
});

test('模型直接建议再次运行 ask 时不会展示或执行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-direct-recursion-'));
  let requests = 0;
  const api = http.createServer(async (request, response) => {
    if (!await plannerRequest(request, response)) return;
    requests++;
    const action = requests === 1
      ? { kind: 'command', command: { shell: 'ask "再问一次"', reason: '错误地再次调用 ask' } }
      : { kind: 'done', summary: 'ask 服务已经运行' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  try {
    const result = await run(['调查服务'], env, home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ask 服务已经运行/);
    assert.doesNotMatch(result.stdout, /Execute\?|Command 1/);
    assert.equal(requests, 2);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('间接启动 ask 的子进程被入口阻止', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-indirect-recursion-'));
  let requests = 0;
  const api = http.createServer(async (request, response) => {
    if (!await plannerRequest(request, response)) return;
    requests++;
    const action = requests === 1
      ? { kind: 'command', command: { shell: `node "${entry}" "再次提问"`, reason: '测试间接调用' } }
      : { kind: 'done', summary: '已阻止递归' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  try {
    const result = await run(['测试递归'], env, home, ['y']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /Nested invocation blocked/);
    assert.match(result.stdout, /已阻止递归/);
    assert.equal(requests, 2);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('AI 内容和命令使用不同颜色，管道输出不带颜色', () => {
  assert.equal(colorsEnabled({ TERM: 'xterm-256color' }, true), true);
  assert.equal(colorsEnabled({ NO_COLOR: '', TERM: 'xterm-256color' }, true), false);
  assert.equal(colorsEnabled({ TERM: 'xterm-256color' }, false), false);
  assert.notEqual(paint('命令', 34, true), paint('AI summary', 35, true));
  assert.equal(paint('AI summary', 35, false), 'AI summary');
  assert.equal(safeText('\x1b[31m危险\x1b[0m'), '危险');
});

test('当前 Shell 历史最多提供十条', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-shell-history-'));
  try {
    const file = join(home, 'history');
    await writeFile(file, Array.from({ length: 12 }, (_, index) => `echo ${index}`).join('\n'));
    const history = await recentHistory(file);
    assert.equal(history.length, 10);
    assert.equal(history[0], 'echo 2');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('两个终端共用服务且同一 ask 调用完成多轮命令', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-test-'));
  const requests = [];
  const api = http.createServer(async (request, response) => {
    const parsed = await plannerRequest(request, response);
    if (!parsed) return;
    requests.push(parsed);
    const step = (parsed.messages.length - 2) / 2;
    const action = step === 0
      ? { kind: 'command', command: { shell: 'pwd', reason: '确认当前目录' } }
      : step === 1
        ? { kind: 'command', command: { shell: 'echo second-step', reason: '输出结果' } }
        : { kind: 'done', summary: '任务完成' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  const coloredEnv = { ...env, ASK_COLOR: 'always' };
  delete coloredEnv.NO_COLOR;
  try {
    const [first, second] = await Promise.all([
      run(['first task'], coloredEnv, home, ['y', 'y']),
      run(['second task'], env, process.cwd(), ['y', 'y']),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.match(first.stdout, /second-step/);
    assert.match(second.stdout, /second-step/);
    assert.doesNotMatch(first.stdout, /提问/);
    assert.match(first.stdout, /\x1b\[35mAI summary\x1b\[0m/);
    assert.match(first.stdout, /\x1b\[90mCommand output\x1b\[0m/);
    assert.doesNotMatch(second.stdout, /提问/);
    assert.doesNotMatch(second.stdout, /\x1b\[/);
    assert.match(first.stdout, /Command output/);
    assert.match(first.stdout, /AI summary/);
    assert.equal((first.stdout.match(/Execute\?/g) ?? []).length, 2);
    assert.equal((second.stdout.match(/Execute\?/g) ?? []).length, 2);
    assert.ok(first.stdout.indexOf('AI suggestion') < first.stdout.indexOf('Command 1'));
    assert.ok(first.stdout.indexOf('Command 1') < first.stdout.indexOf('Execute?'));
    assert.match(first.stdout, /任务完成/);
    assert.match(second.stdout, /任务完成/);
    assert.equal(requests.length, 6);
    const initial = requests.filter((item) => item.messages.length === 2);
    assert.equal(initial.length, 2);
    assert.equal(JSON.parse(initial[0].messages[1].content).platform, process.platform);
    assert.notEqual(JSON.parse(initial[0].messages[1].content).cwd, JSON.parse(initial[1].messages[1].content).cwd);
    const status = await run(['daemon', 'status'], env, home);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /PID \d+/);
    const duplicate = spawn(process.execPath, [entry, '__serve'], { env, cwd: home, stdio: 'ignore' });
    const duplicateExit = await new Promise((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        duplicate.kill();
        reject(new Error('重复启动的服务未退出'));
      }, process.platform === 'win32' ? 10_000 : 2_000);
      duplicate.once('exit', (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });
    assert.equal(duplicateExit, 0);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('模型总结格式错误时内部重试，不显示 JSON 错误', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-repair-'));
  let replies = 0;
  const api = http.createServer(async (request, response) => {
    if (!await plannerRequest(request, response)) return;
    replies++;
    const content = replies === 1
      ? JSON.stringify({ kind: 'command', command: { shell: 'echo disk-ok', reason: '查看结果' } })
      : replies === 2 ? '磁盘状态正常。'
        : JSON.stringify({ kind: 'done', summary: '磁盘状态正常。' });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  try {
    const result = await run(['check disk'], env, home, ['y']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Execute\?/);
    assert.match(result.stdout, /disk-ok/);
    assert.match(result.stdout, /磁盘状态正常。/);
    assert.doesNotMatch(result.stdout + result.stderr, /JSON|ask error/);
    assert.equal(replies, 3);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('模型连续返回无效格式时正常结束，不向用户抛解析错误', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-fallback-'));
  let replies = 0;
  const api = http.createServer(async (request, response) => {
    if (!await plannerRequest(request, response)) return;
    replies++;
    const content = replies === 1
      ? JSON.stringify({ kind: 'command', command: { shell: 'echo checked', reason: '检查' } })
      : '不是 JSON';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  try {
    const result = await run(['check'], env, home, ['y']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /checked/);
    assert.match(result.stdout, /could not generate a reliable summary/);
    assert.doesNotMatch(result.stdout + result.stderr, /ask error|未返回有效 JSON/);
    assert.equal(replies, 4);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('一条命令可组合操作，任务允许超过八轮', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-unbounded-'));
  const api = http.createServer(async (request, response) => {
    const parsed = await plannerRequest(request, response);
    if (!parsed) return;
    const step = (parsed.messages.length - 2) / 2;
    const shell = step === 0 ? (process.platform === 'win32' ? 'echo memory; echo disk; echo images' : 'echo memory && echo disk && echo images') : `echo step-${step + 1}`;
    const action = step < 9
      ? { kind: 'command', command: { shell, reason: '一次完成这轮检查' } }
      : { kind: 'done', summary: '检查完成' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  try {
    const result = await run(['multi'], env, home, Array(9).fill('y'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout.match(/Execute\?/g) ?? []).length, 9);
    assert.match(result.stdout, /echo memory(?: &&|;) echo disk(?: &&|;) echo images/);
    assert.match(result.stdout, /memory\ndisk\nimages/);
    assert.match(result.stdout, /Command 9/);
    assert.match(result.stdout, /检查完成/);
    assert.doesNotMatch(result.stdout, /8 步上限|提问/);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('相同问题会带入此前拒绝与接受的命令偏好', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-preferences-'));
  const initialContexts = [];
  const api = http.createServer(async (request, response) => {
    const parsed = await plannerRequest(request, response);
    if (!parsed) return;
    const messages = parsed.messages;
    const last = JSON.parse(messages.at(-1).content);
    let action;
    if (messages.length === 2) {
      const context = JSON.parse(messages[1].content);
      initialContexts.push(context);
      const hasDecline = context.sameQuestionCommandPreferences.some((item) => item.shell === 'echo preference-declined' && item.declined > 0);
      action = { kind: 'command', command: { shell: hasDecline ? 'echo preference-accepted' : 'echo preference-declined', reason: '检查资源' } };
    } else if (last.declined) {
      action = { kind: 'command', command: { shell: 'echo preference-accepted', reason: '改用已接受的命令' } };
    } else {
      action = { kind: 'done', summary: '检查完成' };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  const question = '看一下内存、磁盘使用情况';
  try {
    const first = await run([question], env, home, ['n', 'y']);
    assert.equal(first.code, 0, first.stderr);
    await run(['daemon', 'stop'], env, home);
    const second = await run([question], env, home, ['y']);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Command 1\necho preference-accepted/);
    assert.doesNotMatch(second.stdout, /echo preference-declined/);
    assert.equal(initialContexts.length, 2);
    assert.deepEqual(initialContexts[1].sameQuestionCommandPreferences.map(({ shell, accepted, declined }) => ({ shell, accepted, declined })), [
      { shell: 'echo preference-accepted', accepted: 1, declined: 0 },
      { shell: 'echo preference-declined', accepted: 0, declined: 1 },
    ]);
    assert.equal(initialContexts[1].recentAskInteractions.length, 2);
    assert.equal(initialContexts[1].recentAskInteractions[0].context, question);
    const stored = await readFile(join(home, '.ask', 'history.jsonl'), 'utf8');
    assert.match(stored, /"decision":"declined"/);
    assert.match(stored, /"decision":"accepted"/);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Unavailable LLM errors reach the user after exactly three requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-unavailable-'));
  let requests = 0;
  const api = http.createServer(async (request, response) => {
    await plannerRequest(request);
    requests++;
    response.writeHead(503);
    response.end('Service unavailable');
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
  try {
    const result = await run(['List files'], env, home);
    assert.equal(result.code, 2);
    assert.equal(requests, 3);
    assert.match(result.stderr, /The LLM is currently unavailable\. Please try again later\./);
    assert.doesNotMatch(result.stdout, /Execute\?|AI summary/);
  } finally {
    await run(['daemon', 'stop'], env, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('ask config persists settings for later terminals and accepts environment overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-saved-config-'));
  const received = [];
  const api = http.createServer(async (request, response) => {
    const parsed = await plannerRequest(request);
    received.push({ model: parsed.model, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'done', summary: 'Saved configuration works' }) } }] }));
  });
  await new Promise((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASKME_API_URL: `http://127.0.0.1:${api.address().port}/v1`, ASKME_API_KEY: 'saved-test-key', ASKME_API_MODEL: 'saved-model' };
  const cleanEnv = { ...env };
  for (const key of ['ASKME_API_URL', 'ASKME_API_KEY', 'ASKME_API_MODEL']) delete cleanEnv[key];
  try {
    // The zsh wrapper prepends --history-file even for configuration commands.
    const setup = await run(['--history-file', join(home, 'history'), 'config'], env, home);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /Configuration saved/);
    assert.doesNotMatch(setup.stdout + setup.stderr, /saved-test-key/);
    const saved = JSON.parse(await readFile(join(home, '.ask', 'config.json'), 'utf8'));
    assert.equal(saved.ASKME_API_MODEL, 'saved-model');
    const first = await run(['List files'], cleanEnv, home);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Saved configuration works/);
    const second = await run(['List files'], { ...cleanEnv, ASKME_API_MODEL: 'override-model' }, home);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(received, [
      { model: 'saved-model', authorization: 'Bearer saved-test-key' },
      { model: 'override-model', authorization: 'Bearer saved-test-key' },
    ]);
    assert.equal(JSON.parse(await readFile(join(home, '.ask', 'config.json'), 'utf8')).ASKME_API_MODEL, 'saved-model');
  } finally {
    await run(['daemon', 'stop'], cleanEnv, home);
    api.close();
    await rm(home, { recursive: true, force: true });
  }
});

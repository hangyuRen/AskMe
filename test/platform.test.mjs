import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execute } from '../dist/client.js';
import { commandArgs, commandShell, historyPath, ipcPath, privateDirectory, shellEnvironment } from '../dist/platform.js';
import { assertPrivatePermissions } from './helpers/permissions.mjs';

test('Windows PowerShell does not inherit incompatible module paths from its parent', () => {
  const original = { PSModulePath: 'PowerShell 7 modules', psmodulepath: 'another conflicting path', PATH: 'tools', ASKME_PRIVATE_DIRECTORY: 'config directory' };
  assert.deepEqual(shellEnvironment(original, 'win32'), { PATH: 'tools', ASKME_PRIVATE_DIRECTORY: 'config directory' });
  assert.equal(original.PSModulePath, 'PowerShell 7 modules');
  assert.deepEqual(shellEnvironment(original, 'darwin'), original);
  assert.deepEqual(shellEnvironment(original, 'linux'), original);
});

test('IPC selects Unix sockets or isolated, stable Windows named pipes', () => {
  assert.equal(ipcPath('/tmp/ask', 'linux'), join('/tmp/ask', 'daemon.sock'));
  assert.equal(ipcPath('/tmp/ask', 'darwin'), join('/tmp/ask', 'daemon.sock'));
  const pipe = ipcPath('C:\\Users\\Alice\\.ask', 'win32');
  assert.ok(pipe.startsWith('\\\\.\\pipe\\askme-'));
  assert.equal(pipe, ipcPath('c:\\users\\alice\\.ask', 'win32'));
  assert.notEqual(pipe, ipcPath('C:\\Users\\Bob\\.ask', 'win32'));
});

test('Shell selection respects Unix preferences and supplies platform defaults', () => {
  assert.equal(commandShell('darwin', {}, () => true), '/bin/zsh');
  assert.equal(commandShell('linux', {}, () => true), '/bin/bash');
  assert.equal(commandShell('linux', { SHELL: '/custom/sh' }, () => true), '/custom/sh');
  assert.equal(commandShell('linux', { SHELL: '/missing/sh' }, () => false), '/bin/sh');
  assert.equal(commandShell('win32', { SystemRoot: 'C:\\Windows', SHELL: '/bin/bash' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('Command arguments preserve source text and use noninteractive PowerShell on Windows', () => {
  assert.deepEqual(commandArgs('echo hello', 'linux'), ['-c', 'echo hello']);
  const args = commandArgs('Get-Location', 'win32');
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  assert.match(args.at(-1), /UTF8Encoding/);
  assert.match(args.at(-1), /Get-Location\n/);
  assert.match(args.at(-1), /exit \$LASTEXITCODE/);
});

test('History paths cover zsh, bash, PowerShell, and explicit overrides', () => {
  assert.equal(historyPath('linux', { SHELL: '/bin/bash' }, '/home/test'), join('/home/test', '.bash_history'));
  assert.equal(historyPath('darwin', { SHELL: '/bin/zsh' }, '/home/test'), join('/home/test', '.zsh_history'));
  assert.equal(historyPath('win32', { APPDATA: 'C:\\Data' }, 'C:\\Users\\test'), 'C:\\Data\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt');
  assert.equal(historyPath('win32', { HISTFILE: 'custom.txt' }), 'custom.txt');
});

test('Actual command execution preserves UTF-8 and native exit codes', async () => {
  const result = await execute({ shell: "node -e 'process.stdout.write(String.fromCodePoint(0x4F60,0x597D)); process.exit(7)'", reason: '' }, process.cwd());
  assert.equal(result.exitCode, 7);
  assert.equal(result.output, '你好');
});

test('Commands run in directories containing spaces', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ask cwd with spaces '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await execute({ shell: "node -p 'process.cwd()'", reason: '' }, directory);
  assert.equal(result.exitCode, 0);
  // macOS may resolve /var to /private/var.
  const { realpath } = await import('node:fs/promises');
  assert.equal(await realpath(result.output.trim()), await realpath(directory));
});

test('Already cancelled commands never execute', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await execute({ shell: 'echo should-not-run', reason: '' }, process.cwd(), controller.signal), { exitCode: null, output: '' });
});

test('Cancellation stops an active command and its child process', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const result = await execute({ shell: "node -e 'setTimeout(()=>{},30000)'", reason: '' }, process.cwd(), controller.signal);
    assert.notEqual(result.exitCode, 0);
  } finally {
    clearTimeout(timer);
  }
});

test('Runtime directory rejects symbolic links', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ask-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(directory, join(directory, 'link'));
  await assert.rejects(privateDirectory(join(directory, 'link')), /must be a directory owned/);
});

test('Windows runtime directory grants access only to the current user', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ask acl 空格 'quote' "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  await assertPrivatePermissions(directory, 0o700);
});

test('Windows configuration and commands work with incompatible inherited PowerShell modules', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ask-module-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modules = join(directory, 'modules');
  for (const [name, functions] of [
    ['Microsoft.PowerShell.Security', "'Set-Acl','Get-Acl'"],
    ['Microsoft.PowerShell.Utility', "'Get-Date'"],
  ]) {
    const path = join(modules, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, `${name}.psd1`), `@{ RootModule='${name}.psm1'; ModuleVersion='1.0.0'; FunctionsToExport=@(${functions}) }`);
    await writeFile(join(path, `${name}.psm1`), "throw 'Incompatible parent PowerShell module must not be loaded'");
  }
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = modules;
  try {
    // Both paths launch Windows PowerShell independently and must sanitize it.
    await privateDirectory(join(directory, 'runtime'));
    const result = await execute({ shell: "Get-Date -Format 'yyyy'", reason: '' }, directory);
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output.trim(), /^\d{4}$/);
  } finally {
    if (previous === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = previous;
  }
});

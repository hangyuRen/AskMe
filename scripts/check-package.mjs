import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'askme-package-'));
try {
  assert.ok(process.env.npm_execpath, 'Run this check through npm run test:package');
  const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    encoding: 'utf8', env: { ...process.env, npm_config_cache: join(directory, 'cache') },
  });
  const [packed] = JSON.parse(npm('pack', '--json', '--ignore-scripts', '--pack-destination', directory));
  const files = packed.files.map((file) => file.path);
  for (const required of ['dist/cli.js', 'dist/config.js', 'dist/platform.js', 'shell/ask.zsh', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(required), `Missing package file: ${required}`);
  }
  const prefix = join(directory, 'installed');
  npm('install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename));
  const windows = process.platform === 'win32';
  const executable = windows ? join(prefix, 'ask.cmd') : join(prefix, 'bin', 'ask');
  assert.ok(existsSync(executable), 'npm must generate the ask command');
  const installed = join(prefix, ...(windows ? [] : ['lib']), 'node_modules', 'askme', 'dist', 'cli.js');
  const help = execFileSync(process.execPath, [installed, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage: ask/);
  assert.match(help, /ask config/);
  console.log(`Package installation verified on ${process.platform}: ${packed.filename}, ask command, and CLI help.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

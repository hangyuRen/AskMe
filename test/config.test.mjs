import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, resolveConfig, saveConfig } from '../dist/config.js';

const config = { ASKME_API_URL: 'https://example.invalid/v1', ASKME_API_KEY: 'test-key', ASKME_API_MODEL: 'test-model' };
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ask-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Saved configuration survives reload with private file permissions', async (t) => {
  const dir = await temporary(t);
  await saveConfig(config, dir);
  const path = join(dir, 'config.json');
  assert.deepEqual(await loadConfig(path), config);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal((await stat(dir)).mode & 0o777, 0o700);
  if (process.platform !== 'win32') await chmod(path, 0o644);
  await saveConfig({ ...config, ASKME_API_MODEL: 'new-model' }, dir);
  assert.equal((await loadConfig(path)).ASKME_API_MODEL, 'new-model');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('Environment overrides saved fields without changing the saved configuration', () => {
  const env = { ASKME_API_MODEL: 'override-model', ASKME_API_KEY: '', API_URL: 'https://ignored.invalid' };
  assert.deepEqual(resolveConfig(config, env), { ...config, ASKME_API_MODEL: 'override-model' });
  assert.equal(config.ASKME_API_MODEL, 'test-model');
});

test('Missing config is allowed; malformed config gives an error without leaking its content', async (t) => {
  const path = join(await temporary(t), 'config.json');
  assert.deepEqual(await loadConfig(path), {});
  for (const text of ['secret-key-invalid-json', '[]', '{"ASKME_API_KEY":123}']) {
    await writeFile(path, text);
    await assert.rejects(loadConfig(path), (error) => {
      assert.match(error.message, /Invalid AskMe config/);
      assert.ok(!error.message.includes('secret-key-invalid-json'));
      return true;
    });
  }
});

test('Invalid or incomplete settings do not replace existing config', async (t) => {
  const dir = await temporary(t);
  await saveConfig(config, dir);
  for (const invalid of [{ ...config, ASKME_API_KEY: '' }, { ...config, ASKME_API_URL: 'file:///tmp/key' }, { ...config, ASKME_API_URL: 'not a URL' }]) {
    await assert.rejects(saveConfig(invalid, dir));
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')), config);
  }
});

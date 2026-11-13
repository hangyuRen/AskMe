import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { privateDirectory, runtimeDir } from './platform.js';

const fields = ['ASKME_API_URL', 'ASKME_API_KEY', 'ASKME_API_MODEL'] as const;
type ConfigField = typeof fields[number];
export type SavedConfig = Partial<Record<ConfigField, string>>;
export const configPath = join(runtimeDir, 'config.json');

export async function loadConfig(path = configPath): Promise<SavedConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid AskMe config file. Expected a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AskMe config file. Expected a JSON object.');
  const result: SavedConfig = {};
  for (const field of fields) {
    const item = (value as Record<string, unknown>)[field];
    if (item !== undefined && typeof item !== 'string') throw new Error(`Invalid AskMe config field: ${field} must be a string.`);
    if (typeof item === 'string') result[field] = item;
  }
  return result;
}

export function resolveConfig(saved: SavedConfig, env: NodeJS.ProcessEnv = process.env): SavedConfig {
  const result: SavedConfig = {};
  for (const field of fields) result[field] = env[field]?.trim() || saved[field]?.trim();
  return result;
}

export async function saveConfig(config: SavedConfig, directory = runtimeDir): Promise<void> {
  for (const field of fields) {
    if (!config[field]?.trim()) throw new Error(`${field} is required. Run ask config to configure the API.`);
  }
  let url: URL;
  try { url = new URL(config.ASKME_API_URL!); } catch { throw new Error('ASKME_API_URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ASKME_API_URL must be a valid HTTP or HTTPS URL.');
  await privateDirectory(directory);
  const temporary = join(directory, `config.${randomUUID()}.tmp`);
  try {
    const safe: SavedConfig = {};
    for (const field of fields) safe[field] = config[field]!.trim();
    await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'config.json'));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function configure(): Promise<number> {
  const config = resolveConfig(await loadConfig());
  const fromEnv = fields.every((field) => process.env[field]?.trim());
  if (!fromEnv && process.stdin.isTTY && process.stdout.isTTY) {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) process.stdout.write(chunk);
        callback();
      },
    });
    const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
    terminal.on('SIGINT', () => terminal.close());
    try {
      config.ASKME_API_URL = (await terminal.question(`API URL${config.ASKME_API_URL ? ` [${config.ASKME_API_URL}]` : ''}: `)).trim() || config.ASKME_API_URL;
      process.stdout.write(`API key (input hidden)${config.ASKME_API_KEY ? ' [Enter to keep existing key]' : ''}: `);
      muted = true;
      try { config.ASKME_API_KEY = (await terminal.question('')).trim() || config.ASKME_API_KEY; }
      finally { muted = false; process.stdout.write('\n'); }
      config.ASKME_API_MODEL = (await terminal.question(`Model${config.ASKME_API_MODEL ? ` [${config.ASKME_API_MODEL}]` : ''}: `)).trim() || config.ASKME_API_MODEL;
    } finally {
      terminal.close();
    }
  }
  await saveConfig(config);
  console.log(`Configuration saved to ${configPath}. Future terminals will use it automatically.`);
  return 0;
}

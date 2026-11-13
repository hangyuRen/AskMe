import { readFile } from 'node:fs/promises';
import { historyPath } from './platform.js';

const SENSITIVE = /api[_-]?key|token|password|secret|authorization|bearer/i;

export function redactOutput(output: string): string {
  return output
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk-|ghp_|gho_)[A-Za-z0-9_-]{12,}/g, '[REDACTED_TOKEN]');
}

export async function recentHistory(file?: string): Promise<string[]> {
  const path = file ?? historyPath();
  try {
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).slice(-150);
    return lines.map((line) => line.replace(/^: \d+:\d+;/, '').trim())
      .filter((line) => line && !/^ask(?:\s|$)/.test(line) && !SENSITIVE.test(line))
      .map((line) => line.slice(0, 500)).slice(-10);
  } catch {
    return [];
  }
}

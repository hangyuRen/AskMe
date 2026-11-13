import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { redactOutput } from './history.js';
import { privateMode } from './platform.js';

export interface Interaction {
  at: string;
  terminalId: string;
  context: string;
  shell: string;
  decision: 'accepted' | 'declined';
  exitCode?: number | null;
  output?: string;
}

export interface ContextSnapshot {
  recentInteractions: Array<Pick<Interaction, 'context' | 'shell' | 'decision' | 'exitCode' | 'output'>>;
  preferences: Array<{ shell: string; accepted: number; declined: number }>;
}

function normalizeQuestion(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export class HistoryStore {
  private records: Interaction[] = [];
  private pending = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const lines = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean);
      this.records = lines.slice(-500).flatMap((line) => {
        try {
          const value = JSON.parse(line) as Interaction;
          return typeof value.shell === 'string' && typeof value.context === 'string' &&
            typeof value.terminalId === 'string' && ['accepted', 'declined'].includes(value.decision)
            ? [value] : [];
        } catch { return []; }
      });
      await privateMode(this.path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  snapshot(terminalId: string, context: string): ContextSnapshot {
    const recentInteractions = this.records.filter((record) => record.terminalId === terminalId)
      .slice(-10).map(({ context: previousQuestion, shell, decision, exitCode, output }) => ({
        context: previousQuestion.slice(0, 500), shell, decision, exitCode, output: output?.slice(-1_500),
      }));
    const sameQuestion = this.records.filter((record) => normalizeQuestion(record.context) === normalizeQuestion(context));
    const counts = new Map<string, { shell: string; accepted: number; declined: number }>();
    for (const record of sameQuestion) {
      const entry = counts.get(record.shell) ?? { shell: record.shell, accepted: 0, declined: 0 };
      entry[record.decision]++;
      counts.set(record.shell, entry);
    }
    const preferences = [...counts.values()].sort((a, b) =>
      (b.accepted - b.declined) - (a.accepted - a.declined));
    return { recentInteractions, preferences };
  }

  append(record: Interaction): Promise<void> {
    const safe = {
      ...record,
      shell: redactOutput(record.shell),
      output: record.output ? redactOutput(record.output).slice(-16_000) : undefined,
    };
    this.pending = this.pending.catch(() => {}).then(async () => {
      this.records.push(safe);
      await appendFile(this.path, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
      if (this.records.length > 500) {
        this.records = this.records.slice(-500);
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, `${this.records.map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
        await rename(temporary, this.path);
      }
    });
    return this.pending;
  }
}

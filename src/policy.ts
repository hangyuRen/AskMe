import { invokesAsk } from './self.js';
import type { Action, Command } from './types.js';

function commandErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['command must be an object.'];
  const command = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof command.shell !== 'string') errors.push('command.shell must be a string.');
  else {
    if (!command.shell.trim()) errors.push('command.shell must not be empty.');
    if (command.shell.length > 200) errors.push('command.shell must contain at most 200 characters.');
    if (/[\x00-\x1f\x7f]/.test(command.shell)) errors.push('command.shell must be a single line without control characters.');
  }
  if (typeof command.reason !== 'string') errors.push('command.reason must be a string.');
  else if (command.reason.length > 500) errors.push('command.reason must contain at most 500 characters.');
  return errors;
}

export function validCommand(value: unknown): value is Command {
  return commandErrors(value).length === 0;
}

export function validateAction(value: unknown): { action: Action; errors: [] } | { action?: never; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: ['Action must be a JSON object.'] };
  }
  const action = value as Record<string, unknown>;
  if (action.kind === 'done') {
    if (typeof action.summary !== 'string' || !action.summary.trim()) {
      return { errors: ['summary must be a nonempty string when kind is "done".'] };
    }
    return { action: { kind: 'done', summary: action.summary.trim().slice(0, 2_000) }, errors: [] };
  }
  if (action.kind === 'command') {
    const errors = commandErrors(action.command);
    const command = action.command as Partial<Command> | null | undefined;
    if (typeof command?.shell === 'string' && invokesAsk(command.shell)) {
      errors.push('command.shell must not invoke ask or its CLI entry point from within ask.');
    }
    if (!errors.length && validCommand(action.command)) return { action: { kind: 'command', command: action.command }, errors: [] };
    return { errors };
  }
  return { errors: ['kind must be "command" or "done".'] };
}

export function displayCommand(command: Command): string {
  return command.shell;
}

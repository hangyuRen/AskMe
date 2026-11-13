export function colorsEnabled(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
  if ('NO_COLOR' in env || env.ASK_COLOR === 'never') return false;
  if (env.ASK_COLOR === 'always') return true;
  return isTty && env.TERM !== 'dumb';
}

export function safeText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function paint(value: string, code: number, enabled = colorsEnabled()): string {
  const text = safeText(value);
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

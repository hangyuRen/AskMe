import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const runtimeDir = join(homedir(), '.ask');

export function ipcPath(directory = runtimeDir, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return join(directory, 'daemon.sock');
  const identity = createHash('sha256').update(win32.resolve(directory).toLowerCase()).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\askme-${identity}`;
}

export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function commandShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') return windowsPowerShell(env);
  if (env.SHELL && exists(env.SHELL)) return env.SHELL;
  const preferred = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return exists(preferred) ? preferred : '/bin/sh';
}

export function commandArgs(command: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['-c', command];
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ' +
    command + '\n$askmeSuccess = $?; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $askmeSuccess) { exit 1 }'];
}

export function historyPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.HISTFILE) return env.HISTFILE;
  if (platform === 'win32') {
    return win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
  }
  return join(home, env.SHELL?.includes('zsh') ? '.zsh_history' : '.bash_history');
}

export async function privateMode(path: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, mode);
}

export async function privateDirectory(directory = runtimeDir): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (process.platform !== 'win32' && stat.uid !== process.getuid?.())) {
    throw new Error('AskMe runtime path must be a directory owned by the current user.');
  }
  if (process.platform !== 'win32') return privateMode(directory, 0o700);
  // Windows needs a DACL rather than POSIX mode bits. Pass the path as data.
  await execFileAsync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; " +
    '$acl = [System.Security.AccessControl.DirectorySecurity]::new(); ' +
    '$acl.SetAccessRuleProtection($true, $false); ' +
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
    '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow"); ' +
    '$acl.AddAccessRule($rule); Set-Acl -LiteralPath $env.ASKME_PRIVATE_DIRECTORY -AclObject $acl;'], {
    env: { ...process.env, ASKME_PRIVATE_DIRECTORY: directory }, windowsHide: true,
  });
}

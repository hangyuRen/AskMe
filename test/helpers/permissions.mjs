import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { shellEnvironment, windowsPowerShell } from '../../dist/platform.js';

const execFileAsync = promisify(execFile);

export async function assertPrivatePermissions(path, unixMode) {
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, unixMode);
    return;
  }
  // Windows mode bits do not describe NTFS access. Inspect the actual DACL,
  // including inherited file rules after config.json is atomically replaced.
  const { stdout } = await execFileAsync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; " +
    '$acl = Get-Acl -LiteralPath $env:ASKME_TEST_PERMISSION_PATH; ' +
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
    '$rules = @($acl.Access | ForEach-Object { ' +
    '@{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; ' +
    'allow = ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow); ' +
    'fullControl = (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) } }); ' +
    '@{ sid = $sid; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 4 -Compress'], {
    env: shellEnvironment({ ...process.env, ASKME_TEST_PERMISSION_PATH: path }), windowsHide: true,
  });
  const acl = JSON.parse(stdout.trim());
  assert.deepEqual(acl.rules, [{ sid: acl.sid, allow: true, fullControl: true }], 'Only the current user should have access');
  if (unixMode === 0o700) assert.equal(acl.protected, true, 'The runtime directory must not inherit other access rules');
}

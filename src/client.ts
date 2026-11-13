import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import * as readline from 'node:readline/promises';
import { paint, safeText } from './color.js';
import { recentHistory, redactOutput } from './history.js';
import { JsonPeer } from './peer.js';
import { displayCommand } from './policy.js';
import { connectExisting } from './server.js';
import { serviceIntent } from './self.js';
import { configure, loadConfig, resolveConfig } from './config.js';
import { commandArgs, commandShell, shellEnvironment } from './platform.js';
import { MAX_OUTPUT, PROTOCOL_VERSION } from './types.js';
import type { ClientMessage, Command, ServerMessage, TaskStart } from './types.js';

async function connect(startIfMissing: boolean): Promise<net.Socket> {
  if (!startIfMissing) return connectExisting();
  try {
    const existing = new JsonPeer<ServerMessage, ClientMessage>(await connectExisting());
    existing.send({ type: 'status' });
    const status = await existing.next();
    existing.close();
    if (status.type === 'status' && status.version === PROTOCOL_VERSION) return connectExisting();
    const old = new JsonPeer<ServerMessage, ClientMessage>(await connectExisting());
    old.send({ type: 'stop' });
    await old.next();
    old.close();
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      try { (await connectExisting()).destroy(); } catch { break; }
    }
  } catch {
    // No compatible service is listening.
  }
  const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
  const daemonEnv = { ...process.env };
  delete daemonEnv.ASKME_API_KEY;
  delete daemonEnv.ASKME_API_URL;
  delete daemonEnv.ASKME_API_MODEL;
  const daemon = spawn(process.execPath, [entry, '__serve'], { detached: true, windowsHide: true, stdio: 'ignore', env: daemonEnv });
  daemon.unref();
  for (let attempt = 0; attempt < (process.platform === 'win32' ? 160 : 40); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 75));
    try { return await connectExisting(); } catch { /* Service is still starting. */ }
  }
  throw new Error('Failed to start the daemon');
}

export async function execute(command: Command, cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  if (signal?.aborted) return { exitCode: null, output: '' };
  const env = shellEnvironment();
  delete env.ASKME_API_KEY;
  env.ASK_AGENT_ACTIVE = '1';
  const shell = commandShell();
  const child: ChildProcess = spawn(shell, commandArgs(command.shell), {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
  });
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid && process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill());
      killer.unref();
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    } else child.kill('SIGTERM');
  };
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  let output = '';
  const append = (text: string) => { output = (output + text).slice(-MAX_OUTPUT); };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => { process.stdout.write(text); append(text); });
  child.stderr?.on('data', (text: string) => { process.stderr.write(text); append(text); });
  try {
    return await new Promise((resolve) => {
      child.once('error', (error) => { append(error.message); process.stderr.write(`${error.message}\n`); resolve({ exitCode: null, output }); });
      child.once('close', (code) => { resolve({ exitCode: code, output }); });
    });
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

async function daemonCommand(action: string): Promise<number> {
  if (!['status', 'stop'].includes(action)) throw new Error('Usage: ask daemon status|stop');
  let socket: net.Socket;
  try { socket = await connect(false); } catch { console.log('The ask daemon is not running.'); return 0; }
  const peer = new JsonPeer<ServerMessage, ClientMessage>(socket);
  peer.send({ type: action as 'status' | 'stop' });
  const response = await peer.next();
  if (response.type === 'status') console.log(`The ask daemon is running, PID ${response.pid}, protocol v${response.version}`);
  else if (response.type === 'stopping') console.log('Stopping the ask daemon.');
  else throw new Error(response.type === 'error' ? response.message : 'Invalid response from the daemon');
  peer.close();
  return 0;
}

export async function runClient(argv: string[]): Promise<number> {
  let historyFile: string | undefined;
  if (argv[0] === '--history-file') {
    historyFile = argv[1];
    argv = argv.slice(2);
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage: ask "task description"\n      ask config\n      ask daemon status|stop\n      ask init zsh');
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === 'daemon') return daemonCommand(argv[1] ?? '');
  if (argv[0] === 'config') return configure();
  if (argv[0] === 'init') {
    if (argv[1] !== 'zsh') throw new Error('Only ask init zsh is currently supported');
    if (process.platform === 'win32') throw new Error('zsh integration is available on macOS and Linux. On Windows, use ask directly.');
    const integration = fileURLToPath(new URL('../shell/ask.zsh', import.meta.url));
    if (!existsSync(integration)) throw new Error('zsh integration file not found');
    console.log(`source '${integration.replaceAll("'", "'\\''")}'`);
    return 0;
  }
  if (!argv.length) throw new Error('Please provide a task description');
  const context = argv.join(' ');
  if (/^(?:ask\s*)+$/i.test(context.trim())) {
    console.log('Please describe a specific task after ask. History alone will not resume a previous task.');
    return 2;
  }
  const intent = serviceIntent(context);
  if (intent === 'stop') return daemonCommand('stop');
  if (intent === 'status') return daemonCommand('status');
  if (intent === 'start') {
    const peer = new JsonPeer<ServerMessage, ClientMessage>(await connect(true));
    try {
      peer.send({ type: 'status' });
      const response = await peer.next();
      if (response.type !== 'status') throw new Error('Unable to confirm the ask daemon status');
      console.log(`The ask daemon is running, PID ${response.pid}. There is no need to invoke ask from within ask.`);
      return 0;
    } finally {
      peer.close();
    }
  }
  const config = resolveConfig(await loadConfig());
  const url = config.ASKME_API_URL;
  const key = config.ASKME_API_KEY;
  const model = config.ASKME_API_MODEL;
  if (!url || !key || !model) {
    const prefix = process.platform === 'win32' ? '$env:' : 'export ';
    console.error(`Run ask config to save your AI API settings, or configure them for this terminal:\n  ${prefix}ASKME_API_URL="https://your-api-host/v1"\n  ${prefix}ASKME_API_KEY="your-api-key"\n  ${prefix}ASKME_API_MODEL="your-model-name"`);
    return 2;
  }
  const taskId = randomUUID();
  const shell = commandShell();
  const start: TaskStart = {
    type: 'start', protocolVersion: PROTOCOL_VERSION, taskId,
    terminalId: process.env.ASK_TERMINAL_ID ?? process.env.TERM_SESSION_ID ?? String(process.ppid),
    context, cwd: process.cwd(), shell, platform: process.platform, history: await recentHistory(historyFile),
    api: { url, key, model },
  };
  const peer = new JsonPeer<ServerMessage, ClientMessage>(await connect(true));
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const taskAbort = new AbortController();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    taskAbort.abort();
    try { peer.send({ type: 'cancel', taskId }); } catch { /* Connection already closed. */ }
    peer.close();
    terminal.close();
  };
  process.once('SIGINT', cancel);
  try {
    peer.send(start);
    while (!cancelled) {
      const reply = await peer.next();
      if (reply.type === 'error') throw new Error(reply.message);
      if (reply.type === 'done') {
        console.log(`\n${paint('AI summary', 35)}\n${paint(reply.summary, 35)}`);
        return 0;
      }
      if (reply.type !== 'proposal' || reply.taskId !== taskId) throw new Error('Daemon protocol mismatch');
      const { command } = reply;
      console.log(`\n${paint('AI suggestion', 35)}\n${paint(command.reason, 35)}`);
      console.log(`${paint(`Command ${reply.step}`, 34)}\n${paint(displayCommand(command), 34)}`);
      const answer = (await terminal.question(paint('Execute? [y] confirm / [n] skip / [q] quit: ', 33))).trim().toLowerCase();
      if (answer === 'q') { cancel(); return 1; }
      if (answer !== 'y') { peer.send({ type: 'decline', taskId, command }); continue; }
      console.log(`${paint('Confirmed', 32)} ${safeText(displayCommand(command))}`);
      console.log(paint('Command output', 90));
      const result = await execute(command, start.cwd, taskAbort.signal);
      if (result.output && !result.output.endsWith('\n')) process.stdout.write('\n');
      if (cancelled) return 130;
      peer.send({ type: 'result', taskId, command, exitCode: result.exitCode, output: redactOutput(result.output) });
    }
    return 130;
  } catch (error) {
    if (cancelled) return 130;
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    terminal.close();
    peer.close();
  }
}

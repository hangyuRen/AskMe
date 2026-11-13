import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { initialMessages, nextAction, resultMessages } from './provider.js';
import { JsonPeer } from './peer.js';
import { HistoryStore } from './store.js';
import { ipcPath, privateDirectory, privateMode, runtimeDir } from './platform.js';
import { MAX_OUTPUT, PROTOCOL_VERSION } from './types.js';
import type { ClientMessage, ServerMessage, TaskStart } from './types.js';

export const socketDir = runtimeDir;
export const socketPath = ipcPath();

function isStart(value: ClientMessage): value is TaskStart {
  return value?.type === 'start' && value.protocolVersion === PROTOCOL_VERSION && typeof value.taskId === 'string' &&
    typeof value.context === 'string' && value.context.length <= 8_000 &&
    typeof value.cwd === 'string' && typeof value.shell === 'string' && typeof value.terminalId === 'string' &&
    Array.isArray(value.history) && value.history.length <= 10 &&
    typeof value.api?.url === 'string' && /^https?:\/\//.test(value.api.url) &&
    typeof value.api.key === 'string' && typeof value.api.model === 'string';
}

export async function runTask(
  start: TaskStart,
  peer: JsonPeer<ClientMessage, ServerMessage>,
  store: HistoryStore,
  planner: typeof nextAction = nextAction,
): Promise<void> {
  const messages = initialMessages(start, store.snapshot(start.terminalId, start.context));
  const controller = new AbortController();
  peer.socket.once('close', () => controller.abort());
  try {
    for (let step = 1; ; step++) {
      const action = await planner(start, messages, controller.signal);
      if (action.kind === 'done') {
        peer.send({ type: 'done', taskId: start.taskId, summary: action.summary });
        return;
      }
      peer.send({ type: 'proposal', taskId: start.taskId, step, command: action.command });
      const reply = await peer.next();
      if (reply.type === 'cancel') return;
      if (!('taskId' in reply) || reply.taskId !== start.taskId) throw new Error('Task ID mismatch');
      if (reply.type === 'decline') {
        await store.append({ at: new Date().toISOString(), terminalId: start.terminalId,
          context: start.context, shell: action.command.shell, decision: 'declined' });
        resultMessages(messages, action, { declined: true, command: action.command });
      } else if (reply.type === 'result') {
        await store.append({ at: new Date().toISOString(), terminalId: start.terminalId,
          context: start.context, shell: action.command.shell, decision: 'accepted',
          exitCode: reply.exitCode, output: reply.output.slice(-MAX_OUTPUT) });
        resultMessages(messages, action, { command: action.command, exitCode: reply.exitCode, output: reply.output.slice(-MAX_OUTPUT) });
      } else {
        throw new Error('Invalid task response');
      }
    }
  } finally {
    controller.abort();
  }
}

export async function runServer(): Promise<void> {
  await privateDirectory(socketDir);
  const store = new HistoryStore(join(socketDir, 'history.jsonl'));
  await store.load();
  const server = net.createServer((socket) => {
    const peer = new JsonPeer<ClientMessage, ServerMessage>(socket);
    void (async () => {
      try {
        const first = await peer.next();
        if (first.type === 'status') {
          peer.send({ type: 'status', pid: process.pid, version: PROTOCOL_VERSION });
        } else if (first.type === 'stop') {
          peer.send({ type: 'stopping' });
          setTimeout(() => server.close(), 20);
        } else if (isStart(first)) {
          await runTask(first, peer, store);
        } else {
          peer.send({ type: 'error', message: 'Invalid request' });
        }
      } catch (error) {
        if (!socket.destroyed) peer.send({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
      } finally {
        peer.close();
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await privateMode(socketPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    try {
      (await connectExisting()).destroy();
      return;
    } catch {
      // Windows removes named pipes automatically; there is no stale file to unlink.
      if (process.platform === 'win32') throw error;
      const stat = await lstat(socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw error;
      await unlink(socketPath);
      await new Promise<void>((resolve, reject) => server.listen(socketPath, () => resolve()).once('error', reject));
      await privateMode(socketPath, 0o600);
    }
  }
}

export function connectExisting(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

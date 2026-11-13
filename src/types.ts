export interface Command {
  shell: string;
  reason: string;
}

export type Action =
  | { kind: 'command'; command: Command }
  | { kind: 'done'; summary: string };

export interface TaskStart {
  type: 'start';
  protocolVersion: number;
  taskId: string;
  terminalId: string;
  context: string;
  cwd: string;
  shell: string;
  history: string[];
  platform?: NodeJS.Platform;
  api: { url: string; key: string; model: string };
}

export type ClientMessage = TaskStart
  | { type: 'result'; taskId: string; command: Command; exitCode: number | null; output: string }
  | { type: 'decline'; taskId: string; command: Command }
  | { type: 'cancel'; taskId: string }
  | { type: 'status' }
  | { type: 'stop' };

export type ServerMessage =
  | { type: 'proposal'; taskId: string; step: number; command: Command }
  | { type: 'done'; taskId: string; summary: string }
  | { type: 'error'; message: string }
  | { type: 'status'; pid: number; version: number }
  | { type: 'stopping' };

export const PROTOCOL_VERSION = 6;
export const MAX_OUTPUT = 16_000;

import type { Socket } from 'node:net';

export class JsonPeer<TIn, TOut> {
  private buffer = '';
  private queue: TIn[] = [];
  private waiters: Array<{ resolve: (value: TIn) => void; reject: (error: Error) => void }> = [];
  private closed = false;

  constructor(readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => this.fail(new Error('Connection closed')));
    socket.on('error', (error) => this.fail(error));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) {
      this.socket.destroy(new Error('Message too long'));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const value = JSON.parse(line) as TIn;
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.queue.push(value);
      } catch {
        this.socket.destroy(new Error('Invalid protocol message'));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<TIn> {
    const value = this.queue.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  send(message: TOut): void {
    if (this.closed) throw new Error('Connection closed');
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.socket.end();
  }
}

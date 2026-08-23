/**
 * Client TS dimostrativo del sidecar Rust (POC, non cablato in produzione).
 * Mostra come il main process consumerebbe gittree-sidecar mantenendo
 * l'envelope `{ error }` e la coda per-repository.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GraphCommit {
  hash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface SidecarRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

const here = path.dirname(fileURLToPath(import.meta.url));

export class GittreeSidecarClient {
  private child: ChildProcessWithoutNullStreams;

  private pending = new Map<number, Pending>();

  private nextId = 1;

  private buffer = '';

  constructor(
    private readonly queues = new Map<string, Promise<unknown>>(),
    binaryPath = path.resolve(here, '..', 'target', 'debug', 'gittree-sidecar')
  ) {
    this.child = spawn(binaryPath, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk as string));
    this.child.on('exit', code => this.rejectAll(new Error(`sidecar terminato: ${code}`)));
  }

  /** Una sola richiesta per repository per volta, come la coda TS. */
  runQueued<T>(repo: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    this.queues.set(repo, queued as Promise<unknown>);
    return queued;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  graphPage(repo: string, offset = 0, limit = 500) {
    return this.request('graph.page', { repo, offset, limit });
  }

  status(repo: string): Promise<{ clean: boolean; branch: string; files: string[] }> {
    return this.request('status', { repo }) as never;
  }

  stop(): void {
    this.child.kill();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newlineAt = this.buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt).trim();
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line) this.deliver(line);
      newlineAt = this.buffer.indexOf('\n');
    }
  }

  private deliver(line: string): void {
    let message: { id?: number; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!entry) return;
    this.pending.delete(message.id as number);
    if (message.error === undefined || message.error === null) {
      entry.resolve((message.result ?? null) as Record<string, unknown>);
    } else {
      entry.reject(new Error(String(message.error)));
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

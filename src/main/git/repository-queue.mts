import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-repository serialization queue (ADR-0001): async git operations run one
 * at a time through a promise chain while nested calls inside the same queue
 * context stay re-entrant via AsyncLocalStorage.
 */
export class RepositoryQueue {
  private tail: Promise<unknown>;

  private context: AsyncLocalStorage<RepositoryQueue>;

  constructor() {
    this.tail = Promise.resolve();
    this.context = new AsyncLocalStorage();
  }

  isCurrent(): boolean {
    return this.context.getStore() === this;
  }

  runExclusive<T>(operation: () => T): T | Promise<T> {
    if (this.isCurrent()) return operation();
    const run = () => this.context.run(this, operation);
    const task = this.tail.then(run, run);
    this.tail = task.then(() => {}, () => {});
    return task;
  }
}

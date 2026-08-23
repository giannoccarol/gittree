import * as nodePath from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { RepositoryQueue } from './repository-queue.mts';

export interface RepositorySessionOptions {
  createGit?: typeof simpleGit;
  queue?: RepositoryQueue;
}

/**
 * Internal git unit owning one normalized repository path, the simple-git
 * adapter and one per-repository queue while GitService remains the stable
 * public facade.
 */
export class RepositorySession {
  path: string;

  git: SimpleGit;

  queue: RepositoryQueue;

  constructor(repositoryPath: string, {
    createGit = simpleGit,
    queue = new RepositoryQueue()
  }: RepositorySessionOptions = {}) {
    this.path = nodePath.resolve(repositoryPath);
    this.git = createGit(this.path);
    this.queue = queue;
  }

  isCurrent(): boolean {
    return this.queue.isCurrent();
  }

  runExclusive<T>(operation: () => T): T | Promise<T> {
    return this.queue.runExclusive(operation);
  }
}

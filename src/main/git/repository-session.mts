import * as nodePath from 'node:path';
import { spawn } from 'node:child_process';
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

  /**
   * Runs one git command that reads its arguments from stdin (for example
   * `log --stdin`), which keeps long revision lists off the command line.
   */
  rawWithInput(args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.path,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString('utf8'));
          return;
        }
        const message = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(message || `git ${args[0]} exited with code ${code}`));
      });
      child.stdin.on('error', reject);
      child.stdin.end(input);
    });
  }
}

import * as nodePath from 'node:path';
import type { SimpleGit } from 'simple-git';

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  locked: boolean;
  lockReason: string;
  prunable: boolean;
  pruneReason: string;
}

export interface WorktreeStatus {
  dirty: boolean;
  changes: number;
  ahead: number;
  behind: boolean | number;
}

export interface CreateWorktreeOptions {
  directory: string;
  branch: string;
  baseRef?: string;
  createBranch?: boolean;
}

export interface CreateWorktreeResult {
  success: true;
  path: string;
  branch: string;
  baseRef: string;
  createdBranch: boolean;
}

export interface RepositoryWorktreesOptions {
  git: SimpleGit;
  repoPath: string;
  readStatus?: ((path: string) => Promise<WorktreeStatus> | WorktreeStatus) | null;
  assertNoPendingOperation: () => Promise<void> | void;
  assertValidBranchName: (branch: string) => Promise<void> | void;
  assertCommitish: (ref: string) => Promise<void> | void;
}

function assertDirectory(directory: unknown): string {
  if (
    typeof directory !== 'string' ||
    !nodePath.isAbsolute(directory) ||
    /[\0\r\n]/.test(directory)
  ) {
    throw new Error('Invalid worktree directory');
  }
  return nodePath.normalize(directory);
}

function parseReason(line: string, prefix: string): string {
  return line.length > prefix.length ? line.slice(prefix.length).trim() : '';
}

interface ParsedWorktree {
  path?: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
  lockReason?: string;
  prunable?: boolean;
  pruneReason?: string;
}

export class RepositoryWorktrees {
  private git: SimpleGit;

  private repoPath: string;

  private readStatus: RepositoryWorktreesOptions['readStatus'];

  private assertNoPendingOperation: () => Promise<void> | void;

  private assertValidBranchName: (branch: string) => Promise<void> | void;

  private assertCommitish: (ref: string) => Promise<void> | void;

  constructor({
    git,
    repoPath,
    readStatus = null,
    assertNoPendingOperation,
    assertValidBranchName,
    assertCommitish
  }: RepositoryWorktreesOptions) {
    this.git = git;
    this.repoPath = repoPath;
    this.readStatus = readStatus;
    this.assertNoPendingOperation = assertNoPendingOperation;
    this.assertValidBranchName = assertValidBranchName;
    this.assertCommitish = assertCommitish;
  }

  parse(raw: unknown): WorktreeEntry[] {
    const worktrees: WorktreeEntry[] = [];
    let current: ParsedWorktree | null = null;
    const finish = () => {
      if (!current) return;
      worktrees.push({
        path: current.path || '',
        head: current.head || '',
        branch: current.branch || '',
        detached: Boolean(current.detached),
        locked: Boolean(current.locked),
        lockReason: current.lockReason || '',
        prunable: Boolean(current.prunable),
        pruneReason: current.pruneReason || ''
      });
      current = null;
    };
    for (const line of String(raw || '').split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        finish();
        current = { path: line.slice('worktree '.length) };
      } else if (!current) {
        continue;
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        current.detached = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        current.locked = true;
        current.lockReason = parseReason(line, 'locked');
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        current.prunable = true;
        current.pruneReason = parseReason(line, 'prunable');
      }
    }
    finish();
    return worktrees;
  }

  async list(): Promise<WorktreeEntry[]> {
    try {
      const worktrees = this.parse(await this.git.raw(['worktree', 'list', '--porcelain']));
      const readStatus = this.readStatus;
      if (!readStatus) return worktrees;
      return Promise.all(worktrees.map(async worktree => ({
        ...worktree,
        ...(await readStatus(worktree.path))
      })));
    } catch (error) {
      throw new Error(`Failed to get worktrees: ${(error as Error).message}`, { cause: error });
    }
  }

  parseStatus(raw: unknown): WorktreeStatus {
    let ahead = 0;
    let behind = 0;
    let changes = 0;
    for (const line of String(raw || '').split(/\r?\n/)) {
      const branch = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (branch) {
        ahead = Number(branch[1]);
        behind = Number(branch[2]);
      } else if (/^(?:1 |2 |u |\? )/.test(line)) {
        changes += 1;
      }
    }
    return { dirty: changes > 0, changes, ahead, behind };
  }

  async create({
    directory,
    branch,
    baseRef = 'HEAD',
    createBranch = true
  }: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
    await this.assertNoPendingOperation();
    const safeDirectory = assertDirectory(directory);
    await this.assertValidBranchName(branch);
    if (createBranch) await this.assertCommitish(baseRef);
    const args = createBranch
      ? ['worktree', 'add', '-b', branch, safeDirectory, baseRef]
      : ['worktree', 'add', safeDirectory, branch];
    try {
      await this.git.raw(args);
      return {
        success: true,
        path: safeDirectory,
        branch,
        baseRef: createBranch ? baseRef : branch,
        createdBranch: Boolean(createBranch)
      };
    } catch (error) {
      throw new Error(`Failed to create worktree: ${(error as Error).message}`, { cause: error });
    }
  }

  async remove(directory: string): Promise<{ success: true; path: string }> {
    const safeDirectory = assertDirectory(directory);
    try {
      await this.git.raw(['worktree', 'remove', safeDirectory]);
      return { success: true, path: safeDirectory };
    } catch (error) {
      throw new Error(`Failed to remove worktree: ${(error as Error).message}`, { cause: error });
    }
  }

  async lock(
    directory: string,
    reason = ''
  ): Promise<{ success: true; path: string; locked: true }> {
    const safeDirectory = assertDirectory(directory);
    if (typeof reason !== 'string' || reason.length > 200 || /[\0\r\n]/.test(reason)) {
      throw new Error('Invalid worktree lock reason');
    }
    const args = ['worktree', 'lock'];
    if (reason.trim()) args.push('--reason', reason.trim());
    args.push(safeDirectory);
    try {
      await this.git.raw(args);
      return { success: true, path: safeDirectory, locked: true };
    } catch (error) {
      throw new Error(`Failed to lock worktree: ${(error as Error).message}`, { cause: error });
    }
  }

  async unlock(
    directory: string
  ): Promise<{ success: true; path: string; locked: false }> {
    const safeDirectory = assertDirectory(directory);
    try {
      await this.git.raw(['worktree', 'unlock', safeDirectory]);
      return { success: true, path: safeDirectory, locked: false };
    } catch (error) {
      throw new Error(`Failed to unlock worktree: ${(error as Error).message}`, { cause: error });
    }
  }
}

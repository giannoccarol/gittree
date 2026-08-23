import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SimpleGit } from 'simple-git';
import {
  parseWorkingDiff,
  type WorkingDiff,
  type WorkingDiffHunk
} from './patch-parser.mts';

const execFileAsync = promisify(execFile);

export interface WorkingTreeFile {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  binary: boolean;
  submodule?: boolean;
}

export interface SubmoduleInfo {
  path: string;
}

export interface WorkingTreeSnapshot {
  snapshotId: string;
  branch: string | null;
  files: WorkingTreeFile[];
  submodules: SubmoduleInfo[];
  stagedCount: number;
  unstagedCount: number;
}

export interface WorkingDiffSummary {
  path: string;
  staged: boolean;
  binary: boolean;
  hunks: Array<Omit<WorkingDiffHunk, 'raw'>>;
}

/** Successful parse or the explicit "no textual diff" sentinel. */
export type ParsedWorkingDiff = WorkingDiff | NoDiffSentinel;

export interface NoDiffSentinel {
  path: string;
  staged: false;
  binary: false;
  hunks: never[];
  noDiff: true;
  reason: string;
}

export interface RepositoryWorkingTreeOptions {
  git: SimpleGit;
  repoPath: string;
  assertNoPendingOperation: () => Promise<void> | void;
  validateRepositoryPath: (
    filePath: string,
    options?: { rejectSymlinks?: boolean }
  ) => string;
  getSubmodules: () => Promise<SubmoduleInfo[]>;
}

interface MutationResult {
  success: true;
  snapshot: WorkingTreeSnapshot;
}

export class RepositoryWorkingTree {
  private git: SimpleGit;

  private repoPath: string;

  private assertNoPendingOperation: () => Promise<void> | void;

  private validateRepositoryPath: RepositoryWorkingTreeOptions['validateRepositoryPath'];

  private getSubmodules: () => Promise<SubmoduleInfo[]>;

  constructor({
    git,
    repoPath,
    assertNoPendingOperation,
    validateRepositoryPath,
    getSubmodules
  }: RepositoryWorkingTreeOptions) {
    this.git = git;
    this.repoPath = repoPath;
    this.assertNoPendingOperation = assertNoPendingOperation;
    this.validateRepositoryPath = validateRepositoryPath;
    this.getSubmodules = getSubmodules;
  }

  async getStatus() {
    try {
      const status = await this.git.status();
      return {
        current: status.current,
        tracking: status.tracking,
        detached: status.detached,
        ahead: status.ahead,
        behind: status.behind,
        files: status.files.map(file => ({
          path: file.path,
          index: file.index,
          working_dir: file.working_dir
        })),
        created: [...status.created],
        deleted: [...status.deleted],
        modified: [...status.modified],
        renamed: status.renamed.map(file => ({ from: file.from, to: file.to })),
        conflicted: [...status.conflicted],
        staged: [...status.staged],
        not_added: [...status.not_added],
        isClean: status.isClean()
      };
    } catch (error) {
      throw new Error(`Failed to get status: ${(error as Error).message}`, { cause: error });
    }
  }

  async getWorkingTree(): Promise<WorkingTreeSnapshot> {
    await this.assertNoPendingOperation();
    const status = await this.git.status();
    const files: WorkingTreeFile[] = status.files.map(file => {
      const indexStatus = file.index || ' ';
      const worktreeStatus = file.working_dir || ' ';
      const untracked = indexStatus === '?' && worktreeStatus === '?';
      const staged = !untracked && indexStatus !== ' ';
      const unstaged = untracked || worktreeStatus !== ' ';
      return {
        path: this.validateRepositoryPath(file.path, { rejectSymlinks: false }),
        oldPath: file.from
          ? this.validateRepositoryPath(file.from, { rejectSymlinks: false })
          : undefined,
        indexStatus,
        worktreeStatus,
        staged,
        unstaged,
        untracked,
        conflicted: status.conflicted.includes(file.path),
        binary: false
      };
    });
    const submodulePaths = new Set<string>();
    let submodules: SubmoduleInfo[] = [];
    if (nodeFs.existsSync(nodePath.join(this.repoPath, '.gitmodules'))) {
      try {
        submodules = await this.getSubmodules();
        for (const submodule of submodules) submodulePaths.add(submodule.path);
      } catch { /* submodule detection is best effort */ }
    }
    files.forEach(file => {
      file.submodule = submodulePaths.has(file.path);
    });
    const fileState = await Promise.all(
      files.map(async file => {
        try {
          const stat = await nodeFs.promises.lstat(nodePath.resolve(this.repoPath, file.path));
          return [file.path, stat.size, stat.mtimeMs];
        } catch {
          return [file.path, null, null];
        }
      })
    );
    let indexState: string;
    try {
      indexState = await this.git.raw(['diff', '--cached', '--raw', '-z']);
    } catch {
      indexState = await this.git.raw(['ls-files', '--stage', '-z']);
    }
    const snapshotId = createHash('sha256')
      .update(JSON.stringify({
        current: status.current,
        files: files.map(file => [file.path, file.indexStatus, file.worktreeStatus]),
        fileState,
        indexState
      }))
      .digest('hex');
    return {
      snapshotId,
      branch: status.current,
      files,
      submodules,
      stagedCount: files.filter(file => file.staged).length,
      unstagedCount: files.filter(file => file.unstaged).length
    };
  }

  async assertWorkingTreeSnapshot(snapshotId: unknown): Promise<void> {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) {
      throw new Error('Invalid working tree snapshot');
    }
    const current = await this.getWorkingTree();
    if (current.snapshotId !== snapshotId) {
      throw new Error('Working tree changed; refresh Changes and try again');
    }
  }

  validatePathList(paths: unknown): string[] {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) {
      throw new Error('Select between 1 and 500 repository paths');
    }
    return [...new Set(paths.map(filePath => this.validateRepositoryPath(filePath)))];
  }

  async stagePaths(snapshotId: string, paths: unknown): Promise<MutationResult> {
    await this.assertWorkingTreeSnapshot(snapshotId);
    const safePaths = this.validatePathList(paths);
    await this.git.add(['--', ...safePaths]);
    return { success: true, snapshot: await this.getWorkingTree() };
  }

  async unstagePaths(snapshotId: string, paths: unknown): Promise<MutationResult> {
    await this.assertWorkingTreeSnapshot(snapshotId);
    const safePaths = this.validatePathList(paths);
    try {
      await this.git.revparse(['--verify', 'HEAD']);
      await this.git.raw(['restore', '--staged', '--', ...safePaths]);
    } catch (error) {
      if (!/unknown revision|needed a single revision|ambiguous argument/i.test((error as Error).message)) {
        throw error;
      }
      await this.git.raw(['rm', '--cached', '--ignore-unmatch', '--', ...safePaths]);
    }
    return { success: true, snapshot: await this.getWorkingTree() };
  }

  async discardPaths(snapshotId: string, paths: unknown): Promise<MutationResult> {
    await this.assertWorkingTreeSnapshot(snapshotId);
    const safePaths = this.validatePathList(paths);
    const status = await this.git.status();
    const conflicted = new Set(status.conflicted || []);
    const untracked = new Set(status.not_added || []);
    const tracked: string[] = [];
    const untrackedToRemove: string[] = [];
    for (const relativePath of safePaths) {
      if (conflicted.has(relativePath)) {
        throw new Error(`Resolve the conflict in ${relativePath} before discarding it`);
      }
      if (untracked.has(relativePath)) untrackedToRemove.push(relativePath);
      else tracked.push(relativePath);
    }
    if (tracked.length) {
      await this.git.raw(['restore', '--worktree', '--', ...tracked]);
    }
    for (const relativePath of untrackedToRemove) {
      await nodeFs.promises.rm(nodePath.resolve(this.repoPath, relativePath), {
        recursive: true,
        force: true
      });
    }
    return { success: true, snapshot: await this.getWorkingTree() };
  }

  async getWorkingDiff(filePath: string, staged = false): Promise<WorkingDiffSummary> {
    const parsed = await this.getParsedWorkingDiff(filePath, staged);
    return {
      path: parsed.path,
      staged: parsed.staged,
      binary: parsed.binary,
      hunks: parsed.hunks.map(hunk => {
        const { raw: _raw, ...copy } = hunk;
        return copy;
      })
    };
  }

  async getParsedWorkingDiff(filePath: string, staged = false): Promise<ParsedWorkingDiff> {
    const relativePath = this.validateRepositoryPath(filePath);
    const args = [
      'diff',
      ...(staged ? ['--cached'] : []),
      '--no-ext-diff',
      '--binary',
      '--unified=3',
      '--',
      relativePath
    ];
    let patch = await this.git.raw(args);
    if (!staged && !patch) {
      const status = await this.git.status();
      const statusFile = status.files.find(file => file.path === relativePath);
      if (statusFile?.index === '?' && statusFile?.working_dir === '?') {
        try {
          const result = await execFileAsync(
            'git',
            [
              'diff',
              '--no-index',
              '--no-ext-diff',
              '--binary',
              '--unified=3',
              '--',
              '/dev/null',
              relativePath
            ],
            {
              cwd: this.repoPath,
              encoding: 'utf8',
              maxBuffer: 50 * 1024 * 1024,
              windowsHide: true
            }
          );
          patch = result.stdout;
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
          patch = (error as { stdout?: string }).stdout || '';
        }
      } else if (statusFile && statusFile.index !== '?' && statusFile.working_dir !== '?') {
        return {
          path: relativePath,
          staged: false,
          binary: false,
          hunks: [],
          noDiff: true,
          reason: 'working-tree-matches-index'
        };
      }
    }
    return parseWorkingDiff(relativePath, Boolean(staged), patch);
  }

  parseWorkingDiff(relativePath: string, staged: boolean, patch: string): WorkingDiff {
    return parseWorkingDiff(relativePath, staged, patch);
  }

  validateHunkIds(hunkIds: unknown): string[] {
    if (!Array.isArray(hunkIds) || hunkIds.length === 0 || hunkIds.length > 200) {
      throw new Error('Select between 1 and 200 diff hunks');
    }
    const unique = [...new Set(hunkIds)];
    if (unique.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
      throw new Error('Invalid diff hunk');
    }
    return unique;
  }

  async stageHunks(snapshotId: string, filePath: string, hunkIds: unknown): Promise<MutationResult> {
    return this.applyWorkingHunks(snapshotId, filePath, hunkIds, false);
  }

  async unstageHunks(snapshotId: string, filePath: string, hunkIds: unknown): Promise<MutationResult> {
    return this.applyWorkingHunks(snapshotId, filePath, hunkIds, true);
  }

  async applyWorkingHunks(
    snapshotId: string,
    filePath: string,
    hunkIds: unknown,
    reverse: boolean
  ): Promise<MutationResult> {
    await this.assertWorkingTreeSnapshot(snapshotId);
    const relativePath = this.validateRepositoryPath(filePath);
    const selectedIds = this.validateHunkIds(hunkIds);
    const diff = await this.getParsedWorkingDiff(relativePath, reverse);
    if (diff.binary) throw new Error('Binary files can only be staged as a whole');
    const available = new Map(
      diff.hunks.map((hunk): [string, WorkingDiffHunk] => [hunk.id, hunk])
    );
    const selected = selectedIds.map(id => available.get(id));
    if (selected.some(hunk => !hunk)) {
      throw new Error('Working tree changed; refresh Changes and try again');
    }
    const prelude = 'noDiff' in diff ? '' : diff.prelude;
    const patch = `${prelude}${selected.map(hunk => hunk!.raw).join('')}`;
    const args = ['apply', '--cached', '--recount', '--whitespace=nowarn'];
    if (reverse) args.push('--reverse');
    args.push('-');
    await this.runGitWithInput(args, patch);
    return { success: true, snapshot: await this.getWorkingTree() };
  }

  runGitWithInput(args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.repoPath,
        windowsHide: true,
        env: process.env
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputSize = 0;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputSize += chunk.length;
        if (outputSize > 50 * 1024 * 1024) {
          child.kill();
          reject(new Error('Git output exceeded the safe limit'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', reject);
      child.on('close', code => {
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new Error(errorText || `Git exited with code ${code}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
      child.stdin.end(input, 'utf8');
    });
  }
}

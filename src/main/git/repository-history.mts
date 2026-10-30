import type { SimpleGit } from 'simple-git';
import { parseWorkingDiff, type WorkingDiff } from './patch-parser.mts';
import { parseBlamePorcelain, type BlameRow } from './blame-parser.mts';
import {
  GraphHistoryIndex,
  type GraphPage,
  type GraphRef
} from './graph-history-index.mts';
import { readBoundedGitOutput } from './bounded-git-output.mts';

/**
 * Upper bound for the diff returned by a branch comparison. A branch with
 * thousands of commits can produce a diff of hundreds of megabytes; above this
 * size the preview is cut at a line boundary and flagged as truncated.
 */
export const BRANCH_COMPARISON_DIFF_LIMIT = 1024 * 1024;

export type { GraphCommit, GraphRef, GraphPage } from './graph-history-index.mts';

export interface NameStatusFile {
  path: string;
  oldPath: string | null;
  status: string;
}

export interface CommitDetail {
  hash: string;
  message: string;
  author_name: string;
  author_email: string;
  date: string;
  diff: string;
  files: string[];
}

const COMMIT_DETAIL_FIELD = '\x00';
const COMMIT_DETAIL_END = '\x01';
const COMMIT_DETAIL_FORMAT = ['%H', '%aN', '%aE', '%aI', '%s'].join('%x00') + '%x01';

/** Splits `git show --stat --patch` output written with COMMIT_DETAIL_FORMAT. */
export function parseCommitDetailOutput(output: string): CommitDetail | null {
  const end = output.indexOf(COMMIT_DETAIL_END);
  if (end === -1) return null;
  const [hash = '', authorName = '', authorEmail = '', date = '', subject = ''] = output
    .slice(0, end)
    .split(COMMIT_DETAIL_FIELD);
  if (!hash) return null;
  let rest = output.slice(end + 1);
  if (rest.startsWith('\n')) rest = rest.slice(1);
  // git separates the header from a diffstat followed by a patch with "---".
  if (rest.startsWith('---\n')) rest = rest.slice(4);
  let stat = rest;
  let diff = '';
  if (rest.startsWith('diff --git ')) {
    stat = '';
    diff = rest;
  } else {
    const newlineBeforePatch = rest.indexOf('\ndiff --git ');
    if (newlineBeforePatch !== -1) {
      stat = rest.slice(0, newlineBeforePatch + 1);
      diff = rest.slice(newlineBeforePatch + 1);
    }
  }
  return {
    hash,
    message: subject,
    author_name: authorName,
    author_email: authorEmail,
    date,
    diff,
    files: stat.trim().split('\n').filter(Boolean)
  };
}

export interface BlameResult {
  path: string;
  hash: string;
  rows: BlameRow[];
}

export interface RepositoryHistoryOptions {
  git: SimpleGit;
  repoPath: string;
  rawWithInput: (args: string[], input: string) => Promise<string>;
  assertSafeRef: (ref: string) => Promise<void> | void;
  assertCommitish: (ref: string) => Promise<void> | void;
  validateRepositoryPath: (filePath: string) => string;
}

export class RepositoryHistory {
  private git: SimpleGit;

  private repoPath: string;

  private assertSafeRef: (ref: string) => Promise<void> | void;

  private assertCommitish: (ref: string) => Promise<void> | void;

  private validateRepositoryPath: (filePath: string) => string;

  private graphIndex: GraphHistoryIndex;

  constructor({
    git,
    repoPath,
    rawWithInput,
    assertSafeRef,
    assertCommitish,
    validateRepositoryPath
  }: RepositoryHistoryOptions) {
    this.git = git;
    this.repoPath = repoPath;
    this.assertSafeRef = assertSafeRef;
    this.assertCommitish = assertCommitish;
    this.validateRepositoryPath = validateRepositoryPath;
    this.graphIndex = new GraphHistoryIndex({
      git: { raw: args => git.raw(args), rawWithInput },
      repoPath
    });
  }

  async getLog(maxCount: unknown = 100, branch: string | null = null) {
    const safeMaxCount = Math.min(1000, Math.max(1, Number(maxCount) || 100));
    if (branch) this.assertSafeRef(branch);
    try {
      const options: Record<string, unknown> = { maxCount: safeMaxCount, '--date': 'iso' };
      if (branch) options[branch] = null;
      return await this.git.log(options);
    } catch (error) {
      throw new Error(`Failed to get log: ${(error as Error).message}`, { cause: error });
    }
  }

  async getGraphPage(
    offset: unknown = 0,
    limit: unknown = 500,
    snapshot: unknown = null
  ): Promise<GraphPage> {
    const safeOffset = Math.max(0, Number.isFinite(Number(offset)) ? Number(offset) : 0);
    const safeLimit = Math.min(
      1000,
      Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 500)
    );
    try {
      return await this.graphIndex.page(
        safeOffset,
        safeLimit,
        GraphHistoryIndex.normalizeToken(snapshot)
      );
    } catch (error) {
      if (
        /does not have any commits|your current branch .* does not have any commits/i
          .test((error as Error).message)
      ) {
        return { commits: [], refs: [], nextOffset: safeOffset, hasMore: false };
      }
      throw new Error(`Failed to get graph page: ${(error as Error).message}`, { cause: error });
    }
  }

  async getGraphRefs(): Promise<GraphRef[]> {
    return this.graphIndex.readRefs();
  }

  async getDiff(commitHash: string | null = null, file: string | null = null): Promise<string> {
    if (!commitHash) {
      const relativeFile = file ? this.validateRepositoryPath(file) : null;
      try {
        const options = ['--no-ext-diff'];
        if (relativeFile) options.push('--', relativeFile);
        return await this.git.diff(options);
      } catch (error) {
        throw new Error(`Failed to get diff: ${(error as Error).message}`, { cause: error });
      }
    }
    return this.getCommitDiff(commitHash, file);
  }

  async getCommitDiff(hash: string, file: string | null = null): Promise<string> {
    this.assertSafeRef(hash);
    const relativeFile = file ? this.validateRepositoryPath(file) : null;
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    try {
      const options = ['--no-ext-diff'];
      if (await this.hasParent(hash)) options.push(`${hash}^..${hash}`);
      else options.push(`${emptyTree}..${hash}`);
      if (relativeFile) options.push('--', relativeFile);
      return await this.git.diff(options);
    } catch (error) {
      throw new Error(`Failed to get diff: ${(error as Error).message}`, { cause: error });
    }
  }

  async hasParent(commitHash: string): Promise<boolean> {
    try {
      const parents = await this.git.raw(['rev-list', '--parents', '-n', '1', commitHash]);
      return parents.split(/\s+/).filter(Boolean).length > 1;
    } catch {
      return true;
    }
  }

  async getBranchComparison(baseBranch: string, compareBranch: string, maxCount: unknown = 100) {
    this.assertSafeRef(baseBranch);
    this.assertSafeRef(compareBranch);
    try {
      const [diff, log, count] = await Promise.all([
        readBoundedGitOutput(
          this.repoPath,
          ['diff', '--no-ext-diff', `${baseBranch}...${compareBranch}`],
          BRANCH_COMPARISON_DIFF_LIMIT
        ),
        this.getLog(maxCount, `${baseBranch}..${compareBranch}`),
        this.git.raw(['rev-list', '--count', `${baseBranch}..${compareBranch}`])
      ]);
      const commits = log.all || [];
      const totalCommits = Number.parseInt(count.trim(), 10);
      return {
        base: baseBranch,
        compare: compareBranch,
        diff: diff.text,
        diffTruncated: diff.truncated,
        commits,
        totalCommits: Number.isFinite(totalCommits) ? totalCommits : commits.length
      };
    } catch (error) {
      throw new Error(`Failed to compare branches: ${(error as Error).message}`, { cause: error });
    }
  }

  async compareCommits(hashA: string, hashB: string) {
    await this.assertCommitish(hashA);
    await this.assertCommitish(hashB);
    try {
      const nameStatus = await this.git.raw([
        'diff', '--no-ext-diff', '--name-status', '-z', `${hashA}..${hashB}`
      ]);
      const files = this.parseNameStatus(nameStatus);
      const diff = await this.git.diff(['--no-ext-diff', `${hashA}..${hashB}`]);
      return { base: hashA, compare: hashB, files, diff };
    } catch (error) {
      throw new Error(`Failed to compare commits: ${(error as Error).message}`, { cause: error });
    }
  }

  parseNameStatus(raw: string): NameStatusFile[] {
    const parts = raw.split('\0').filter(Boolean);
    const files: NameStatusFile[] = [];
    let index = 0;
    while (index < parts.length) {
      const status = parts[index];
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = parts[index + 1] || '';
        const newPath = parts[index + 2] || '';
        files.push({ path: newPath, oldPath, status: status[0] });
        index += 3;
      } else {
        files.push({ path: parts[index + 1] || '', oldPath: null, status: status[0] });
        index += 2;
      }
    }
    return files;
  }

  async getCommitFileDiff(
    hashA: string,
    hashB: string,
    filePath: string
  ): Promise<WorkingDiff> {
    await this.assertCommitish(hashA);
    await this.assertCommitish(hashB);
    const relativePath = this.validateRepositoryPath(filePath);
    try {
      const patch = await this.git.raw([
        'diff', '--no-ext-diff', '--unified=3', `${hashA}..${hashB}`, '--', relativePath
      ]);
      return parseWorkingDiff(relativePath, false, patch);
    } catch (error) {
      throw new Error(`Failed to get commit file diff: ${(error as Error).message}`, { cause: error });
    }
  }

  async getCommitDetail(hash: string): Promise<CommitDetail | null> {
    this.assertSafeRef(hash);
    try {
      // One process returns the metadata, the --stat lines and the first-parent
      // patch (the empty tree for a root commit), the same text `git diff` gives.
      const output = await this.git.raw([
        'show',
        '--no-color',
        '--no-ext-diff',
        '--diff-merges=first-parent',
        '--stat',
        '--patch',
        `--format=${COMMIT_DETAIL_FORMAT}`,
        `${hash}^{commit}`,
        '--'
      ]);
      return parseCommitDetailOutput(output);
    } catch (error) {
      throw new Error(`Failed to get commit detail: ${(error as Error).message}`, { cause: error });
    }
  }

  async getBlame(filePath: string, hash = 'HEAD'): Promise<BlameResult> {
    const relativePath = this.validateRepositoryPath(filePath);
    this.assertSafeRef(hash);
    try {
      const output = await this.git.raw([
        'blame',
        '--line-porcelain',
        hash,
        '--',
        relativePath
      ]);
      return { path: relativePath, hash, rows: parseBlamePorcelain(output) };
    } catch (error) {
      throw new Error(`Failed to get blame: ${(error as Error).message}`, { cause: error });
    }
  }
}

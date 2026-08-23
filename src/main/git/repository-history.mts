import type { SimpleGit } from 'simple-git';
import { parseWorkingDiff, type WorkingDiff } from './patch-parser.mts';
import { parseBlamePorcelain, type BlameRow } from './blame-parser.mts';

export interface GraphCommit {
  hash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface GraphRef {
  fullName: string;
  shortName: string;
  type: 'branch' | 'remote' | 'tag' | 'head';
  commit: string;
  upstream: string;
}

export interface GraphPage {
  commits: GraphCommit[];
  refs: GraphRef[];
  nextOffset: number;
  hasMore: boolean;
}

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

export interface BlameResult {
  path: string;
  hash: string;
  rows: BlameRow[];
}

export interface RepositoryHistoryOptions {
  git: SimpleGit;
  assertSafeRef: (ref: string) => Promise<void> | void;
  assertCommitish: (ref: string) => Promise<void> | void;
  validateRepositoryPath: (filePath: string) => string;
}

export class RepositoryHistory {
  private git: SimpleGit;

  private assertSafeRef: (ref: string) => Promise<void> | void;

  private assertCommitish: (ref: string) => Promise<void> | void;

  private validateRepositoryPath: (filePath: string) => string;

  constructor({
    git,
    assertSafeRef,
    assertCommitish,
    validateRepositoryPath
  }: RepositoryHistoryOptions) {
    this.git = git;
    this.assertSafeRef = assertSafeRef;
    this.assertCommitish = assertCommitish;
    this.validateRepositoryPath = validateRepositoryPath;
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

  async getGraphPage(offset: unknown = 0, limit: unknown = 500): Promise<GraphPage> {
    const safeOffset = Math.max(0, Number.isFinite(Number(offset)) ? Number(offset) : 0);
    const safeLimit = Math.min(
      1000,
      Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 500)
    );
    try {
      const raw = await this.git.raw([
        'log',
        '--all',
        '--topo-order',
        '--date-order',
        '--parents',
        '-z',
        `--skip=${safeOffset}`,
        `--max-count=${safeLimit + 1}`,
        '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s'
      ]);
      const parsed = raw
        .split('\0')
        .map(record => record.replace(/^[\r\n]+|[\r\n]+$/g, ''))
        .filter(Boolean)
        .map(record => {
          const [
            hash,
            parentText = '',
            authorName = '',
            authorEmail = '',
            date = '',
            ...subjectParts
          ] = record.split('\x1f');
          return {
            hash,
            parents: parentText ? parentText.split(/\s+/).filter(Boolean) : [],
            subject: subjectParts.join('\x1f'),
            authorName,
            authorEmail,
            date
          };
        });
      const hasMore = parsed.length > safeLimit;
      const commits = parsed.slice(0, safeLimit);
      return {
        commits,
        refs: await this.getGraphRefs(),
        nextOffset: safeOffset + commits.length,
        hasMore
      };
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
    const raw = await this.git.raw([
      'for-each-ref',
      '--format=%(refname)\t%(refname:short)\t%(objectname)\t%(upstream:short)',
      'refs/heads',
      'refs/remotes',
      'refs/tags'
    ]);
    const refs: GraphRef[] = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [fullName, shortName, commit, upstream = ''] = line.split('\t');
        let type: GraphRef['type'] = 'branch';
        if (fullName.startsWith('refs/remotes/')) type = 'remote';
        else if (fullName.startsWith('refs/tags/')) type = 'tag';
        return { fullName, shortName, type, commit, upstream };
      })
      .filter(ref => !ref.fullName.endsWith('/HEAD'));

    try {
      const headCommit = (await this.git.revparse(['HEAD'])).trim();
      refs.push({
        fullName: 'HEAD',
        shortName: 'HEAD',
        type: 'head',
        commit: headCommit,
        upstream: ''
      });
    } catch { /* HEAD may be unborn */ }
    return refs;
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
      const [diff, log] = await Promise.all([
        this.git.diff(['--no-ext-diff', `${baseBranch}...${compareBranch}`]),
        this.getLog(maxCount, `${baseBranch}..${compareBranch}`)
      ]);
      return {
        base: baseBranch,
        compare: compareBranch,
        diff,
        commits: log.all || []
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
      const log = await this.git.log({ maxCount: 1, '--date': 'iso', [hash]: null });
      if (!log.latest) return null;
      const diff = await this.getCommitDiff(hash);
      const show = await this.git.show([hash, '--stat', '--format=']);
      return {
        hash: log.latest.hash,
        message: log.latest.message,
        author_name: log.latest.author_name,
        author_email: log.latest.author_email,
        date: log.latest.date,
        diff,
        files: show.trim().split('\n').filter(Boolean)
      };
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

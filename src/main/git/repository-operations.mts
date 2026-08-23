import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SimpleGit } from 'simple-git';
import {
  MAX_CONFLICT_RESULT_BYTES,
  conflictSnapshot,
  hasUnresolvedMarkers,
  parseConflictBlocks,
  type ConflictBlock
} from '../conflict-model.mts';
import type { OperationState } from '../../shared/models.mts';

const execFileAsync = promisify(execFile);

export interface CommitActionMetadata {
  hash: string;
  parents: string[];
  timestamp: number;
  subject: string;
}

export interface CommitActionPreview {
  action: 'rebase' | 'cherry-pick';
  target: string | null;
  commits: CommitActionMetadata[];
  files: string[];
  workingTree: { clean: boolean; files: string[] };
  pendingOperation: OperationState['type'];
  detached: boolean;
  allowed: boolean;
  reason: string;
}

export interface MergePreview {
  supported: boolean;
  canFastForward: boolean | null;
  conflictedFiles: string[];
  changedFiles: string[];
}

export interface ConflictFile {
  snapshotId: string;
  path: string;
  binary: boolean;
  eol: 'crlf' | 'lf';
  base: string;
  current: string;
  incoming: string;
  result: string;
  blocks: ConflictBlock[];
  ours: string;
  theirs: string;
}

export interface ConflictResolution {
  strategy?: string;
  snapshotId?: unknown;
  content?: unknown;
}

export interface RepositoryOperationsOptions {
  git: SimpleGit;
  repoPath: string;
  assertCommitish: (ref: string) => Promise<void> | void;
  validateRepositoryPath: (
    filePath: string,
    options?: { rejectSymlinks?: boolean }
  ) => string;
}

const MERGE_STRATEGIES = {
  ff: '--ff',
  noff: '--no-ff',
  squash: '--squash'
} as const;

export type MergeStrategy = keyof typeof MERGE_STRATEGIES;

export class RepositoryOperations {
  private git: SimpleGit;

  private repoPath: string;

  private assertCommitish: (ref: string) => Promise<void> | void;

  private validateRepositoryPath: RepositoryOperationsOptions['validateRepositoryPath'];

  constructor({ git, repoPath, assertCommitish, validateRepositoryPath }: RepositoryOperationsOptions) {
    this.git = git;
    this.repoPath = repoPath;
    this.assertCommitish = assertCommitish;
    this.validateRepositoryPath = validateRepositoryPath;
  }

  async rebaseOnto(branch: string) {
    await this.assertNoPendingOperation();
    await this.assertCommitish(branch);
    const status = await this.git.status();
    if (!status.isClean()) {
      throw new Error('Rebase requires a clean working tree');
    }
    try {
      const result = await this.git.rebase([branch]);
      return { success: true, branch, result };
    } catch (error) {
      throw new Error(`Failed to rebase onto ${branch}: ${(error as Error).message}`, { cause: error });
    }
  }

  validateCommitHashes(hashes: unknown): string[] {
    if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > 500) {
      throw new Error('Select between 1 and 500 commits');
    }
    const unique = [...new Set(hashes)];
    if (unique.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{7,64}$/i.test(hash))) {
      throw new Error('Invalid commit hash');
    }
    return unique;
  }

  async getCommitActionMetadata(hashes: unknown): Promise<CommitActionMetadata[]> {
    const metadata: CommitActionMetadata[] = [];
    for (const hash of this.validateCommitHashes(hashes)) {
      await this.assertCommitish(hash);
      const raw = await this.git.raw([
        'show',
        '-s',
        '--format=%H%x1f%P%x1f%ct%x1f%s',
        hash
      ]);
      const [fullHash, parentText = '', timestamp = '0', ...subject] =
        raw.trim().split('\x1f');
      metadata.push({
        hash: fullHash,
        parents: parentText ? parentText.split(/\s+/) : [],
        timestamp: Number(timestamp) || 0,
        subject: subject.join('\x1f')
      });
    }
    return metadata;
  }

  sortCommitsParentFirst(commits: CommitActionMetadata[]): CommitActionMetadata[] {
    const byHash = new Map<string, CommitActionMetadata>(
      commits.map((commit): [string, CommitActionMetadata] => [commit.hash, commit])
    );
    const indegree = new Map<string, number>(
      commits.map((commit): [string, number] => [commit.hash, 0])
    );
    const children = new Map<string, string[]>(
      commits.map((commit): [string, string[]] => [commit.hash, []])
    );
    for (const commit of commits) {
      for (const parent of commit.parents) {
        if (!byHash.has(parent)) continue;
        indegree.set(commit.hash, indegree.get(commit.hash)! + 1);
        children.get(parent)!.push(commit.hash);
      }
    }
    const ready = commits
      .filter(commit => indegree.get(commit.hash) === 0)
      .sort((left, right) => left.timestamp - right.timestamp);
    const ordered: CommitActionMetadata[] = [];
    while (ready.length) {
      const commit = ready.shift();
      if (!commit) break;
      ordered.push(commit);
      for (const childHash of children.get(commit.hash)!) {
        indegree.set(childHash, indegree.get(childHash)! - 1);
        if (indegree.get(childHash) === 0) {
          const child = byHash.get(childHash);
          if (child) ready.push(child);
          ready.sort((left, right) => left.timestamp - right.timestamp);
        }
      }
    }
    return ordered.length === commits.length
      ? ordered
      : [...commits].sort((left, right) => left.timestamp - right.timestamp);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await execFileAsync(
        'git',
        ['merge-base', '--is-ancestor', ancestor, descendant],
        { cwd: this.repoPath, windowsHide: true }
      );
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }

  async getCommitFiles(commits: CommitActionMetadata[]): Promise<string[]> {
    const files = new Set<string>();
    for (const commit of commits) {
      const raw = await this.git.raw([
        'show',
        '--pretty=format:',
        '--name-only',
        '-z',
        commit.hash
      ]);
      raw.split('\0').filter(Boolean).forEach(file => files.add(file));
    }
    return [...files];
  }

  async previewCommitAction(
    action: 'rebase' | 'cherry-pick',
    hashes: unknown
  ): Promise<CommitActionPreview> {
    if (!['rebase', 'cherry-pick'].includes(action)) {
      throw new Error(`Invalid commit action: ${action}`);
    }
    const commits = await this.getCommitActionMetadata(hashes);
    const [status, operation, head] = await Promise.all([
      this.git.status(),
      this.getOperationState(),
      this.git.revparse(['HEAD']).then(value => value.trim())
    ]);
    const base = {
      action,
      target: commits[0]?.hash || null,
      commits,
      files: [] as string[],
      workingTree: {
        clean: status.isClean(),
        files: status.files.map(file => file.path)
      },
      pendingOperation: operation.type,
      detached: Boolean(status.detached),
      allowed: true,
      reason: ''
    };
    if (operation.type) {
      return {
        ...base,
        allowed: false,
        reason: `Finish or abort the pending ${operation.type} first`
      };
    }
    if (!status.isClean()) {
      return { ...base, allowed: false, reason: 'The working tree must be clean' };
    }

    if (action === 'rebase') {
      if (commits.length !== 1) {
        return { ...base, allowed: false, reason: 'Rebase requires one target commit' };
      }
      if (status.detached) {
        return { ...base, allowed: false, reason: 'Rebase is unavailable in detached HEAD' };
      }
      if (commits[0].hash === head) {
        return { ...base, allowed: false, reason: 'HEAD is already at this commit' };
      }
      if (await this.isAncestor(commits[0].hash, head)) {
        return {
          ...base,
          allowed: false,
          reason: 'The selected target is already an ancestor of HEAD'
        };
      }
      const replayHashes = (await this.git.raw([
        'rev-list',
        '--reverse',
        `${commits[0].hash}..HEAD`
      ])).split(/\r?\n/).filter(Boolean);
      const replay = replayHashes.length
        ? await this.getCommitActionMetadata(replayHashes)
        : [];
      const files = (await this.git.diff([
        '--no-ext-diff',
        '--name-only',
        `${commits[0].hash}...HEAD`
      ])).split(/\r?\n/).filter(Boolean);
      return { ...base, commits: replay, files };
    }

    const ordered = this.sortCommitsParentFirst(commits);
    if (ordered.some(commit => commit.parents.length > 1)) {
      return {
        ...base,
        commits: ordered,
        allowed: false,
        reason: 'Merge commits require a mainline and cannot be cherry-picked here'
      };
    }
    return {
      ...base,
      commits: ordered,
      files: await this.getCommitFiles(ordered)
    };
  }

  async rebaseOntoCommit(hash: string) {
    const preview = await this.previewCommitAction('rebase', [hash]);
    if (!preview.allowed) throw new Error(preview.reason);
    try {
      const result = await this.git.rebase([hash]);
      return {
        success: true,
        target: hash,
        head: (await this.git.revparse(['HEAD'])).trim(),
        result
      };
    } catch (error) {
      throw new Error(`Failed to rebase onto commit: ${(error as Error).message}`, { cause: error });
    }
  }

  async cherryPickCommits(hashes: unknown) {
    const preview = await this.previewCommitAction('cherry-pick', hashes);
    if (!preview.allowed) throw new Error(preview.reason);
    try {
      await this.git.raw(['cherry-pick', ...preview.commits.map(commit => commit.hash)]);
      return {
        success: true,
        commits: preview.commits.map(commit => commit.hash),
        head: (await this.git.revparse(['HEAD'])).trim()
      };
    } catch (error) {
      throw new Error(`Failed to cherry-pick: ${(error as Error).message}`, { cause: error });
    }
  }

  async assertNoPendingOperation(): Promise<void> {
    const state = await this.getOperationState();
    if (state.type) {
      throw new Error(`Finish or abort the pending ${state.type} before changing branches`);
    }
  }

  async merge(branch: string, strategy: string = 'ff') {
    await this.assertNoPendingOperation();
    await this.assertCommitish(branch);
    const flag = MERGE_STRATEGIES[strategy as MergeStrategy];
    if (!flag) throw new Error(`Invalid merge strategy: ${strategy}`);
    const status = await this.git.status();
    if (!status.isClean()) {
      const blocking = await this.mergeBlockingFiles(branch, status);
      if (blocking.length) {
        throw new Error(
          `The merge would overwrite local changes in: ${blocking.join(', ')}`
        );
      }
    }
    try {
      const result = await this.git.merge([flag, branch]);
      const state = await this.getOperationState();
      if (state.type === 'merge' && state.conflicts.length > 0) {
        throw new Error(`Failed to merge: conflicts in ${state.conflicts.join(', ')}`);
      }
      return { success: true, branch, strategy, result };
    } catch (error) {
      throw new Error(`Failed to merge: ${(error as Error).message}`, { cause: error });
    }
  }

  async mergeBlockingFiles(branch: string, status: Awaited<ReturnType<SimpleGit['status']>>) {
    const changedRaw = await this.git.raw(['diff', '--name-only', `HEAD...${branch}`]);
    const incoming = new Set(changedRaw.split(/\r?\n/).filter(Boolean));
    if (!incoming.size) return [];
    const local = [
      ...(status.files || []).map(file => file.path),
      ...(status.modified || []),
      ...(status.not_added || []),
      ...(status.created || []),
      ...(status.deleted || []),
      ...(status.staged || []),
      ...(status.conflicted || []),
      ...(status.renamed || []).flatMap(file => [file.from, file.to])
    ].filter(Boolean);
    return [...new Set(local.filter(file => incoming.has(file)))];
  }

  async previewMerge(branch: string): Promise<MergePreview> {
    await this.assertCommitish(branch);
    const fallback = (): MergePreview => ({
      supported: false,
      canFastForward: null,
      conflictedFiles: [],
      changedFiles: []
    });
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'git',
        ['merge-tree', '--write-tree', '--name-only', 'HEAD', branch],
        { cwd: this.repoPath, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }
      ));
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout || '');
      if (!stdout) return fallback();
    }
    const conflictedFiles: string[] = [];
    const lines = String(stdout).split(/\r?\n/);
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line || /^warning|^error|^Auto-merging/i.test(line)) continue;
      if (/^CONFL/i.test(line)) {
        let match = line.match(/\bin\s+(\S+)\s*$/i);
        if (!match) match = line.match(/\bdans\s+(\S+)\s*$/i);
        if (!match) match = line.match(/:\s*(\S+)\s*$/);
        if (!match) {
          const last = line.trim().split(/\s+/).pop()?.replace(/[:.,;"]+$/, '') ?? '';
          if (last && /[a-z0-9]/i.test(last)) conflictedFiles.push(last);
          continue;
        }
        if (match) conflictedFiles.push(match[1]);
      }
    }
    try {
      const base = (await this.git.raw(['merge-base', 'HEAD', branch])).trim();
      const head = (await this.git.revparse(['HEAD'])).trim();
      const changedRaw = await this.git.raw(['diff', '--name-only', `${base}..${branch}`]);
      return {
        supported: true,
        canFastForward: base === head,
        conflictedFiles,
        changedFiles: changedRaw.split(/\r?\n/).filter(Boolean)
      };
    } catch {
      return {
        supported: true,
        canFastForward: null,
        conflictedFiles,
        changedFiles: []
      };
    }
  }

  parseConflictBlocks(content: unknown): ConflictBlock[] {
    return parseConflictBlocks(String(content || ''));
  }

  async getOperationState(): Promise<OperationState> {
    const [
      mergePath,
      rebaseMergePath,
      rebaseApplyPath,
      cherryPickPath,
      sequencerPath
    ] = await Promise.all([
      'MERGE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'CHERRY_PICK_HEAD',
      'sequencer'
    ].map(name => this.resolveGitPath(name)));
    let type: OperationState['type'] = null;
    if (nodeFs.existsSync(mergePath)) type = 'merge';
    else if (nodeFs.existsSync(rebaseMergePath) || nodeFs.existsSync(rebaseApplyPath)) type = 'rebase';
    else if (nodeFs.existsSync(cherryPickPath) || nodeFs.existsSync(sequencerPath)) {
      type = 'cherry-pick';
    }

    if (!type) return { type: null, conflicts: [], canContinue: false };
    const raw = await this.git.raw(['diff', '--name-only', '--diff-filter=U', '-z']);
    const conflicts = raw.split('\0').filter(Boolean);
    return { type, conflicts, canContinue: conflicts.length === 0 };
  }

  async readConflict(filePath: string): Promise<ConflictFile> {
    const relativePath = this.validateRepositoryPath(filePath);
    const state = await this.getOperationState();
    if (!state.type || !state.conflicts.includes(relativePath)) {
      throw new Error(`File is not conflicted: ${relativePath}`);
    }

    const [base, ours, theirs, result] = await Promise.all([
      this.readStageBlob(1, relativePath),
      this.readStageBlob(2, relativePath),
      this.readStageBlob(3, relativePath),
      nodeFs.promises.readFile(nodePath.resolve(this.repoPath, relativePath)).catch(() => Buffer.alloc(0))
    ]);
    const buffers = [base, ours, theirs, result];
    const binary = buffers.some(buffer => buffer.includes(0));
    const decode = (buffer: Buffer) => binary ? '' : buffer.toString('utf8');
    const resultText = decode(result);
    const snapshotId = conflictSnapshot(buffers);

    return {
      snapshotId,
      path: relativePath,
      binary,
      eol: resultText.includes('\r\n') ? 'crlf' : 'lf',
      base: decode(base),
      current: decode(ours),
      incoming: decode(theirs),
      result: resultText,
      blocks: binary ? [] : parseConflictBlocks(resultText),
      // Compatibility aliases for integrations that still use Git's ours/theirs labels.
      ours: decode(ours),
      theirs: decode(theirs)
    };
  }

  async resolveConflict(filePath: string, resolution: ConflictResolution) {
    const relativePath = this.validateRepositoryPath(filePath);
    const state = await this.getOperationState();
    if (!state.type || !state.conflicts.includes(relativePath)) {
      throw new Error(`File is not conflicted: ${relativePath}`);
    }

    const strategy = resolution?.strategy;
    const conflict = await this.readConflict(relativePath);
    if (
      typeof resolution?.snapshotId !== 'string' ||
      resolution.snapshotId !== conflict.snapshotId
    ) {
      throw new Error('The conflicted file changed externally. Reload it before resolving.');
    }
    if (strategy === 'manual') {
      if (typeof resolution.content !== 'string') {
        throw new Error('Manual conflict resolution requires text content');
      }
      if (conflict.binary) throw new Error('Binary conflicts cannot be edited as text');
      if (Buffer.byteLength(resolution.content, 'utf8') > MAX_CONFLICT_RESULT_BYTES) {
        throw new Error('Conflict result is too large');
      }
      if (hasUnresolvedMarkers(resolution.content)) {
        throw new Error('The result still contains unresolved conflict markers');
      }
      await nodeFs.promises.writeFile(
        nodePath.resolve(this.repoPath, relativePath),
        resolution.content,
        'utf8'
      );
    } else if (strategy === 'ours' || strategy === 'theirs') {
      await this.git.raw(['checkout', `--${strategy}`, '--', relativePath]);
    } else {
      throw new Error(`Invalid conflict strategy: ${strategy}`);
    }

    await this.git.add(['--', relativePath]);
    return { success: true, state: await this.getOperationState() };
  }

  async continueOperation() {
    const state = await this.getOperationState();
    if (!state.type) throw new Error('No Git operation is in progress');
    if (state.conflicts.length) throw new Error('Resolve all conflicts before continuing');
    try {
      await execFileAsync(
        'git',
        [state.type, '--continue'],
        {
          cwd: this.repoPath,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_EDITOR: 'true',
            GIT_SEQUENCE_EDITOR: 'true'
          }
        }
      );
      return { success: true, state: await this.getOperationState() };
    } catch (error) {
      throw new Error(`Failed to continue ${state.type}: ${(error as Error).message}`, { cause: error });
    }
  }

  async abortOperation() {
    const state = await this.getOperationState();
    if (!state.type) throw new Error('No Git operation is in progress');
    try {
      await this.git.raw([state.type, '--abort']);
      return { success: true, state: await this.getOperationState() };
    } catch (error) {
      throw new Error(`Failed to abort ${state.type}: ${(error as Error).message}`, { cause: error });
    }
  }

  async skipOperation() {
    const state = await this.getOperationState();
    const operationType = state.type;
    if (operationType !== 'rebase' && operationType !== 'cherry-pick') {
      throw new Error('Only rebase and cherry-pick operations can skip a commit');
    }
    try {
      await this.git.raw([operationType, '--skip']);
      return { success: true, state: await this.getOperationState() };
    } catch (error) {
      throw new Error(`Failed to skip ${operationType}: ${(error as Error).message}`, { cause: error });
    }
  }

  async resolveGitPath(name: string): Promise<string> {
    const value = (await this.git.raw(['rev-parse', '--git-path', name])).trim();
    return nodePath.isAbsolute(value) ? value : nodePath.resolve(this.repoPath, value);
  }

  async readStageBlob(stage: number, relativePath: string): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['show', `:${stage}:${relativePath}`],
        { cwd: this.repoPath, encoding: null, maxBuffer: 50 * 1024 * 1024 }
      );
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
    } catch {
      return Buffer.alloc(0);
    }
  }
}

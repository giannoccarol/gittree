import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

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
  /**
   * Opaque identity of the refs state the page was read from. Passing it back
   * keeps later pages on the same ordering and omits refs the caller already has.
   */
  snapshot?: string;
}

export interface GraphHistoryGit {
  raw(args: string[]): Promise<string>;
  rawWithInput(args: string[], input: string): Promise<string>;
}

export interface GraphHistoryIndexOptions {
  git: GraphHistoryGit;
  repoPath: string;
  maxCachedCommits?: number;
}

interface RefsState {
  id: string;
  graftKey: string;
  refs: GraphRef[];
}

interface GraphSnapshot extends RefsState {
  /** Complete topological order, built on the first page past the prefix. */
  order: CommitOrder | null;
  /** Ids read by the bounded first-page walk while `order` is not built yet. */
  prefix: string[];
  /**
   * Set when the previous snapshot had been paged past its first page: a
   * reload will page deep again, so one rev-list beats a bounded walk first.
   */
  eagerOrder: boolean;
}

// `--topo-order --date-order` is kept verbatim: the later flag wins, so the
// walk is date ordered under the topological constraint, exactly as before.
const GRAPH_WALK = ['--all', '--topo-order', '--date-order'];
const GRAPH_FORMAT = '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s';
const REF_FORMAT = '--format=%(refname)\t%(refname:short)\t'
  // Annotated tags point at a tag object; peel to the commit so graph chips attach.
  + '%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)\t%(upstream:short)';
const GRAPH_REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];
const SNAPSHOT_TOKEN = /^[0-9a-f]{8,64}$/;

/**
 * Ordered commit ids of one snapshot, stored as fixed-width lines of a single
 * string so very large histories stay compact and slicing stays O(page).
 */
class CommitOrder {
  private text: string;

  private width: number;

  readonly length: number;

  private constructor(text: string, width: number) {
    this.text = text;
    this.width = width;
    this.length = width ? text.length / (width + 1) : 0;
  }

  static parse(raw: string): CommitOrder {
    const exact = CommitOrder.fromText(raw);
    if (exact) return exact;
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    const normalized = CommitOrder.fromText(lines.length ? `${lines.join('\n')}\n` : '');
    if (!normalized) throw new Error('Unexpected commit order from git rev-list');
    return normalized;
  }

  private static fromText(text: string): CommitOrder | null {
    if (!text) return new CommitOrder('', 0);
    const width = text.indexOf('\n');
    if (width <= 0 || text.length % (width + 1) !== 0) return null;
    return CommitOrder.isFixedWidth(text, width) ? new CommitOrder(text, width) : null;
  }

  private static isFixedWidth(text: string, width: number): boolean {
    for (let index = width; index < text.length; index += width + 1) {
      if (text.charCodeAt(index) !== 10) return false;
    }
    return true;
  }

  slice(start: number, end: number): string[] {
    const hashes: string[] = [];
    const last = Math.min(end, this.length);
    for (let index = Math.max(0, start); index < last; index += 1) {
      const from = index * (this.width + 1);
      hashes.push(this.text.slice(from, from + this.width));
    }
    return hashes;
  }
}

export function parseGraphRecords(raw: string): GraphCommit[] {
  return raw
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
}

function copyCommit(commit: GraphCommit): GraphCommit {
  return { ...commit, parents: [...commit.parents] };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Graph history index: owns the refs snapshot, its cached topological order and
 * an immutable per-commit metadata cache. A page is a slice of the cached order,
 * so paging no longer re-walks the whole history with `--skip`, and a reload
 * after a fetch only reads metadata for commits it has never seen.
 */
export class GraphHistoryIndex {
  private git: GraphHistoryGit;

  private repoPath: string;

  private maxCachedCommits: number;

  private snapshot: GraphSnapshot | null = null;

  private commits = new Map<string, GraphCommit>();

  private graftKey = '';

  private shallowPath: string | null = null;

  constructor({ git, repoPath, maxCachedCommits = 200_000 }: GraphHistoryIndexOptions) {
    this.git = git;
    this.repoPath = repoPath;
    this.maxCachedCommits = Math.max(1000, maxCachedCommits);
  }

  static normalizeToken(token: unknown): string | null {
    return typeof token === 'string' && SNAPSHOT_TOKEN.test(token) ? token : null;
  }

  async readRefs(): Promise<GraphRef[]> {
    return (await this.readRefsState()).refs;
  }

  async page(offset: number, limit: number, token: string | null): Promise<GraphPage> {
    const resolved = await this.resolveSnapshot(offset, token);
    let snapshot = resolved.snapshot;
    const count = limit + 1;
    let commits: GraphCommit[];
    if (!snapshot.order && !snapshot.eagerOrder && offset === 0 && count > snapshot.prefix.length) {
      commits = await this.readPrefix(snapshot, count);
    } else {
      if (!snapshot.order && offset + count > snapshot.prefix.length) {
        snapshot = await this.buildOrder(snapshot, resolved.validated);
      }
      const hashes = snapshot.order
        ? snapshot.order.slice(offset, offset + count)
        : snapshot.prefix.slice(offset, offset + count);
      commits = await this.readCommits(hashes);
    }
    const hasMore = commits.length > limit;
    const pageCommits = commits.slice(0, limit);
    return {
      commits: pageCommits,
      refs: token === snapshot.id ? [] : snapshot.refs.map(ref => ({ ...ref })),
      nextOffset: offset + pageCommits.length,
      hasMore,
      snapshot: snapshot.id
    };
  }

  private async resolveSnapshot(
    offset: number,
    token: string | null
  ): Promise<{ snapshot: GraphSnapshot; validated: boolean }> {
    // A continuation page keeps the snapshot its first page was read from.
    if (offset > 0 && token && this.snapshot?.id === token) {
      return { snapshot: this.snapshot, validated: false };
    }
    return { snapshot: this.adopt(await this.readRefsState()), validated: true };
  }

  private adopt(state: RefsState): GraphSnapshot {
    if (this.snapshot?.id === state.id) return this.snapshot;
    if (state.graftKey !== this.graftKey) {
      // Replace refs or a shallow boundary change rewrite parents of known ids.
      this.commits.clear();
      this.graftKey = state.graftKey;
    }
    this.snapshot = {
      ...state,
      order: null,
      prefix: [],
      eagerOrder: Boolean(this.snapshot?.order)
    };
    return this.snapshot;
  }

  /**
   * First paint: a bounded walk is as fast as the old first page and seeds the
   * metadata cache; the complete order is only built when paging past it.
   */
  private async readPrefix(snapshot: GraphSnapshot, count: number): Promise<GraphCommit[]> {
    const raw = await this.git.raw([
      'log', ...GRAPH_WALK, '--parents', '-z', `--max-count=${count}`, GRAPH_FORMAT
    ]);
    const commits = parseGraphRecords(raw);
    this.remember(commits);
    snapshot.prefix = commits.map(commit => commit.hash);
    if (commits.length < count) {
      // The bounded walk reached the root: it already is the complete order.
      snapshot.order = CommitOrder.parse(snapshot.prefix.length ? `${snapshot.prefix.join('\n')}\n` : '');
      snapshot.prefix = [];
    }
    return commits.map(copyCommit);
  }

  /**
   * Builds the complete order of a snapshot. A snapshot read in an earlier call
   * is checked again after the walk: if the refs moved meanwhile, the walk
   * belongs to the new state, which is adopted (and reported by its new id).
   */
  private async buildOrder(snapshot: GraphSnapshot, validated: boolean): Promise<GraphSnapshot> {
    let current = snapshot;
    let checked = validated;
    for (let attempt = 1; ; attempt += 1) {
      const order = CommitOrder.parse(await this.git.raw(['rev-list', ...GRAPH_WALK]));
      if (!checked && attempt < 3) {
        const latest = this.adopt(await this.readRefsState());
        if (latest !== current) {
          current = latest;
          checked = true;
          continue;
        }
      }
      current.order = order;
      current.prefix = [];
      return current;
    }
  }

  private async readCommits(hashes: string[]): Promise<GraphCommit[]> {
    const fetched = new Map<string, GraphCommit>();
    const missing = hashes.filter(hash => !this.commits.has(hash));
    if (missing.length) {
      const raw = await this.git.rawWithInput(
        ['log', '--no-walk=unsorted', '--stdin', '-z', GRAPH_FORMAT],
        `${missing.join('\n')}\n`
      );
      for (const commit of parseGraphRecords(raw)) fetched.set(commit.hash, commit);
    }
    const commits = hashes.map(hash => {
      const commit = fetched.get(hash) ?? this.commits.get(hash);
      if (!commit) throw new Error(`Commit ${hash} is missing from the history index`);
      return copyCommit(commit);
    });
    this.remember([...fetched.values()]);
    return commits;
  }

  private remember(commits: GraphCommit[]): void {
    for (const commit of commits) {
      this.commits.delete(commit.hash);
      this.commits.set(commit.hash, commit);
    }
    if (this.commits.size <= this.maxCachedCommits) return;
    // Evict the oldest tenth at once so eviction stays amortized.
    let excess = this.commits.size - Math.floor(this.maxCachedCommits * 0.9);
    for (const hash of this.commits.keys()) {
      if (excess <= 0) break;
      this.commits.delete(hash);
      excess -= 1;
    }
  }

  private async readRefsState(): Promise<RefsState> {
    const raw = await this.git.raw(['for-each-ref', REF_FORMAT]);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const refs: GraphRef[] = lines
      .map(line => {
        const [fullName, shortName, commit, upstream = ''] = line.split('\t');
        let type: GraphRef['type'] = 'branch';
        if (fullName.startsWith('refs/remotes/')) type = 'remote';
        else if (fullName.startsWith('refs/tags/')) type = 'tag';
        return { fullName, shortName, type, commit, upstream };
      })
      .filter(ref => GRAPH_REF_PREFIXES.some(prefix => ref.fullName.startsWith(prefix)))
      .filter(ref => !ref.fullName.endsWith('/HEAD'));

    let headCommit = '';
    try {
      headCommit = (await this.git.raw(['rev-parse', 'HEAD'])).trim();
      refs.push({
        fullName: 'HEAD',
        shortName: 'HEAD',
        type: 'head',
        commit: headCommit,
        upstream: ''
      });
    } catch { /* HEAD may be unborn */ }

    const shallow = await this.readShallowKey();
    const replaceLines = lines.filter(line => line.startsWith('refs/replace/')).join('\n');
    return {
      id: digest(`${raw}\0${headCommit}\0${shallow}`).slice(0, 32),
      graftKey: digest(`${replaceLines}\0${shallow}`),
      refs
    };
  }

  private async readShallowKey(): Promise<string> {
    try {
      if (this.shallowPath === null) {
        const relative = (await this.git.raw(['rev-parse', '--git-path', 'shallow'])).trim();
        this.shallowPath = nodePath.resolve(this.repoPath, relative);
      }
      const stat = await fs.stat(this.shallowPath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'none';
    }
  }
}

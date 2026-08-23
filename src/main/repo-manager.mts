import * as path from 'node:path';
import * as fs from 'node:fs';
import * as electron from 'electron';

interface ElectronAppLike {
  getPath(name: string): string;
}

function resolveElectronApp(): ElectronAppLike {
  const candidate = electron as unknown as { app?: ElectronAppLike; default?: { app?: ElectronAppLike } };
  return candidate.app ?? candidate.default?.app ?? { getPath: () => '/tmp' };
}

const app: ElectronAppLike = resolveElectronApp();

export function repositoryName(repoPath: unknown): string {
  return path.basename(String(repoPath).replace(/[\\/]+$/, '').replace(/\\/g, '/'));
}

export function normalizedRepositoryPath(repoPath: unknown): string {
  if (typeof repoPath !== 'string' || !repoPath.trim() || !path.isAbsolute(repoPath)) {
    throw new Error('Invalid repository path');
  }
  return path.normalize(repoPath);
}

export function repositoryKey(repoPath: unknown, platform: string = process.platform): string {
  const normalized = normalizedRepositoryPath(repoPath);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export interface RepositoryEntry {
  path: string;
  name: string;
  addedAt: string;
}

export interface RepoManagerOptions {
  platform?: string;
  fileSystem?: typeof fs;
  now?: () => string;
  configPath?: string;
}

export class RepoManager {
  repos: RepositoryEntry[];
  activeRepoIndex: number;
  platform: string;
  fileSystem: typeof fs;
  now: () => string;
  configPath: string;

  constructor(options: RepoManagerOptions = {}) {
    this.repos = [];
    this.activeRepoIndex = -1;
    this.platform = options.platform || process.platform;
    this.fileSystem = options.fileSystem || fs;
    this.now = options.now || (() => new Date().toISOString());
    this.configPath = options.configPath || path.join(app.getPath('userData'), 'repos.json');
    this.loadRepos();
  }

  loadRepos(): void {
    try {
      if (this.fileSystem.existsSync(this.configPath)) {
        const data = this.fileSystem.readFileSync(this.configPath, 'utf-8');
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Invalid repository workspace file');
        }
        const workspace = parsed as { repos?: unknown; activeRepoIndex?: unknown };
        if (!Array.isArray(workspace.repos)) {
          throw new Error('Invalid repository workspace file');
        }
        const seen = new Set<string>();
        this.repos = workspace.repos.flatMap((repository: unknown) => {
          try {
            const entry = repository as { path?: unknown; addedAt?: unknown };
            const normalizedPath = normalizedRepositoryPath(entry?.path);
            const key = repositoryKey(normalizedPath, this.platform);
            if (seen.has(key)) return [];
            seen.add(key);
            return [{
              path: normalizedPath,
              name: repositoryName(normalizedPath),
              addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : this.now()
            }];
          } catch {
            return [];
          }
        });
        const requestedIndex = Number.isInteger(workspace.activeRepoIndex)
          ? workspace.activeRepoIndex as number
          : -1;
        this.activeRepoIndex = requestedIndex >= 0 && requestedIndex < this.repos.length
          ? requestedIndex
          : (this.repos.length > 0 ? 0 : -1);
      }
    } catch {
      this.repos = [];
      this.activeRepoIndex = -1;
    }
  }

  saveRepos(): void {
    let temporaryPath: string | null = null;
    try {
      const dir = path.dirname(this.configPath);
      if (!this.fileSystem.existsSync(dir)) {
        this.fileSystem.mkdirSync(dir, { recursive: true });
      }
      temporaryPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
      this.fileSystem.writeFileSync(temporaryPath, JSON.stringify({
        repos: this.repos,
        activeRepoIndex: this.activeRepoIndex
      }, null, 2));
      this.fileSystem.renameSync(temporaryPath, this.configPath);
      temporaryPath = null;
    } catch (err) {
      console.error('Failed to save repos config:', err);
    } finally {
      if (temporaryPath) {
        try {
          this.fileSystem.rmSync(temporaryPath, { force: true });
        } catch {
          // Best-effort cleanup after a failed atomic replacement.
        }
      }
    }
  }

  addRepo(repoPath: unknown): RepositoryEntry | null {
    const normalizedPath = normalizedRepositoryPath(repoPath);
    const key = repositoryKey(normalizedPath, this.platform);
    const existing = this.repos.find(r => repositoryKey(r.path, this.platform) === key);
    if (existing) {
      this.activeRepoIndex = this.repos.indexOf(existing);
    } else {
      const name = repositoryName(normalizedPath);
      this.repos.push({ path: normalizedPath, name, addedAt: this.now() });
      this.activeRepoIndex = this.repos.length - 1;
    }
    this.saveRepos();
    return this.getActiveRepo();
  }

  addRepos(repoPaths: unknown): { added: RepositoryEntry[]; existing: RepositoryEntry[]; activeRepo: RepositoryEntry | null } {
    const paths = Array.isArray(repoPaths) ? repoPaths : [];
    const existingByPath = new Map<string, RepositoryEntry>(
      this.repos.map(repo => [repositoryKey(repo.path, this.platform), repo])
    );
    const added: RepositoryEntry[] = [];
    const existing: RepositoryEntry[] = [];

    for (const repoPath of paths) {
      if (typeof repoPath !== 'string' || !repoPath.trim()) continue;
      let normalizedPath: string;
      try {
        normalizedPath = normalizedRepositoryPath(repoPath);
      } catch {
        continue;
      }
      const key = repositoryKey(normalizedPath, this.platform);
      const knownRepo = existingByPath.get(key);
      if (knownRepo) {
        if (!existing.includes(knownRepo)) existing.push(knownRepo);
        continue;
      }

      const repo: RepositoryEntry = {
        path: normalizedPath,
        name: repositoryName(normalizedPath),
        addedAt: this.now()
      };
      this.repos.push(repo);
      existingByPath.set(key, repo);
      added.push(repo);
    }

    if (added.length) {
      this.activeRepoIndex = this.repos.indexOf(added[0]);
      this.saveRepos();
    }

    return {
      added,
      existing,
      activeRepo: this.getActiveRepo()
    };
  }

  removeRepo(repoPath: unknown): boolean {
    let key: string;
    try {
      key = repositoryKey(repoPath, this.platform);
    } catch {
      return false;
    }
    const index = this.repos.findIndex(r => repositoryKey(r.path, this.platform) === key);
    if (index === -1) return false;
    this.repos.splice(index, 1);
    if (index < this.activeRepoIndex) {
      this.activeRepoIndex -= 1;
    } else if (this.activeRepoIndex >= this.repos.length) {
      this.activeRepoIndex = this.repos.length - 1;
    }
    this.saveRepos();
    return true;
  }

  setActiveRepo(index: number): RepositoryEntry | null {
    if (index >= 0 && index < this.repos.length) {
      this.activeRepoIndex = index;
      this.saveRepos();
      return this.getActiveRepo();
    }
    return null;
  }

  getActiveRepo(): RepositoryEntry | null {
    if (this.activeRepoIndex >= 0 && this.activeRepoIndex < this.repos.length) {
      return { ...this.repos[this.activeRepoIndex] };
    }
    return null;
  }

  getAllRepos(): RepositoryEntry[] {
    return this.repos.map(repository => ({ ...repository }));
  }
}

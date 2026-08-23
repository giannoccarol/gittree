interface Bridge {
  getBranchMetadata(repoPath: string): Promise<unknown>;
  getStatus(repoPath: string): Promise<unknown>;
  getOperationState(repoPath: string): Promise<unknown>;
}

export class RepositoryLoadSession {
  bridge: Bridge;
  repoPath: string;
  reads: Map<string, Promise<unknown>>;

  constructor(bridge: Bridge, repoPath: string) {
    this.bridge = bridge;
    this.repoPath = repoPath;
    this.reads = new Map();
  }

  branchMetadata(): Promise<unknown> {
    return this.readOnce('branchMetadata', () => this.bridge.getBranchMetadata(this.repoPath));
  }

  status(): Promise<unknown> {
    return this.readOnce('status', () => this.bridge.getStatus(this.repoPath));
  }

  operationState(): Promise<unknown> {
    return this.readOnce('operationState', () => this.bridge.getOperationState(this.repoPath));
  }

  readOnce(key: string, load: () => unknown): Promise<unknown> {
    if (!this.reads.has(key)) {
      try {
        this.reads.set(key, Promise.resolve(load()));
      } catch (error) {
        this.reads.set(key, Promise.reject(error));
      }
    }
    return this.reads.get(key) as Promise<unknown>;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { RepositoryLoadSession: typeof RepositoryLoadSession }).RepositoryLoadSession = RepositoryLoadSession;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = RepositoryLoadSession;
}

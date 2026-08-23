export interface RepositoryEntry {
  path: string;
  name?: string;
}

export interface RepositoryWorkspaceCallbacks {
  syncRemoteBusyUI: () => void;
  restoreWorkspaceMode: (repoPath: string) => void;
  loadStashes: (repoPath: string) => Promise<unknown>;
  loadTags: (repoPath: string) => Promise<unknown>;
  loadWorktreeAgents?: (repo: RepositoryEntry) => Promise<unknown>;
  updateStatus: (repoPath: string, loadSession?: { status(): Promise<unknown> } | null) => Promise<unknown>;
  syncCurrentRepositoryState: (repoPath: string) => string | null | undefined;
}

export interface RepositoryWorkspaceComponents {
  welcome: { hide: () => void; markStep?: (step: string) => void };
  graphView: { load: (repoPath: string) => Promise<void>; select: (hash: string) => void };
  branchList: { load: (repoPath: string, loadSession?: WorkspaceLoadSession | null, options?: { background?: boolean }) => Promise<void> };
  changes: { load: (repoPath: string) => Promise<void> };
  pullRequests: { load: (repoPath: string, loadSession?: { branchMetadata(): Promise<unknown> } | null) => Promise<void> };
  diffViewer: { clear: () => void };
  statusBar: { setBranch: (label: string) => void; setRepo: (name?: string) => void };
  conflict: { open: (state?: OperationStateInfo | null) => Promise<void> };
}

interface WorkspaceBridge {
  platform?: string;
  getBranchMetadata(repoPath: string): Promise<unknown>;
  getStatus(repoPath: string): Promise<unknown>;
  getOperationState(repoPath: string): Promise<unknown>;
}

import type { OperationStateInfo } from './components/conflict-resolver.mts';

export interface WorkspaceLoadSession {
  branchMetadata(): Promise<unknown>;
  status(): Promise<unknown>;
  operationState(): Promise<unknown>;
}

export interface RepositoryWorkspaceDependencies {
  bridge: WorkspaceBridge;
  document: Document;
  translate: (key: string, options?: Record<string, unknown>) => string;
  state: { repo: RepositoryEntry | null };
  components: RepositoryWorkspaceComponents;
  createLoadSession: (bridge: WorkspaceBridge, repoPath: string) => WorkspaceLoadSession;
  callbacks: RepositoryWorkspaceCallbacks;
}

export class RepositoryWorkspaceController {
  bridge: WorkspaceBridge;
  document: Document;
  translate: (key: string, options?: Record<string, unknown>) => string;
  state: { repo: RepositoryEntry | null };
  components: RepositoryWorkspaceComponents;
  createLoadSession: RepositoryWorkspaceDependencies['createLoadSession'];
  callbacks: RepositoryWorkspaceCallbacks;
  loadToken: number;

  constructor({
    bridge,
    document,
    translate,
    state,
    components,
    createLoadSession,
    callbacks
  }: RepositoryWorkspaceDependencies) {
    this.bridge = bridge;
    this.document = document;
    this.translate = translate;
    this.state = state;
    this.components = components;
    this.createLoadSession = createLoadSession;
    this.callbacks = callbacks;
    this.loadToken = 0;
  }

  pathKey(value: unknown): string {
    const normalized = String(value);
    return this.bridge?.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  }

  isCurrentRepository(repoPath?: string): boolean {
    if (!repoPath) return false;
    const current = this.state.repo?.path;
    return Boolean(current) && this.pathKey(repoPath) === this.pathKey(current);
  }

  async open(repo: RepositoryEntry, options: { selectHash?: string } = {}): Promise<void> {
    const loadToken = ++this.loadToken;
    const loadSession = this.createLoadSession(this.bridge, repo.path);
    this.state.repo = repo;
    this.components.welcome.hide();
    this.callbacks.syncRemoteBusyUI();
    this.setLoading(true);
    this.callbacks.restoreWorkspaceMode(repo.path);

    try {
      const graphLoad = this.components.graphView.load(repo.path);
      const supportingLoad = Promise.all([
        this.components.branchList.load(repo.path, loadSession),
        this.components.changes.load(repo.path),
        this.components.pullRequests.load(repo.path, loadSession),
        this.callbacks.loadStashes(repo.path),
        this.callbacks.loadTags(repo.path),
        this.callbacks.loadWorktreeAgents?.(repo),
        this.callbacks.updateStatus(repo.path, loadSession)
      ]);
      // Attach a handler immediately while the graph retains visual priority.
      // The promise remains awaited below so its failure semantics are unchanged.
      supportingLoad.catch(() => {});

      await graphLoad;
      if (loadToken !== this.loadToken) return;
      this.components.diffViewer.clear();
      if (options.selectHash) this.components.graphView.select(options.selectHash);
      this.setInteractive();

      await supportingLoad;
      if (loadToken !== this.loadToken) return;
      const branchName = this.callbacks.syncCurrentRepositoryState(repo.path);
      this.components.statusBar.setBranch(
        branchName ? this.translate('statusBar.onBranch', { branch: branchName }) : ''
      );
      this.components.statusBar.setRepo(repo.name);
      this.components.welcome?.markStep?.('open');
      const operationState = await loadSession.operationState() as OperationStateInfo | null;
      if (loadToken === this.loadToken && operationState?.type) {
        await this.components.conflict.open(operationState);
      }
    } finally {
      if (loadToken === this.loadToken) this.setLoading(false);
    }
  }

  setLoading(loading: boolean): void {
    const workspace = this.document.getElementById('workspace')!;
    workspace?.classList.toggle('is-project-loading', loading);
    workspace?.setAttribute('aria-busy', String(loading));
    if (workspace) workspace.dataset.loadState = loading ? 'loading' : 'settled';
    this.document
      .querySelectorAll('#branch-loading-indicator, #workspace-loading-indicator, #inspector-loading-indicator')
      .forEach(indicator => indicator.classList.toggle('is-hidden', !loading));
    this.document.getElementById('sidebar')!?.setAttribute('aria-busy', String(loading));
    this.document.querySelector('.main')?.setAttribute('aria-busy', String(loading));
    this.document.getElementById('detail-panel')!?.setAttribute('aria-busy', String(loading));
  }

  setInteractive(): void {
    const workspace = this.document.getElementById('workspace')!;
    if (workspace) workspace.dataset.loadState = 'interactive';
    this.document
      .querySelectorAll('#workspace-loading-indicator, #inspector-loading-indicator')
      .forEach(indicator => indicator.classList.add('is-hidden'));
    this.document.querySelector('.main')?.setAttribute('aria-busy', 'false');
    this.document.getElementById('detail-panel')!?.setAttribute('aria-busy', 'false');
  }

  destroy(): void {
    this.loadToken += 1;
    this.setLoading(false);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { RepositoryWorkspaceController: typeof RepositoryWorkspaceController }).RepositoryWorkspaceController = RepositoryWorkspaceController;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = RepositoryWorkspaceController;
}

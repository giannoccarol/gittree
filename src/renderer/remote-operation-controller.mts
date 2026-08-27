type RemoteBridge = {
  fetch: (repoPath: string) => Promise<unknown>;
  pull: (repoPath: string) => Promise<unknown>;
  push: (
    repoPath: string,
    remote?: string,
    branch?: string | null,
    setUpstream?: boolean
  ) => Promise<unknown>;
};

interface PushContext {
  remote: string;
  branch: string;
  setUpstream: boolean;
}

type OperationAction = 'fetch' | 'pull' | 'push';

interface RemoteLoadSession {
  branchMetadata(): Promise<unknown>;
  status(): Promise<unknown>;
  operationState(): Promise<{ type?: string }>;
}

interface OperationConfig {
  buttonId: string;
  progressKey: string;
  successKey: string;
}

const operations: Record<OperationAction, OperationConfig> = {
  fetch: {
    buttonId: 'btn-fetch',
    progressKey: 'feedback.fetching',
    successKey: 'feedback.fetchComplete'
  },
  pull: {
    buttonId: 'btn-pull',
    progressKey: 'feedback.pulling',
    successKey: 'feedback.pullComplete'
  },
  push: {
    buttonId: 'btn-push',
    progressKey: 'feedback.pushing',
    successKey: 'feedback.pushComplete'
  }
};

export interface RemoteOperationDependencies {
  bridge: RemoteBridge;
  document: Document;
  translate: (key: string) => string;
  notify: (message: string, type?: string) => void;
  getCurrentRepository: () => { path?: string } | null;
  getPushContext?: () => PushContext | null;
  isCurrentRepository: (repoPath?: string) => boolean;
  repoTabs: {
    setSyncBusy: (repoPath: string, busy: boolean) => void;
    refreshAllSync: () => Promise<void>;
  };
  createLoadSession: (repoPath: string) => unknown;
  views: {
    refreshGraph: (repoPath: string, options?: Record<string, unknown>) => Promise<void>;
    refreshBranches: (repoPath: string, loadSession: RemoteLoadSession, options?: Record<string, unknown>) => Promise<void>;
    refreshStatus: (repoPath: string, loadSession: RemoteLoadSession) => Promise<void>;
    refreshChanges: (repoPath: string, options?: Record<string, unknown>) => Promise<void>;
    syncCurrent: (repoPath: string) => void;
  };
}

interface CurrentOperation {
  action: OperationAction | undefined;
  repoPath: string | undefined;
  external: boolean;
}

export class RemoteOperationController {
  bridge: RemoteBridge;
  document: Document;
  translate: (key: string) => string;
  notify: (message: string, type?: string) => void;
  getCurrentRepository: () => { path?: string } | null;
  getPushContext?: () => PushContext | null;
  isCurrentRepository: (repoPath?: string) => boolean;
  repoTabs: RemoteOperationDependencies['repoTabs'];
  createLoadSession: (repoPath: string) => unknown;
  views: RemoteOperationDependencies['views'];
  currentOperation: CurrentOperation | null;
  visualGeneration: number;

  constructor({
    bridge,
    document: documentRef,
    translate,
    notify,
    getCurrentRepository,
    getPushContext,
    isCurrentRepository,
    repoTabs,
    createLoadSession,
    views
  }: RemoteOperationDependencies) {
    this.bridge = bridge;
    this.document = documentRef;
    this.translate = translate;
    this.notify = notify;
    this.getCurrentRepository = getCurrentRepository;
    this.getPushContext = getPushContext;
    this.isCurrentRepository = isCurrentRepository;
    this.repoTabs = repoTabs;
    this.createLoadSession = createLoadSession;
    this.views = views;
    this.currentOperation = null;
    this.visualGeneration = 0;
  }

  get busy(): boolean {
    return Boolean(this.currentOperation);
  }

  async run(action: OperationAction): Promise<{ error?: string } | null> {
    const config = operations[action];
    const repo = this.getCurrentRepository();
    if (!config || !repo?.path || this.busy) return null;

    const repoPath = repo.path;
    const operation: CurrentOperation = { action, repoPath, external: false };
    this.currentOperation = operation;
    this.visualGeneration += 1;
    this.syncUI();
    this.repoTabs.setSyncBusy(repoPath, true);
    this.notify(this.translate(config.progressKey));

    let outcome = 'error';
    let result: { error?: string } | undefined;
    try {
      if (action === 'push') {
        const pushContext = this.getPushContext?.();
        result = pushContext
          ? await this.bridge.push(
            repoPath,
            pushContext.remote,
            pushContext.branch,
            pushContext.setUpstream
          ) as { error?: string }
          : await this.bridge.push(repoPath) as { error?: string };
      } else {
        result = await (this.bridge[action] as (repoPath?: string) => Promise<{ error?: string }>)(repoPath);
      }
      if (result?.error) {
        this.notify(result.error, 'error');
        return result;
      }
      await this.refreshAfter(action, repoPath);
      this.notify(this.translate(config.successKey), 'success');
      outcome = 'success';
      return result;
    } catch (error) {
      result = { error: (error as Error).message || String(error) };
      this.notify(String(result.error), 'error');
      return result;
    } finally {
      this.repoTabs.setSyncBusy(repoPath, false);
      if (this.currentOperation === operation) this.currentOperation = null;
      this.syncUI();
      if (this.isCurrentRepository(repoPath)) {
        await this.showCompletion(config.buttonId, outcome);
      }
    }
  }

  async refreshAfter(action: OperationAction, repoPath: string): Promise<void> {
    if (!this.isCurrentRepository(repoPath)) {
      await this.repoTabs.refreshAllSync();
      return;
    }
    const loadSession = this.createLoadSession(repoPath) as RemoteLoadSession;
    const tasks = [
      this.views.refreshGraph(repoPath, { preserveViewport: true }),
      this.views.refreshBranches(repoPath, loadSession, { background: true }),
      this.views.refreshStatus(repoPath, loadSession)
    ];
    if (action === 'pull') {
      tasks.push(this.views.refreshChanges(repoPath, { background: true }));
    }
    await Promise.all(tasks);
    if (this.isCurrentRepository(repoPath)) this.views.syncCurrent(repoPath);
  }

  setExternalBusy(buttonId: string, busy: boolean, repoPath: string | undefined = this.getCurrentRepository()?.path): boolean {
    if (busy) {
      if (this.currentOperation) return false;
      const action = (Object.keys(operations) as OperationAction[]).find(key => operations[key].buttonId === buttonId);
      this.currentOperation = { action, repoPath, external: true };
      this.visualGeneration += 1;
    } else if (this.currentOperation?.external) {
      this.currentOperation = null;
    }
    this.syncUI();
    return true;
  }

  syncUI(): void {
    const operation = this.currentOperation;
    const visibleOperation = operation
      && this.isCurrentRepository(operation.repoPath)
      ? operation.action
      : null;
    for (const [action, config] of Object.entries(operations)) {
      const button = this.document.getElementById(config.buttonId) as HTMLButtonElement | null;
      if (!button) continue;
      const icon = button.querySelector(':scope > i') as HTMLElement | null;
      if (icon && !icon.dataset.originalIcon) icon.dataset.originalIcon = icon.className;
      const active = action === visibleOperation;
      button.disabled = Boolean(operation);
      button.classList.toggle('is-busy', active);
      button.classList.remove('is-complete', 'is-error');
      button.dataset.operationState = active ? 'running' : 'idle';
      button.setAttribute('aria-busy', String(active));
      if (icon) {
        icon.className = active ? 'ph ph-circle-notch' : (icon.dataset.originalIcon ?? icon.className);
      }
    }
  }

  async showCompletion(buttonId: string, outcome: string): Promise<void> {
    const button = this.document.getElementById(buttonId);
    const icon = button?.querySelector(':scope > i') as HTMLElement | null;
    if (!button || !icon) return;
    const generation = ++this.visualGeneration;
    button.classList.add(outcome === 'success' ? 'is-complete' : 'is-error');
    button.dataset.operationState = outcome;
    icon.className = outcome === 'success' ? 'ph ph-check' : 'ph ph-warning-circle';

    await Promise.resolve();
    const animations = typeof button.getAnimations === 'function'
      ? button.getAnimations()
      : [];
    await Promise.allSettled(animations.map(animation => animation.finished));
    if (generation !== this.visualGeneration || this.currentOperation) return;
    button.classList.remove('is-complete', 'is-error');
    button.dataset.operationState = 'idle';
    icon.className = icon.dataset.originalIcon ?? 'ph';
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { RemoteOperationController: typeof RemoteOperationController }).RemoteOperationController = RemoteOperationController;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = RemoteOperationController;
}

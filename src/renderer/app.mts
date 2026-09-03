import { WelcomeScreen } from './components/welcome.mts';
import { RepoTabs } from './components/repo-tabs.mts';
import { SettingsView } from './components/settings-view.mts';
import { BranchContextMenu } from './components/branch-context-menu.mts';
import { CommitContextMenu } from './components/commit-context-menu.mts';
import { BranchListView } from './components/branch-list.mts';
import { GraphView } from './components/graph-view.mts';
import { ChangesView } from './components/changes-view.mts';
import { PullRequestView } from './components/pull-request-view.mts';
import { DiffViewer } from './components/diff-viewer.mts';
import { InspectorWorkspace } from './components/inspector-workspace.mts';
import { GlobalSearch } from './components/search.mts';
import { BranchCompare } from './components/branch-compare.mts';
import { CommitCompare } from './components/commit-compare.mts';
import { MergeWorkspace } from './components/merge-workspace.mts';
import { ReflogView } from './components/reflog-view.mts';
import { ConflictResolver } from './components/conflict-resolver.mts';
import { OperationBanner } from './components/operation-banner.mts';
import { GitFlow } from './components/gitflow.mts';
import { RepositoryDashboard } from './components/repository-dashboard.mts';
import { StatusBar } from './components/status-bar.mts';
import { WorktreeAgentPanel } from './components/worktree-agent-panel.mts';
import { RepositoryWorkspaceController, type RepositoryEntry } from './repository-workspace-controller.mts';
import { RepositoryLoadSession } from './repository-load-session.mts';
import { RemoteOperationController } from './remote-operation-controller.mts';
import { WorkspacePanelMotion } from './workspace-panel-motion.mts';
import { WorkspaceStateController } from './workspace-state-controller.mts';
import { ShortcutController } from './shortcut-controller.mts';
import { WorkspaceResizeController } from './workspace-resize-controller.mts';
import { EventBus } from './event-bus.mts';
import { DialogService } from './dialog-service.mts';
import { ToastService } from './toast-service.mts';
import { Theme } from './theme.mts';
import { HtmlEncoder } from './html-encoder.mts';
import { initAiFeatureGate } from './ai-feature-gate.mts';

interface AppState {
  repo: RepositoryEntry | null;
  activeRepoIndex: number;
  currentBranch: string | null;
  stashes: Array<{ message?: string }>;
}

interface AppComponents {
  welcome: WelcomeScreen;
  repoTabs: RepoTabs;
  settings: SettingsView;
  branchContextMenu: BranchContextMenu;
  commitContextMenu: CommitContextMenu;
  branchList: BranchListView;
  graphView: GraphView;
  changes: ChangesView;
  pullRequests: PullRequestView;
  diffViewer: DiffViewer;
  inspectorWorkspace: InspectorWorkspace;
  search: GlobalSearch;
  compare: BranchCompare;
  commitCompare: CommitCompare;
  merge: MergeWorkspace;
  reflog: ReflogView;
  conflict: ConflictResolver;
  operationBanner: OperationBanner;
  gitflow: GitFlow;
  dashboard: RepositoryDashboard;
  statusBar: StatusBar;
  worktreeAgents: WorktreeAgentPanel;
}

interface UpdateStatePayload {
  status?: string;
  availableVersion?: string;
  progress?: number;
  error?: string;
  autoInstall?: boolean;
  cachedInstall?: boolean;
}

interface InspectorPayload extends Record<string, unknown> {
  title?: string;
  meta?: string;
  theme?: string;
  tone?: string;
  mode?: string;
  modeLabel?: string;
  eyebrow?: string;
  wordLevel?: boolean;
  html?: string;
  diffText?: string;
  graph?: Record<string, unknown>;
  files?: DiffViewer['fileSummaries'];
  selectedFile?: string | null;
  filesOpen?: boolean;
}

export interface CheckoutResult {
  branch?: string;
  error?: string;
  conflictState?: { type?: string };
  path?: string;
}

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

export class GitTreeApp {
  state: AppState = { repo: null, activeRepoIndex: -1, currentBranch: null, stashes: [] };
  components: AppComponents = {} as AppComponents;
  inspectorState = 'open';
  workspaceMode = 'history';
  updateState: UpdateStatePayload | null = null;
  _events: Record<string, unknown> = {};
  bus = new EventBus();
  dialogs = new DialogService();
  toasts = new ToastService({
    container: document.getElementById('toast')! as HTMLElement,
    translate: key => window.I18n?.t(key) ?? key,
    encode: value => HtmlEncoder.encode(value)
  });
  repositoryWorkspace!: RepositoryWorkspaceController;
  remoteOperations!: RemoteOperationController;
  panelMotion!: WorkspacePanelMotion;
  workspaceState!: WorkspaceStateController;
  shortcutController!: ShortcutController;
  workspaceResize!: WorkspaceResizeController;
  platform = 'win32';
  windowState: { isMaximized?: boolean } | null = null;
  popoutOpen = false;
  buildInspectorPayload: () => InspectorPayload = () => ({});
  pushInspectorPayload: () => void = () => {};

  pathKey(value: string): string {
    if (this.repositoryWorkspace) return this.repositoryWorkspace.pathKey(value);
    return window.gitTree?.platform === 'win32'
      ? String(value).toLocaleLowerCase('en-US')
      : String(value);
  }

  isCurrentRepo(repoPath?: string): boolean {
    if (this.repositoryWorkspace) {
      return this.repositoryWorkspace.isCurrentRepository(repoPath);
    }
    const current = this.state.repo?.path;
    if (!current) return false;
    return this.pathKey(repoPath ?? '') === this.pathKey(current);
  }

  async init(): Promise<void> {
    initAiFeatureGate();
    this.components.welcome = new WelcomeScreen();
    this.components.repoTabs = new RepoTabs(byId('repo-tab-list'), this, {
      storage: localStorage,
      platform: window.gitTree.platform as string
    });
    this.components.settings = new SettingsView(this);
    this.components.branchContextMenu = new BranchContextMenu(this);
    this.components.commitContextMenu = new CommitContextMenu(this);
    this.components.branchList = new BranchListView(byId('branch-list'), this);
    this.components.graphView = new GraphView(
      byId('graph-view'), byId('graph-body'), this
    );
    this.components.changes = new ChangesView(
      byId('changes-view'),
      this
    );
    this.components.pullRequests = new PullRequestView(
      byId('pull-requests-view'),
      this
    );
    this.components.diffViewer = new DiffViewer(byId('detail-body'), this);
    this.components.inspectorWorkspace = new InspectorWorkspace({
      container: document.getElementById('inspector-workspace')!,
      graphContainer: document.getElementById('inspector-graph-view')!,
      filesPanel: document.getElementById('inspector-files-panel')!,
      fileList: document.getElementById('inspector-file-list')!,
      filesToggle: document.getElementById('btn-toggle-inspector-files')!,
      diffContainer: document.getElementById('detail-body')!,
      translate: t,
      storage: localStorage,
      onGraphSelect: hash => this.components.graphView.select(hash),
      onGraphRequestMore: () => this.components.graphView.loadNextPage(),
      onFileSelect: path => {
        if (this.components.diffViewer.scrollToFile(path)) this.pushInspectorPayload();
      },
      onFilesOpenChange: () => this.pushInspectorPayload()
    });
    this.components.inspectorWorkspace.mount();
    this.components.search = new GlobalSearch(this);
    this.components.compare = new BranchCompare(this);
    this.components.commitCompare = new CommitCompare(this);
    this.components.merge = new MergeWorkspace(this);
    this.components.reflog = new ReflogView(this);
    this.components.conflict = new ConflictResolver(this);
    this.components.operationBanner = new OperationBanner(this);
    this.components.operationBanner.mount();
    this.components.gitflow = new GitFlow(this);
    this.components.dashboard = new RepositoryDashboard({
      container: byId('repository-dashboard'),
      button: byId('btn-dashboard'),
      workspace: byId('workspace-body'),
      bridge: window.gitTree,
      translate: t,
      encode: value => HtmlEncoder.encode(value),
      getRepositories: () => this.components.repoTabs.repos,
      storage: localStorage,
      getLocale: () => window.i18next?.language || 'en'
    });
    this.components.statusBar = new StatusBar();
    this.components.worktreeAgents = new WorktreeAgentPanel(this);
    this.repositoryWorkspace = new RepositoryWorkspaceController({
      bridge: window.gitTree,
      document,
      translate: t,
      state: this.state,
      components: this.components,
      createLoadSession: (bridge, repoPath) => new RepositoryLoadSession(bridge, repoPath),
      callbacks: {
        syncRemoteBusyUI: () => this.syncRemoteBusyUI(),
        restoreWorkspaceMode: repoPath => this.workspaceState.restoreMode(repoPath),
        loadStashes: repoPath => this.loadStashes(repoPath),
        loadTags: repoPath => this.loadTags(repoPath),
        loadWorktreeAgents: repo => this.components.worktreeAgents.load(repo),
        updateStatus: (repoPath, loadSession) => this.updateStatus(repoPath, loadSession),
        syncCurrentRepositoryState: repoPath => this.syncCurrentRepositoryState(repoPath)
      }
    });
    this.remoteOperations = new RemoteOperationController({
      bridge: window.gitTree,
      document,
      translate: t,
      notify: (message, type) => this.showToast(message, type),
      getCurrentRepository: () => this.state.repo,
      getPushContext: () => {
        const currentBranchMetadata = (this.components.branchList.metadata?.branches || [])
          .find(branch => branch.kind === 'local' && branch.current);
        if (!currentBranchMetadata) return null;
        const upstream = currentBranchMetadata.upstream;
        const remote = upstream?.split('/')[0] || 'origin';
        return {
          remote,
          branch: currentBranchMetadata.name,
          setUpstream: !upstream
        };
      },
      isCurrentRepository: repoPath => this.isCurrentRepo(repoPath),
      repoTabs: this.components.repoTabs,
      createLoadSession: repoPath => new RepositoryLoadSession(window.gitTree, repoPath),
      views: {
        refreshGraph: (repoPath, options) => this.components.graphView.load(repoPath, options),
        refreshBranches: (repoPath, session, options) => (
          this.components.branchList.load(repoPath, session, options)
        ),
        refreshChanges: repoPath => this.components.changes.load(repoPath),
        refreshStatus: (repoPath, session) => this.updateStatus(repoPath, session),
        syncCurrent: repoPath => this.syncCurrentRepositoryState(repoPath)
      }
    });
    this.panelMotion = new WorkspacePanelMotion({
      workspace: byId('workspace-body'),
      document,
      panels: {
        sidebar: {
          panel: byId('sidebar'),
          toggle: byId('btn-toggle-sidebar'),
          openingAnimation: 'motion-panel-enter-left',
          closingAnimation: 'motion-panel-exit-left'
        },
        inspector: {
          panel: byId('detail-panel'),
          toggle: byId('btn-toggle-inspector'),
          openingAnimation: 'motion-panel-enter-right',
          closingAnimation: 'motion-panel-exit-right'
        }
      },
      prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
    });
    this.workspaceState = new WorkspaceStateController({
      document,
      storage: localStorage,
      translate: t,
      panelMotion: this.panelMotion,
      state: this.state,
      components: this.components,
      viewportWidth: () => window.innerWidth,
      computedStyle: element => getComputedStyle(element),
      onModeChange: mode => { this.workspaceMode = mode; },
      onInspectorStateChange: state => { this.inspectorState = state; }
    });
    this.shortcutController = new ShortcutController({
      document,
      platform: window.gitTree.platform as string,
      translate: t,
      callbacks: {
        openRepository: () => this.components.welcome.openRepo(),
        fetch: () => this.doFetch(),
        pull: () => this.doPull(),
        push: () => this.doPush(),
        newBranch: () => this.components.branchList.promptCreateBranch(),
        getInspectorState: () => this.inspectorState,
        restoreInspector: () => this.setInspectorState('open')
      }
    });
    this.setupPlatformChrome();

    this.bindEvents();
    await this.setupUpdates();
    this.components.search.init();
    this.components.welcome.init(this);
    this.setupClearableSearches();
    this.setupResize();
    this.setupWorkspaceState();
    this.applyToolbarVisibility();
    this.setupGlobalShortcuts();
    await this.components.repoTabs.init();
    this.components.dashboard.mount();
    this.components.settings.init();
    this.components.worktreeAgents.mount();

    const repos = this.components.repoTabs.repos;
    if (repos && repos.length > 0) {
      const active = await window.gitTree.getActiveRepo() as RepositoryEntry | undefined;
      if (active) {
        this.components.repoTabs.syncActiveIndex(active.path);
        this.components.repoTabs.render();
        await this.openRepo(active);
        return;
      }
    }
  }

  bindEvents(): void {
    this.on('repo:changed', (repo) => { this.openRepo(repo as RepositoryEntry); });
    this.on('repo:cleared', () => this.showWelcome());
    this.on('commit:selected', (hash) => this.onCommitSelected(hash as string));
    this.on('refresh', () => this.refresh());

    byId('btn-add-repo-tab').onclick = () => this.components.welcome.openRepositoryPicker();
    document.querySelectorAll<HTMLElement>('.settings-open').forEach(button => {
      button.onclick = () => this.components.settings.open(null, {
        scope: button.dataset.settingsScope || 'full'
      });
    });

    byId('btn-fetch').onclick = () => this.doFetch();
    byId('btn-pull').onclick = () => this.doPull();
    byId('btn-push').onclick = () => this.doPush();
    byId('btn-new-branch').onclick = () => this.components.branchList.promptCreateBranch();
    byId('btn-gitflow').onclick = () => this.components.gitflow.open();
    byId('btn-terminal').onclick = () => this.openTerminal();
    byId('btn-explorer').onclick = () => this.openExplorer();
    byId('stash-search').addEventListener('input', event => {
      this.renderStashes((event.target as HTMLInputElement).value);
    });
    document.querySelectorAll<HTMLElement>('.theme-toggle').forEach(button => {
      button.onclick = () => Theme.toggle();
    });
    document.querySelectorAll<HTMLElement>('.language-toggle').forEach(button => {
      button.onclick = () => window.I18n?.toggleLanguage();
    });
    document.querySelectorAll<HTMLElement>('.window-minimize').forEach(button => {
      (button as HTMLElement).onclick = () => window.gitTree.minimizeWindow();
    });
    document.querySelectorAll<HTMLElement>('.window-maximize').forEach(button => {
      button.onclick = async () => {
        this.updateWindowChrome(await window.gitTree.toggleMaximizeWindow() as { isMaximized?: boolean });
      };
    });
    document.querySelectorAll<HTMLElement>('.window-close').forEach(button => {
      button.onclick = () => window.gitTree.closeWindow();
    });
    document.querySelectorAll<HTMLElement>('.app-header, .welcome-card').forEach(surface => {
      surface.addEventListener('dblclick', event => {
        if ((event.target as HTMLElement).closest('button, input, .repo-tab')) return;
        window.gitTree.toggleMaximizeWindow().then(state => this.updateWindowChrome(state as { isMaximized?: boolean }));
      });
    });

    window.addEventListener('gittree:language-changed', () => this.refreshLocalizedView());

    this.toasts.mount();
  }

  setupWorkspaceModes(): void {
    this.workspaceState.setMode('history', false);
  }

  workspaceModeKey(repoPath?: string): string {
    return this.workspaceState.modeKey(repoPath);
  }

  setWorkspaceMode(mode: string, persist = true): void {
    this.workspaceState.setMode(mode, persist);
  }

  setupPlatformChrome(): void {
    this.platform = window.gitTree.platform || 'win32';
    this.shortcutController.setPlatform(this.platform);
    document.documentElement.dataset.platform = this.platform;
    this.setupShortcutHints();
    window.gitTree.onWindowState(state => this.updateWindowChrome(state as { isMaximized?: boolean }));
    window.gitTree.getWindowState().then(state => this.updateWindowChrome(state as { isMaximized?: boolean }));
  }

  shortcutDefinitions() {
    return this.shortcutController.definitions();
  }

  shortcutLabel(action: string): string {
    return this.shortcutController.label(action);
  }

  setupShortcutHints(): void {
    this.shortcutController.refreshHints();
  }

  updateWindowChrome(state: { isMaximized?: boolean } | null | undefined): void {
    if (!state) return;
    this.windowState = state;
    document.querySelectorAll<HTMLElement>('.window-maximize').forEach(button => {
      const isRestore = Boolean(state.isMaximized);
      const restoreIcon = this.platform === 'win32'
        ? 'ph-copy-simple'
        : 'ph-corners-in';
      const icon = button.querySelector('i') as HTMLElement;
      icon.className = `ph ${isRestore ? restoreIcon : 'ph-square'}`;
      button.dataset.i18nTitle = isRestore ? 'common.restore' : 'common.maximize';
      button.title = t(button.dataset.i18nTitle as string);
      button.setAttribute('aria-label', button.title);
    });
  }

  isPrimaryModifier(event: MouseEvent | KeyboardEvent): boolean {
    return this.shortcutController.isPrimaryModifier(event as KeyboardEvent);
  }

  async setupUpdates(): Promise<void> {
    const button = byId('btn-update') as HTMLButtonElement;
    button.onclick = async () => {
      if (this.updateState?.status === 'available') {
        button.disabled = true;
        const result = await window.gitTree.downloadUpdate() as { error?: string };
        if (result?.error) this.showToast(result.error, 'error');
      } else if (this.updateState?.status === 'downloaded') {
        const result = await window.gitTree.installUpdate() as { error?: string; manual?: boolean };
        if (result?.error) {
          this.showToast(result.error, 'error');
        } else if (result?.manual) {
          this.showToast(t('updates.manualReady'), 'info');
        }
      }
    };
    window.gitTree.onUpdateState(state => this.handleUpdateState(state as UpdateStatePayload));
    window.gitTree.onStaleInstall?.(payload => {
      const info = payload as { runningVersion?: string; installedVersion?: string };
      this.showToast(t('updates.staleInstall', {
        running: info.runningVersion || '?',
        installed: info.installedVersion || '?'
      }), 'warning');
    });
    this.handleUpdateState(await window.gitTree.getUpdateState() as UpdateStatePayload);
  }

  handleUpdateState(state: UpdateStatePayload | null): void {
    if (!state) return;
    const previousStatus = this.updateState?.status;
    this.updateState = state;
    const button = byId('btn-update') as HTMLButtonElement;
    const icon = button.querySelector('i') as HTMLElement;
    const label = button.querySelector('span') as HTMLElement;
    button.disabled = ['downloading', 'checking', 'installing'].includes(String(state.status));
    button.classList.toggle(
      'is-hidden',
      !['available', 'downloading', 'downloaded', 'installing'].includes(String(state.status))
    );

    if (state.status === 'available') {
      icon.className = 'ph ph-download-simple';
      label.textContent = t('updates.availableVersion', { version: state.availableVersion });
      if (previousStatus !== 'available') {
        this.showToast(t('updates.availableVersion', { version: state.availableVersion }), 'success');
      }
    } else if (state.status === 'downloading') {
      icon.className = 'ph ph-circle-notch';
      label.textContent = t('updates.downloading', { progress: state.progress });
    } else if (state.status === 'installing') {
      icon.className = 'ph ph-circle-notch';
      label.textContent = t('updates.installing');
    } else if (state.status === 'downloaded') {
      if (state.cachedInstall) {
        icon.className = 'ph ph-package';
        label.textContent = t('updates.installPackage');
      } else if (state.autoInstall === false) {
        icon.className = 'ph ph-arrow-square-out';
        label.textContent = t('updates.manualInstall');
      } else {
        icon.className = 'ph ph-arrows-clockwise';
        label.textContent = t('updates.restart');
      }
      if (state.error && previousStatus !== 'downloaded') {
        this.showToast(t('updates.failed', { error: state.error }), 'error');
      } else if (!state.error && previousStatus !== 'downloaded') {
        this.showToast(
          state.cachedInstall
            ? t('updates.cachedReady')
            : state.autoInstall === false
              ? t('updates.manualReady')
              : t('updates.ready'),
          'success'
        );
      }
    } else if (state.status === 'error' && state.error) {
      this.showToast(t('updates.failed', { error: state.error }), 'error');
    }
  }

  async openRepo(repo: RepositoryEntry, options?: Record<string, unknown>): Promise<void> {
    return this.repositoryWorkspace.open(repo, options);
  }

  setProjectLoading(loading: boolean): void {
    this.repositoryWorkspace.setLoading(loading);
  }

  setProjectInteractive(): void {
    this.repositoryWorkspace.setInteractive();
  }

  async loadStashes(repoPath: string): Promise<void> {
    const container = byId('stash-list');
    container.classList.add('is-project-loading');
    container.innerHTML = this.projectLoadingMarkup();
    try {
      const list = await window.gitTree.getStashList(repoPath) as { all?: Array<{ message?: string }> } | undefined;
      if (!this.isCurrentRepo(repoPath)) return;
      this.state.stashes = list?.all || [];
      this.renderStashes((document.getElementById('stash-search')! as HTMLInputElement | null)?.value || '');
    } catch {
      this.state.stashes = [];
      container.innerHTML = '';
    } finally { container.classList.remove('is-project-loading'); }
  }

  renderStashes(filter = ''): void {
    const container = byId('stash-list');
    if (!container) return;
    const needle = String(filter || '').trim().toLowerCase();
    const items = (this.state.stashes || [])
      .map((stash, index) => ({ index, label: stash.message || `Stash ${index}` }))
      .filter(item => !needle || item.label.toLowerCase().includes(needle));
    if (!items.length) { container.innerHTML = ''; return; }
    container.innerHTML = items.map(item => `
      <div class="branch-item stash-item" data-stash-index="${item.index}">
        <i class="ph ph-archive branch-icon" aria-hidden="true"></i>
        <span class="branch-name">${this.esc(item.label)}</span>
        <span class="stash-actions" role="group" aria-label="${this.esc(t('sidebar.stashActions'))}">
          <button type="button" class="icon-btn stash-action" data-action="pop" title="${this.esc(t('sidebar.stashPop'))}" aria-label="${this.esc(t('sidebar.stashPop'))}">
            <i class="ph ph-play" aria-hidden="true"></i>
          </button>
          <button type="button" class="icon-btn stash-action" data-action="apply" title="${this.esc(t('sidebar.stashApply'))}" aria-label="${this.esc(t('sidebar.stashApply'))}">
            <i class="ph ph-copy" aria-hidden="true"></i>
          </button>
          <button type="button" class="icon-btn stash-action is-danger" data-action="drop" title="${this.esc(t('sidebar.stashDrop'))}" aria-label="${this.esc(t('sidebar.stashDrop'))}">
            <i class="ph ph-trash" aria-hidden="true"></i>
          </button>
        </span>
      </div>
    `).join('');
    container.querySelectorAll<HTMLElement>('.stash-item').forEach(item => {
      item.querySelectorAll<HTMLElement>('[data-action]').forEach(button => {
        button.onclick = event => {
          event.stopPropagation();
          const index = Number((item as HTMLElement).dataset.stashIndex);
          this.runStashAction(button.dataset.action ?? '', index);
        };
      });
    });
  }

  async runStashAction(action: string, index: number): Promise<void> {
    const repo = this.state.repo;
    if (!repo || !Number.isInteger(index)) return;
    if (action === 'drop') {
      const confirmed = await this.confirmDialog(
        t('sidebar.stashDropTitle'),
        t('sidebar.stashDropConfirm'),
        t('sidebar.stashDrop')
      );
      if (!confirmed) return;
    }
    const api = action === 'pop'
      ? window.gitTree.stashPop
      : action === 'apply'
        ? window.gitTree.stashApply
        : action === 'drop'
          ? window.gitTree.stashDrop
          : null;
    if (!api) return;
    const result = await api(repo.path, index) as { error?: string };
    if (result?.error) { this.showToast(result.error, 'error'); return; }
    if (action === 'pop' || action === 'drop') {
      await this.loadStashes(repo.path);
      await this.refresh();
    } else {
      this.showToast(t('feedback.stashApplied'), 'success');
      await this.refresh();
    }
  }

  confirmDialog(title: string, message: string, actionLabel: string, danger = false): Promise<unknown> {
    return this.dialogs.confirm({
      title,
      message,
      cancelLabel: t('common.cancel'),
      actionLabel,
      danger
    });
  }

  async loadTags(repoPath: string): Promise<void> {
    const container = byId('tag-list');
    container.classList.add('is-project-loading');
    container.innerHTML = this.projectLoadingMarkup();
    try {
      const tags = await window.gitTree.getTags(repoPath) as { all?: string[] } | undefined;
      if (!this.isCurrentRepo(repoPath)) return;
      if (!tags?.all?.length) { container.innerHTML = ''; return; }
      container.innerHTML = tags.all.slice(0, 10).map(tag => `
        <div class="branch-item">
          <i class="ph ph-tag branch-icon"></i>
          <span>${this.esc(tag)}</span>
        </div>
      `).join('');
    } catch { container.innerHTML = ''; }
    finally { container.classList.remove('is-project-loading'); }
  }

  projectLoadingMarkup(): string {
    return `<div class="project-loading-inline" role="status" aria-live="polite">
      <i class="ph ph-circle-notch" aria-hidden="true"></i>
      <span>${t('common.loading')}</span>
    </div>`;
  }

  async updateStatus(repoPath: string, loadSession?: { status(): Promise<unknown> } | null): Promise<void> {
    try {
      const status = await (loadSession?.status() || window.gitTree.getStatus(repoPath)) as {
        error?: string;
        current?: string;
        ahead?: number;
        behind?: number;
        isClean?: boolean;
      } | undefined;
      if (!status || status.error) return;
      if (!this.isCurrentRepo(repoPath)) return;
      this.state.currentBranch = status.current ?? null;
      const parts = [];
      if (status.ahead) parts.push(`↑${status.ahead}`);
      if (status.behind) parts.push(`↓${status.behind}`);
      byId('status-branch').textContent = status.current
        ? t('statusBar.onBranch', { branch: status.current })
        : '';
      const info = parts.length
        ? parts.join(' ')
        : (status.isClean ? t('statusBar.clean') : t('statusBar.modified'));
      byId('status-info').textContent = info;
      this.components.statusBar.setInfo(info);
      this.updatePushPullCounts(status.ahead || 0, status.behind || 0);
    } catch { /* status refresh is best effort */ }
  }

  updatePushPullCounts(ahead = 0, behind = 0): void {
    const pullCount = document.getElementById('btn-pull-count')!;
    const pushCount = document.getElementById('btn-push-count')!;
    if (pullCount) {
      const show = behind > 0;
      pullCount.textContent = show ? String(behind) : '';
      pullCount.hidden = !show;
      pullCount.classList.toggle('is-hidden', !show);
    }
    if (pushCount) {
      const show = ahead > 0;
      pushCount.textContent = show ? String(ahead) : '';
      pushCount.hidden = !show;
      pushCount.classList.toggle('is-hidden', !show);
    }
  }

  syncCurrentRepositoryState(repoPath: string): string {
    if (!this.isCurrentRepo(repoPath)) return '';
    const branchName = this.components.branchList.current || '';
    const currentBranchMetadata = (this.components.branchList.metadata?.branches || [])
      .find(branch => branch.kind === 'local' && branch.current);
    this.components.repoTabs.updateSync(repoPath, currentBranchMetadata
      ? {
          branch: currentBranchMetadata.name,
          upstream: currentBranchMetadata.upstream,
          ahead: currentBranchMetadata.ahead,
          behind: currentBranchMetadata.behind
        }
      : null);
    this.updatePushPullCounts(
      currentBranchMetadata?.ahead || 0,
      currentBranchMetadata?.behind || 0
    );
    this.components.statusBar.setBranch(branchName ?? '');
    return branchName;
  }

  animateContentRefresh(element: HTMLElement | null): void {
    if (!element) return;
    element.classList.remove('content-refresh');
    void element.offsetWidth;
    element.classList.add('content-refresh');
  }

  animateBranchSwitch(element: HTMLElement | null, fromDirection: string | null): void {
    if (!element) return;
    const next = fromDirection === 'top' ? 'content-refresh-from-top'
      : fromDirection === 'bottom' ? 'content-refresh-from-bottom'
      : 'content-refresh';
    element.classList.remove('content-refresh', 'content-refresh-from-top', 'content-refresh-from-bottom');
    void element.offsetWidth;
    element.classList.add(next);
  }

  async onCommitSelected(hash: string): Promise<void> {
    if (!this.state.repo) return;
    await this.components.diffViewer.showDiffForCommit(this.state.repo.path, hash);
    this.animateContentRefresh(document.getElementById('detail-body')!);
    this.syncInspectorWorkspace();
  }

  syncInspectorWorkspace(options: { push?: boolean } = {}): void {
    const graph = this.components.graphView?.getInspectorSnapshot?.() || {
      revision: 0,
      laneCount: 1,
      hasMore: false,
      selectedHash: null,
      rows: []
    };
    this.components.inspectorWorkspace?.update({
      graph,
      selectedHash: graph.selectedHash as string | null,
      files: this.components.diffViewer?.fileSummaries || [],
      selectedFile: this.components.diffViewer?.selectedFilePath || null
    });
    if (options.push !== false) this.pushInspectorPayload();
  }

  async afterBranchCheckout(result: CheckoutResult = {}, repoPath: string | null = null): Promise<void> {
    const repo = this.state.repo;
    const branchName = result.branch;
    if (!repo || !branchName) return;
    if (repoPath && !this.isCurrentRepo(repoPath)) return;

    this.components.branchList.setCurrentBranch(branchName);
    this.components.diffViewer.clear();
    const fromDirection = this.components.branchList.switchFromDirection;
    this.components.branchList.switchFromDirection = null;
    this.animateBranchSwitch(this.components.graphView.body, fromDirection);
    const loadSession = new RepositoryLoadSession(window.gitTree, repo.path);
    await Promise.all([
      this.components.graphView.load(repo.path),
      this.components.changes.load(repo.path),
      this.updateStatus(repo.path, loadSession),
      this.components.branchList.load(repo.path, loadSession, { background: true })
    ]);

    const currentBranchMetadata = (this.components.branchList.metadata?.branches || [])
      .find(branch => branch.kind === 'local' && branch.name === branchName);
    this.components.repoTabs.updateSync(repo.path, currentBranchMetadata
      ? {
          branch: currentBranchMetadata.name,
          upstream: currentBranchMetadata.upstream,
          ahead: currentBranchMetadata.ahead,
          behind: currentBranchMetadata.behind
        }
      : null);
    this.updatePushPullCounts(
      currentBranchMetadata?.ahead || 0,
      currentBranchMetadata?.behind || 0
    );
    this.components.statusBar.setBranch(String(branchName));
    this.components.welcome.markStep?.('branch');
    this.pushInspectorPayload();
  }

  async refresh(options: { silent?: boolean } & Record<string, unknown> = {}): Promise<void> {
    if (!this.state.repo) return;
    if (!options.silent) this.showToast(t('common.loading'));
    await this.openRepo(this.state.repo, options);
    this.components.repoTabs.refreshAllSync();
    await this.syncOperationBanner();
    if (this.components.dashboard?.active) {
      await this.components.dashboard.refresh({ force: true });
    }
    if (!options.silent) this.showToast(t('feedback.refreshed'), 'success');
  }

  async syncOperationBanner(): Promise<void> {
    const repo = this.state.repo;
    if (!repo) {
      this.components.operationBanner?.setOperation(null);
      return;
    }
    try {
      const state = await window.gitTree.getOperationState(repo.path) as { type?: string } | null;
      // If conflict resolver is visible, let it own the banner
      const conflictVisible = !this.components.conflict?.container?.classList.contains('is-hidden');
      if (conflictVisible && state?.type) {
        this.components.operationBanner?.setOperation(null);
      } else {
        this.components.operationBanner?.setOperation(state as never);
      }
    } catch {
      this.components.operationBanner?.setOperation(null);
    }
  }

  async doFetch(): Promise<{ error?: string } | null> {
    return this.remoteOperations.run('fetch');
  }

  async doPull(): Promise<{ error?: string } | null> {
    return this.remoteOperations.run('pull');
  }

  async openTerminal(): Promise<void> {
    const repo = this.state.repo;
    if (!repo) return;
    const result = await window.gitTree.openTerminal(repo.path) as { error?: string };
    if (result?.error) this.showToast(result.error, 'error');
  }

  async openExplorer(): Promise<void> {
    const repo = this.state.repo;
    if (!repo) return;
    const result = await window.gitTree.openExplorer(repo.path) as { error?: string };
    if (result?.error) this.showToast(result.error, 'error');
  }

  toolbarButtons(): Record<string, string> {
    return {
      gitflow: 'btn-gitflow',
      terminal: 'btn-terminal',
      explorer: 'btn-explorer'
    };
  }

  readToolbarVisibility(): Record<string, boolean> {
    const defaults = { gitflow: true, terminal: true, explorer: true };
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('gittree.settings.toolbar') ?? 'null');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...(parsed as Record<string, boolean>) };
      }
    } catch { /* invalid stored visibility falls back to defaults */ }
    return defaults;
  }

  applyToolbarVisibility(): void {
    const visibility = this.readToolbarVisibility();
    for (const [key, id] of Object.entries(this.toolbarButtons())) {
      const button = document.getElementById(id);
      if (button) button.classList.toggle('is-hidden', visibility[key] === false);
    }
  }

  async doPush(): Promise<{ error?: string } | null> {
    return this.remoteOperations.run('push');
  }

  setRemoteActionBusy(activeId: string, busy: boolean): boolean {
    return this.remoteOperations.setExternalBusy(activeId, busy);
  }

  syncRemoteBusyUI(): void {
    this.remoteOperations.syncUI();
  }

  showWelcome(): void {
    this.components.dashboard?.close();
    this.state.repo = null;
    this.components.operationBanner?.setOperation(null);
    this.components.changes?.setActive(false);
    this.components.pullRequests?.setActive(false);
    this.components.welcome.show();
    this.components.graphView.body.innerHTML = `<div class="empty-state">${t('welcome.open')}</div>`;
    this.components.diffViewer.clear();
    this.components.statusBar.clear();
  }

  setupClearableSearches(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>('.search-clearable').forEach(wrapper => {
      if (wrapper.dataset.clearBound === '1') return;
      const input = wrapper.querySelector<HTMLInputElement>('input');
      const button = wrapper.querySelector<HTMLButtonElement>('.search-clear-btn');
      if (!input || !button) return;
      wrapper.dataset.clearBound = '1';
      const sync = (): void => {
        button.classList.toggle('is-hidden', !input.value);
        button.setAttribute('aria-label', t('common.clearSearch'));
      };
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      button.addEventListener('click', event => {
        event.preventDefault();
        if (!input.value) return;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        sync();
      });
      sync();
    });
  }

  setupResize(): void {
    const workspace = byId('workspace-body');
    this.workspaceResize = new WorkspaceResizeController({
      workspace,
      document,
      storage: localStorage,
      requestFrame: callback => requestAnimationFrame(callback),
      cancelFrame: frame => cancelAnimationFrame(frame),
      panels: {
        left: {
          handle: byId('resize-handle-left'),
          panel: byId('sidebar'),
          min: 220,
          max: 380,
          cssVariable: '--left-panel',
          storageKey: 'gittree.panel.left',
          direction: 1
        },
        right: {
          handle: byId('resize-handle-right'),
          panel: byId('detail-panel'),
          min: 300,
          max: 620,
          cssVariable: '--right-panel',
          storageKey: 'gittree.panel.right',
          direction: -1
        }
      }
    });
    this.workspaceResize.mount();
  }

  setupWorkspaceState(): void {
    this.workspaceState.mount();
    this.setupInspectorPopout();
  }

  setSidebarCollapsed(collapsed: boolean, persist = true): void {
    this.workspaceState.setSidebarCollapsed(collapsed, persist);
  }

  setupInspectorPopout(): void {
    this.popoutOpen = false;
    this.buildInspectorPayload = (): InspectorPayload => {
      const body = byId('detail-body');
      const title = byId('detail-title').textContent;
      const theme = document.documentElement.dataset.theme || 'light';
      const tone = document.documentElement.dataset.tone || '';
      const mode = this.components.diffViewer?.mode || 'unified';
      const html = body.innerHTML;
      const meta = [...document.querySelectorAll('#detail-meta > span')]
        .map(element => element.textContent.trim())
        .filter(Boolean)
        .join(' · ');
      const payload: InspectorPayload = {
        title,
        meta,
        theme,
        tone,
        mode,
        eyebrow: t('details.eyebrow'),
        modeLabel: t(mode === 'split' ? 'details.split' : 'details.unified'),
        wordLevel: Boolean(this.components.diffViewer?.wordLevel),
        graph: this.components.graphView?.getInspectorSnapshot?.(),
        files: this.components.diffViewer?.fileSummaries || [],
        selectedFile: this.components.diffViewer?.selectedFilePath || null,
        filesOpen: this.components.inspectorWorkspace?.filesOpen !== false
      };
      if (html.length > 2_000_000 && this.components.diffViewer?.currentDiff) {
        payload.diffText = this.components.diffViewer.currentDiff;
      } else {
        payload.html = html;
      }
      return payload;
    };
    this.pushInspectorPayload = (): void => {
      if (!this.popoutOpen) return;
      window.gitTree.updateInspectorWindow(this.buildInspectorPayload());
    };
    window.gitTree.onInspectorClosed(() => {
      this.popoutOpen = false;
    });
    window.gitTree.onDeepLinkOpen((payload: unknown) => {
      const repo = payload as { path?: string };
      this.components.repoTabs?.addRepo(repo.path as string);
    });
    byId('btn-popout-inspector').onclick = async () => {
      const result = await window.gitTree.openInspectorWindow(this.buildInspectorPayload()) as { success?: boolean };
      this.popoutOpen = Boolean(result?.success);
    };
  }

  setInspectorState(state: string, persist = true): void {
    this.workspaceState.setInspectorState(state, persist);
  }

  animatePanelRestore(workspace: HTMLElement): void {
    this.workspaceState.animatePanelRestore(workspace);
  }

  setupGlobalShortcuts(): void {
    this.shortcutController.mount();
  }

  refreshLocalizedView(): void {
    Theme.syncControls();
    this.setupShortcutHints();
    this.updateWindowChrome(this.windowState);
    this.setInspectorState(this.inspectorState, false);
    this.components.inspectorWorkspace?.refreshTranslations();
    this.components.repoTabs?.render();
    this.components.dashboard?.refreshTranslations();
    if (this.state.repo) {
      this.components.branchList.render();
      this.components.graphView.render();
      this.components.diffViewer.clear();
      this.setWorkspaceMode(this.workspaceMode, false);
      this.components.changes.render();
      if (this.components.pullRequests.detail) {
        this.components.pullRequests.renderDetail();
      } else {
        this.components.pullRequests.renderViewport(true);
      }
    }
    this.components.welcome.loadRecent();
    if (this.updateState) this.handleUpdateState(this.updateState);
  }

  showToast(message: string, type = ''): void {
    this.toasts.show(message, type);
  }

  dismissToast(): void {
    this.toasts.dismiss();
  }

  pauseToast(): void {
    this.toasts.pause();
  }

  resumeToast(): void {
    this.toasts.resume();
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }

  on(event: string, cb: (payload: unknown) => void): () => void {
    return this.bus.on(event, cb);
  }

  emit(event: string, data?: unknown): void {
    this.bus.emit(event, data);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.I18n?.init();
  window.I18n?.translateDOM();
  Theme.apply(document.documentElement.dataset.theme, false);

  window.addEventListener('error', (e) => {
    const bar = document.createElement('div');
    bar.className = 'system-alert system-alert-error';
    const message = document.createElement('span');
    message.textContent = `JS ERROR: ${e.message} (${e.filename}:${e.lineno})`;
    const close = document.createElement('button');
    close.className = 'btn-icon';
    close.innerHTML = '<i class="ph ph-x"></i>';
    close.onclick = () => bar.remove();
    bar.append(message, close);
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 8000);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const bar = document.createElement('div');
    bar.className = 'system-alert system-alert-warning';
    const message = document.createElement('span');
    message.textContent = `PROMISE ERROR: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`;
    const close = document.createElement('button');
    close.className = 'btn-icon';
    close.innerHTML = '<i class="ph ph-x"></i>';
    close.onclick = () => bar.remove();
    bar.append(message, close);
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 8000);
  });

  const app = new GitTreeApp();
  window.app = app;
  await app.init();
});

export {};

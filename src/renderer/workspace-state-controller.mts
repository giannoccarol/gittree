export type WorkspaceMode = 'history' | 'changes' | 'pullRequests';
export type InspectorState = 'open' | 'closed' | 'maximized';

export interface WorkspaceStateDependencies {
  document: Document;
  storage: Storage;
  translate: (key: string) => string;
  panelMotion: {
    transition: (
      name: string,
      options: {
        opening: boolean;
        animate: boolean;
        applyState: () => void;
      }
    ) => void;
  };
  state: { repo?: { path?: string } | null };
  components: {
    changes?: { setActive(active: boolean): void };
    pullRequests?: { setActive(active: boolean): void };
    diffViewer?: { setInspectorExpanded(expanded: boolean): void };
  };
  viewportWidth: () => number;
  computedStyle: (element: Element) => CSSStyleDeclaration;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  onModeChange?: (mode: WorkspaceMode) => void;
  onInspectorStateChange?: (state: InspectorState) => void;
}

interface SidebarSectionElements {
  header: HTMLElement;
  body: HTMLElement;
  arrow: HTMLElement;
}

export class WorkspaceStateController {
  document: Document;
  storage: Storage;
  translate: (key: string) => string;
  panelMotion: WorkspaceStateDependencies['panelMotion'];
  state: WorkspaceStateDependencies['state'];
  components: WorkspaceStateDependencies['components'];
  viewportWidth: () => number;
  computedStyle: (element: Element) => CSSStyleDeclaration;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onInspectorStateChange: (state: InspectorState) => void;
  mode: WorkspaceMode;
  inspectorState: InspectorState;
  bindings: Array<{ element: HTMLElement; eventName: string; listener: EventListenerOrEventListenerObject }>;
  restoreTimers: Set<unknown>;
  mounted: boolean;

  constructor({
    document,
    storage,
    translate,
    panelMotion,
    state,
    components,
    viewportWidth,
    computedStyle,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onModeChange = () => {},
    onInspectorStateChange = () => {}
  }: WorkspaceStateDependencies) {
    this.document = document;
    this.storage = storage;
    this.translate = translate;
    this.panelMotion = panelMotion;
    this.state = state;
    this.components = components;
    this.viewportWidth = viewportWidth;
    this.computedStyle = computedStyle;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onModeChange = onModeChange;
    this.onInspectorStateChange = onInspectorStateChange;
    this.mode = 'history';
    this.inspectorState = 'open';
    this.bindings = [];
    this.restoreTimers = new Set();
    this.mounted = false;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.bindWorkspaceModes();
    this.setMode('history', false);
    this.bindInspector();
    this.setInspectorState(
      this.storage.getItem('gittree.workspace.inspector') || 'open',
      false
    );
    this.bindSidebar();
    this.setSidebarCollapsed(
      this.storage.getItem('gittree.sidebar.collapsed') === 'true',
      false
    );
    this.bindPersistentSidebarSections();
  }

  bind(element: HTMLElement | null, eventName: string, listener: EventListenerOrEventListenerObject): void {
    if (!element) return;
    element.addEventListener(eventName, listener);
    this.bindings.push({ element, eventName, listener });
  }

  bindWorkspaceModes(): void {
    this.document.querySelectorAll<HTMLElement>('[data-workspace-mode]').forEach(button => {
      this.bind(button, 'click', () => this.setMode(button.dataset.workspaceMode ?? ''));
    });
  }

  modeKey(repoPath: string | undefined | null = this.state.repo?.path): string {
    return `gittree.workspace.mode:${repoPath || ''}`;
  }

  restoreMode(repoPath: string): WorkspaceMode {
    const savedMode = this.storage.getItem(this.modeKey(repoPath)) || 'history';
    this.setMode(savedMode, false);
    return this.mode;
  }

  setMode(mode: string, persist = true): void {
    const safeMode: WorkspaceMode = (['history', 'changes', 'pullRequests'] as const).includes(mode as WorkspaceMode)
      ? mode as WorkspaceMode
      : 'history';
    this.mode = safeMode;
    this.onModeChange(safeMode);
    this.document.querySelectorAll<HTMLElement>('[data-workspace-mode]').forEach(button => {
      const active = button.dataset.workspaceMode === safeMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    this.document.getElementById('main-view')!.classList.toggle('is-hidden', safeMode !== 'history');
    this.document.getElementById('changes-view')!.classList.toggle('is-hidden', safeMode !== 'changes');
    this.document.getElementById('pull-requests-view')!.classList.toggle(
      'is-hidden',
      safeMode !== 'pullRequests'
    );
    this.document.getElementById('global-search')!.classList.toggle(
      'is-hidden',
      safeMode !== 'history'
    );

    const eyebrowKey = safeMode === 'history'
      ? 'history.eyebrow'
      : safeMode === 'changes'
        ? 'changes.eyebrow'
        : 'pullRequests.eyebrow';
    const titleKey = safeMode === 'history'
      ? 'history.title'
      : safeMode === 'changes'
        ? 'changes.title'
        : 'pullRequests.title';
    const title = this.document.getElementById('workspace-title')!;
    const eyebrow = title.querySelector('.eyebrow') as HTMLElement;
    const heading = title.querySelector('h2') as HTMLElement;
    eyebrow.dataset.i18n = eyebrowKey;
    heading.dataset.i18n = titleKey;
    eyebrow.textContent = this.translate(eyebrowKey);
    heading.textContent = this.translate(titleKey);
    this.components.changes?.setActive?.(safeMode === 'changes');
    this.components.pullRequests?.setActive?.(safeMode === 'pullRequests');
    if (persist && this.state.repo) {
      this.storage.setItem(this.modeKey(), safeMode);
    }
  }

  bindSidebar(): void {
    const toggle = () => {
      const workspace = this.document.getElementById('workspace-body')!;
      this.setSidebarCollapsed(!workspace.classList.contains('sidebar-collapsed'));
    };
    this.bind(this.document.getElementById('btn-toggle-sidebar')!, 'click', toggle);
    this.bind(this.document.getElementById('btn-collapse-sidebar')!, 'click', toggle);
  }

  setSidebarCollapsed(collapsed: boolean, persist = true): void {
    const workspace = this.document.getElementById('workspace-body')!;
    const toggleButton = this.document.getElementById('btn-toggle-sidebar')!;
    const changed = workspace.classList.contains('sidebar-collapsed') !== collapsed;
    this.panelMotion.transition('sidebar', {
      opening: !collapsed,
      animate: persist && changed,
      applyState: () => {
        workspace.classList.toggle('sidebar-collapsed', collapsed);
        toggleButton.classList.toggle('active', !collapsed);
        toggleButton.setAttribute('aria-pressed', String(!collapsed));
      }
    });
    if (persist) {
      this.storage.setItem('gittree.sidebar.collapsed', String(collapsed));
    }
  }

  bindInspector(): void {
    this.bind(this.document.getElementById('btn-toggle-inspector')!, 'click', () => {
      const inspector = this.document.getElementById('detail-panel')!;
      const hiddenByResponsiveLayout = this.inspectorState !== 'closed' &&
        this.computedStyle(inspector).display === 'none';
      if (this.inspectorState === 'closed') {
        this.setInspectorState(this.viewportWidth() <= 1120 ? 'maximized' : 'open');
      } else if (hiddenByResponsiveLayout) {
        this.setInspectorState('maximized');
      } else {
        this.setInspectorState('closed');
      }
    });
    this.bind(this.document.getElementById('btn-close-inspector')!, 'click', () => {
      this.setInspectorState('closed');
    });
    this.bind(this.document.getElementById('btn-maximize-inspector')!, 'click', () => {
      this.toggleInspectorMaximized();
    });
    this.bind(this.document.querySelector('.detail-panel-header') as HTMLElement | null, 'dblclick', event => {
      if ((event.target as HTMLElement).closest('button')) return;
      this.toggleInspectorMaximized();
    });
  }

  toggleInspectorMaximized(): void {
    this.setInspectorState(this.inspectorState === 'maximized' ? 'open' : 'maximized');
  }

  setInspectorState(state: string, persist = true): void {
    const safeState: InspectorState = (['open', 'closed', 'maximized'] as const).includes(state as InspectorState)
      ? state as InspectorState
      : 'open';
    const previousState = this.inspectorState;
    const workspace = this.document.getElementById('workspace-body')!;
    const toggleButton = this.document.getElementById('btn-toggle-inspector')!;
    const maximizeButton = this.document.getElementById('btn-maximize-inspector')!;
    const isOpen = safeState !== 'closed';
    const isMaximized = safeState === 'maximized';
    const changedVisibility = (previousState === 'closed') !== (safeState === 'closed');

    this.panelMotion.transition('inspector', {
      opening: isOpen,
      animate: persist && changedVisibility,
      applyState: () => {
        this.inspectorState = safeState;
        this.onInspectorStateChange(safeState);
        workspace.classList.toggle('inspector-closed', safeState === 'closed');
        workspace.classList.toggle('inspector-maximized', isMaximized);
        toggleButton.classList.toggle('active', isOpen);
        toggleButton.setAttribute('aria-pressed', String(isOpen));
      }
    });

    const maximizeIcon = maximizeButton.querySelector('i') as HTMLElement;
    maximizeIcon.className = isMaximized ? 'ph ph-arrows-in-simple' : 'ph ph-arrows-out-simple';
    maximizeButton.dataset.i18nTitle = isMaximized ? 'details.restore' : 'details.maximize';
    maximizeButton.title = this.translate(maximizeButton.dataset.i18nTitle);

    if (previousState !== safeState) {
      this.components.diffViewer?.setInspectorExpanded?.(isMaximized);
      if (previousState === 'maximized' && !isMaximized) {
        this.animatePanelRestore(workspace);
      }
    }
    if (persist) {
      this.storage.setItem('gittree.workspace.inspector', safeState);
    }
  }

  animatePanelRestore(workspace: HTMLElement): void {
    workspace.classList.add('is-restoring');
    const timer = this.setTimer(() => {
      this.restoreTimers.delete(timer);
      workspace.classList.remove('is-restoring');
    }, 320);
    this.restoreTimers.add(timer);
  }

  bindPersistentSidebarSections(): void {
    const storageKey = 'gittree.sidebar.sections';
    let savedSections: Set<string> | null = null;
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(storageKey) ?? 'null');
      if (Array.isArray(parsed)) savedSections = new Set(parsed as string[]);
    } catch {
      // Invalid stored sections are ignored.
    }

    const headers = [...this.document.querySelectorAll<HTMLElement>('.sidebar-section-header.collapsible')];
    headers.forEach(header => {
      const section = header.parentElement;
      const sectionId = section!.dataset.section!;
      const body = section!.querySelector('.sidebar-section-body') as HTMLElement;
      const arrow = header.querySelector('.collapse-arrow') as HTMLElement;
      if (!sectionId || !body || !arrow) return;

      const collapsed = savedSections
        ? savedSections.has(sectionId)
        : body.classList.contains('collapsed');
      this.applySidebarSectionState({ header, body, arrow }, collapsed);
      this.bind(header, 'click', () => {
        const nextCollapsed = !body.classList.contains('collapsed');
        this.applySidebarSectionState({ header, body, arrow }, nextCollapsed);
        const collapsedSections = headers
          .filter(item => item.classList.contains('collapsed'))
          .map(item => item.parentElement!.dataset.section ?? '')
          .filter(Boolean);
        this.storage.setItem(storageKey, JSON.stringify(collapsedSections));
      });
    });
  }

  applySidebarSectionState({ header, body, arrow }: SidebarSectionElements, collapsed: boolean): void {
    body.classList.toggle('collapsed', collapsed);
    arrow.classList.toggle('collapsed', collapsed);
    header.classList.toggle('collapsed', collapsed);
    header.setAttribute('aria-expanded', String(!collapsed));
  }

  destroy(): void {
    for (const { element, eventName, listener } of this.bindings) {
      element.removeEventListener(eventName, listener);
    }
    this.bindings = [];
    for (const timer of this.restoreTimers) this.clearTimer(timer);
    this.restoreTimers.clear();
    this.mounted = false;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { WorkspaceStateController: typeof WorkspaceStateController }).WorkspaceStateController = WorkspaceStateController;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = WorkspaceStateController;
}

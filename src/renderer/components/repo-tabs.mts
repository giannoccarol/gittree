export const MAX_VISIBLE_REPO_TABS = 4;

export function splitVisibleAndOverflowRepos<T extends { path: string }>(
  repos: T[],
  activeIndex: number,
  keyFn: (path: string) => string,
  maxVisible = MAX_VISIBLE_REPO_TABS
): { visible: T[]; overflow: T[] } {
  if (repos.length <= maxVisible) {
    return { visible: [...repos], overflow: [] };
  }
  const visible: T[] = [];
  const seen = new Set<string>();
  const active = repos[activeIndex];
  if (active) {
    visible.push(active);
    seen.add(keyFn(active.path));
  }
  for (const repo of repos) {
    if (visible.length >= maxVisible) break;
    const key = keyFn(repo.path);
    if (seen.has(key)) continue;
    visible.push(repo);
    seen.add(key);
  }
  const overflow = repos.filter(repo => !seen.has(keyFn(repo.path)));
  return { visible, overflow };
}

interface RepoEntry {
  path: string;
  name?: string;
}

interface SyncState {
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

import type { GitTreeApp } from '../app.mts';
type RepoTabsApp = GitTreeApp;

export interface RepoTabsOptions {
  platform?: string | null;
  storage?: Storage | null;
}

export class RepoTabs {
  container: HTMLElement;
  app: RepoTabsApp;
  repos: RepoEntry[];
  backendRepos: RepoEntry[];
  syncByRepoPath: Map<string, SyncState>;
  busyRepoPaths: Set<string>;
  platform: string | null;
  storage: Storage | null;
  layoutStorageKey: string;
  pinnedKeys: Set<string>;
  draggedKey: string | null;
  dragOverKey: string | null;
  dragOverAfter: boolean;
  _syncRefreshToken: number;
  _syncTimer: ReturnType<typeof setInterval> | null;
  overflowRoot: HTMLElement | null;
  overflowMenu: HTMLElement | null;
  overflowList: HTMLElement | null;
  overflowSearch: HTMLInputElement | null;
  overflowFilter: string;
  overflowOpen: boolean;
  handleDocumentPointerDown: (event: PointerEvent) => void;
  handleDragStart: (event: DragEvent) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => void;
  handleDragEnd: () => void;

  constructor(container: HTMLElement, app: RepoTabsApp, options: RepoTabsOptions = {}) {
    this.container = container;
    this.app = app;
    this.repos = [];
    this.backendRepos = [];
    this.syncByRepoPath = new Map();
    this.busyRepoPaths = new Set();
    this.platform = options.platform || (
      typeof window !== 'undefined' ? window.gitTree?.platform : null
    ) || 'win32';
    this.storage = options.storage || (
      typeof localStorage !== 'undefined' ? localStorage : null
    );
    this.layoutStorageKey = 'gittree.repo-tabs.layout';
    this.pinnedKeys = new Set();
    this.draggedKey = null;
    this.dragOverKey = null;
    this.dragOverAfter = false;
    this._syncRefreshToken = 0;
    this._syncTimer = null;
    this.overflowRoot = null;
    this.overflowMenu = null;
    this.overflowList = null;
    this.overflowSearch = null;
    this.overflowFilter = '';
    this.overflowOpen = false;
    this.handleDocumentPointerDown = event => this.onDocumentPointerDown(event);

    this.handleDragStart = event => this.onDragStart(event);
    this.handleDragOver = event => this.onDragOver(event);
    this.handleDrop = event => this.onDrop(event);
    this.handleDragEnd = () => this.clearDragState();
    this.container.addEventListener('dragstart', this.handleDragStart);
    this.container.addEventListener('dragover', this.handleDragOver);
    this.container.addEventListener('drop', this.handleDrop);
    this.container.addEventListener('dragend', this.handleDragEnd);
  }

  async init(): Promise<void> {
    try {
      this.setRepositoryData(await window.gitTree.getRepos() as RepoEntry[]);
    } catch { /* repo list may be unavailable */ }
    this.ensureOverflowChrome();
    this.render();
    this.refreshAllSync();
    this.startPeriodicSyncRefresh();
  }

  destroy(): void {
    this.stopPeriodicSyncRefresh();
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
    this.closeOverflowMenu();
  }

  startPeriodicSyncRefresh(): void {
    this.stopPeriodicSyncRefresh();
    this._syncTimer = setInterval(() => this.refreshAllSync(), 60000);
  }

  stopPeriodicSyncRefresh(): void {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  async refreshAllSync(): Promise<void> {
    if (!this.repos.length) return;
    const token = ++this._syncRefreshToken;
    const results = await Promise.all(this.repos.map(async repo => {
      try {
        const metadata = await window.gitTree.getBranchMetadata(repo.path) as {
          error?: unknown;
          branches?: Array<{ kind?: string; current?: boolean; name?: string; upstream?: string; ahead?: number; behind?: number }>;
        } | undefined;
        if (!metadata || metadata.error || !Array.isArray(metadata.branches)) {
          return [repo.path, null] as const;
        }
        const current = metadata.branches.find(b => b.kind === 'local' && b.current);
        return [repo.path, current
          ? {
              branch: current.name,
              upstream: current.upstream,
              ahead: current.ahead,
              behind: current.behind
            }
          : null] as const;
      } catch {
        return [repo.path, null] as const;
      }
    }));
    if (token !== this._syncRefreshToken) return;
    for (const [repoPath, state] of results) {
      if (state) this.syncByRepoPath.set(repoPath, state);
      else this.syncByRepoPath.delete(repoPath);
    }
    this.render();
  }

  render(): void {
    this.container.replaceChildren();
    this.container.classList.toggle('has-pinned', this.pinnedKeys.size > 0);
    const { visible, overflow } = splitVisibleAndOverflowRepos(
      this.repos,
      this.app.state.activeRepoIndex,
      path => this.repoKey(path)
    );
    this.updateOverflowChrome(overflow);
    for (const repo of visible) {
      const index = this.repos.findIndex(item => this.sameRepo(item.path, repo.path));
      if (index >= 0) this.container.appendChild(this.createTabElement(repo, index));
    }
  }

  createTabElement(repo: RepoEntry, index: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'repo-tab';
    const active = index === this.app.state.activeRepoIndex;
    const pinned = this.isPinned(repo);
    if (active) el.classList.add('active');
    if (pinned) el.classList.add('is-pinned');
    el.dataset.path = repo.path;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(active));
    el.tabIndex = active ? 0 : -1;
    el.draggable = true;

    const name = document.createElement('span');
    name.className = 'repo-tab-name';
    name.textContent = repo.name || '';
    name.title = repo.path;

    const sync = this.createSyncIndicator(repo.path);
    const pin = this.createTabControl(
      'repo-tab-pin',
      pinned ? 'tabs.unpin' : 'tabs.pin',
      'ph-push-pin'
    );
    pin.classList.toggle('is-pinned', pinned);
    pin.setAttribute('aria-pressed', String(pinned));
    pin.onclick = event => {
      event.stopPropagation();
      this.togglePinned(repo.path);
    };

    const close = this.createTabControl('repo-tab-close', 'common.close', 'ph-x');
    close.onclick = e => { e.stopPropagation(); this.removeRepo(repo.path); };

    el.append(name, pin);
    if (sync) el.appendChild(sync);
    el.appendChild(close);
    el.onclick = event => {
      if ((event.target as HTMLElement).closest('button')) return;
      this.selectRepo(index);
    };
    el.onkeydown = event => this.handleTabKeydown(event, index);
    return el;
  }

  ensureOverflowChrome(): void {
    if (this.overflowRoot) return;
    const bar = this.container.parentElement;
    const addButton = bar?.querySelector('#btn-add-repo-tab');
    if (!bar || !addButton) return;

    const root = document.createElement('div');
    root.className = 'repo-tab-overflow';
    root.hidden = true;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn btn-quiet repo-tab-overflow-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = t('tabs.more');
    trigger.innerHTML = '<i class="ph ph-caret-down" aria-hidden="true"></i><span class="repo-tab-overflow-count"></span>';
    trigger.onclick = event => {
      event.stopPropagation();
      this.toggleOverflowMenu();
    };

    const menu = document.createElement('div');
    menu.className = 'repo-tab-overflow-menu is-hidden';
    menu.setAttribute('role', 'presentation');
    menu.innerHTML = `
      <label class="repo-tab-overflow-search search-clearable">
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
        <input type="search" class="repo-tab-overflow-input" autocomplete="off"
          placeholder="${t('tabs.overflowSearch')}" aria-label="${t('tabs.overflowSearch')}">
        <button type="button" class="search-clear-btn is-hidden" aria-label="${t('common.clearSearch')}">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </label>
      <div class="repo-tab-overflow-list" role="listbox" aria-label="${t('tabs.overflowList')}"></div>
    `;

    root.append(trigger, menu);
    bar.insertBefore(root, addButton);
    this.overflowRoot = root;
    this.overflowMenu = menu;
    this.overflowList = menu.querySelector('.repo-tab-overflow-list');
    this.overflowSearch = menu.querySelector('.repo-tab-overflow-input');
    this.overflowSearch!.addEventListener('input', () => {
      this.overflowFilter = this.overflowSearch!.value.trim().toLowerCase();
      const clearButton = menu.querySelector('.search-clear-btn');
      clearButton?.classList.toggle('is-hidden', !this.overflowFilter);
      this.renderOverflowList(this.getOverflowRepos());
    });
    this.overflowSearch!.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeOverflowMenu();
      }
    });
    const clearButton = menu.querySelector<HTMLButtonElement>('.search-clear-btn');
    clearButton?.addEventListener('click', () => {
      this.overflowFilter = '';
      if (this.overflowSearch) this.overflowSearch.value = '';
      clearButton.classList.add('is-hidden');
      this.renderOverflowList(this.getOverflowRepos());
      this.overflowSearch?.focus();
    });
    document.addEventListener('pointerdown', this.handleDocumentPointerDown);
  }

  getOverflowRepos(): RepoEntry[] {
    return splitVisibleAndOverflowRepos(
      this.repos,
      this.app.state.activeRepoIndex,
      path => this.repoKey(path)
    ).overflow;
  }

  updateOverflowChrome(overflow: RepoEntry[]): void {
    this.ensureOverflowChrome();
    if (!this.overflowRoot) return;
    const hasOverflow = overflow.length > 0;
    this.overflowRoot.hidden = !hasOverflow;
    const count = this.overflowRoot.querySelector('.repo-tab-overflow-count');
    if (count) count.textContent = hasOverflow ? String(overflow.length) : '';
    const activeInOverflow = overflow.some(repo => (
      this.repos.findIndex(item => this.sameRepo(item.path, repo.path)) === this.app.state.activeRepoIndex
    ));
    this.overflowRoot.querySelector('.repo-tab-overflow-trigger')
      ?.classList.toggle('is-active', activeInOverflow);
    if (!hasOverflow) this.closeOverflowMenu();
    else if (this.overflowOpen) this.renderOverflowList(overflow);
  }

  renderOverflowList(overflow: RepoEntry[]): void {
    if (!this.overflowList) return;
    const filter = this.overflowFilter;
    const filtered = filter
      ? overflow.filter(repo => (
        (repo.name || '').toLowerCase().includes(filter)
          || repo.path.toLowerCase().includes(filter)
      ))
      : overflow;
    this.overflowList.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'repo-tab-overflow-empty';
      empty.textContent = t('tabs.overflowEmpty');
      this.overflowList.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const repo of filtered) {
      const index = this.repos.findIndex(item => this.sameRepo(item.path, repo.path));
      const active = index === this.app.state.activeRepoIndex;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'repo-tab-overflow-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(active));
      if (active) item.classList.add('is-active');
      if (this.isPinned(repo)) item.classList.add('is-pinned');

      const label = document.createElement('span');
      label.className = 'repo-tab-overflow-name';
      label.textContent = repo.name || repo.path;
      label.title = repo.path;

      const meta = document.createElement('span');
      meta.className = 'repo-tab-overflow-path';
      meta.textContent = repo.path;

      item.append(label, meta);
      const sync = this.createSyncIndicator(repo.path);
      if (sync) item.appendChild(sync);
      item.onclick = () => {
        if (index >= 0) this.selectRepo(index);
        this.closeOverflowMenu();
      };
      fragment.appendChild(item);
    }
    this.overflowList.appendChild(fragment);
  }

  toggleOverflowMenu(): void {
    if (this.overflowOpen) this.closeOverflowMenu();
    else this.openOverflowMenu();
  }

  openOverflowMenu(): void {
    if (!this.overflowMenu || !this.overflowRoot) return;
    this.overflowOpen = true;
    this.overflowMenu.classList.remove('is-hidden');
    const trigger = this.overflowRoot.querySelector('.repo-tab-overflow-trigger');
    trigger?.setAttribute('aria-expanded', 'true');
    this.renderOverflowList(this.getOverflowRepos());
    this.overflowSearch?.focus();
  }

  closeOverflowMenu(): void {
    if (!this.overflowMenu || !this.overflowRoot) return;
    this.overflowOpen = false;
    this.overflowMenu.classList.add('is-hidden');
    const trigger = this.overflowRoot.querySelector('.repo-tab-overflow-trigger');
    trigger?.setAttribute('aria-expanded', 'false');
  }

  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.overflowOpen || !this.overflowRoot) return;
    const target = event.target as Node | null;
    if (target && this.overflowRoot.contains(target)) return;
    this.closeOverflowMenu();
  }

  createTabControl(className: string, labelKey: string, iconName: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `repo-tab-control ${className}`;
    button.setAttribute('aria-label', t(labelKey));
    button.title = t(labelKey);
    button.draggable = false;
    const icon = document.createElement('i');
    icon.className = `ph ${iconName}`;
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    return button;
  }

  setRepositoryData(repositories: RepoEntry[] | undefined | null, preferredActivePath: string | null = null): void {
    const activePath = preferredActivePath || this.getActivePath();
    this.backendRepos = Array.isArray(repositories) ? [...repositories] : [];
    const layout = this.readLayout();
    const known = new Map(this.backendRepos.map(repo => [this.repoKey(repo.path), repo]));
    const orderedKeys = [
      ...layout.order,
      ...this.backendRepos.map(repo => this.repoKey(repo.path))
    ];
    const ordered: RepoEntry[] = [];
    const seen = new Set();
    for (const key of orderedKeys) {
      const repo = known.get(key);
      if (!repo || seen.has(key)) continue;
      seen.add(key);
      ordered.push(repo);
    }
    this.pinnedKeys = new Set(layout.pinned.filter(key => known.has(key)));
    this.repos = [
      ...ordered.filter(repo => this.isPinned(repo)),
      ...ordered.filter(repo => !this.isPinned(repo))
    ];
    this.syncActiveIndex(activePath);
  }

  getActivePath(): string | null {
    const index = this.app.state.activeRepoIndex;
    return this.repos[index]?.path || null;
  }

  syncActiveIndex(path: string | null): void {
    if (!path) {
      this.app.state.activeRepoIndex = -1;
      return;
    }
    const index = this.repos.findIndex(repo => this.sameRepo(repo.path, path));
    if (index >= 0) this.app.state.activeRepoIndex = index;
  }

  repoKey(path: unknown): string {
    const value = String(path || '');
    return this.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  }

  sameRepo(left: string, right: string): boolean {
    return this.repoKey(left) === this.repoKey(right);
  }

  isPinned(repo: RepoEntry): boolean {
    return this.pinnedKeys.has(this.repoKey(repo.path));
  }

  readLayout(): { order: string[]; pinned: string[] } {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(this.layoutStorageKey) || '{}');
      const values = (value: unknown): string[] => Array.isArray(value)
        ? (value as unknown[]).filter(item => typeof item === 'string' && item.length <= 4096)
          .slice(0, 500).map(item => this.repoKey(item))
        : [];
      return { order: values((parsed as { order?: unknown })?.order), pinned: values((parsed as { pinned?: unknown })?.pinned) };
    } catch {
      return { order: [], pinned: [] };
    }
  }

  persistLayout(): void {
    try {
      this.storage?.setItem(this.layoutStorageKey, JSON.stringify({
        order: this.repos.map(repo => this.repoKey(repo.path)),
        pinned: [...this.pinnedKeys]
      }));
    } catch {
      // The visual order remains available for this session when storage fails.
    }
  }

  togglePinned(repoPath: string): void {
    const activePath = this.getActivePath();
    const key = this.repoKey(repoPath);
    if (this.pinnedKeys.has(key)) this.pinnedKeys.delete(key);
    else this.pinnedKeys.add(key);
    const ordered = [...this.repos];
    this.repos = [
      ...ordered.filter(repo => this.isPinned(repo)),
      ...ordered.filter(repo => !this.isPinned(repo))
    ];
    this.syncActiveIndex(activePath);
    this.persistLayout();
    this.render();
  }

  handleTabKeydown(event: KeyboardEvent, index: number): void {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.selectRepo(index);
      return;
    }
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    const moved = this.moveRepoByOffset(index, offset);
    if (moved) {
      const element = this.container!.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(this.repos[index + offset].path)}"]`
      );
      element?.focus();
    }
  }

  moveRepoByOffset(index: number, offset: number): boolean {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= this.repos.length) return false;
    if (this.isPinned(this.repos[index]) !== this.isPinned(this.repos[targetIndex])) return false;
    return this.moveRepo(this.repos[index].path, this.repos[targetIndex].path, offset > 0);
  }

  moveRepo(draggedPath: string, targetPath: string, after = false): boolean {
    const fromIndex = this.repos.findIndex(repo => this.sameRepo(repo.path, draggedPath));
    const targetIndex = this.repos.findIndex(repo => this.sameRepo(repo.path, targetPath));
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return false;
    if (this.isPinned(this.repos[fromIndex]) !== this.isPinned(this.repos[targetIndex])) return false;
    const activePath = this.getActivePath();
    const [moved] = this.repos.splice(fromIndex, 1);
    let insertionIndex = this.repos.findIndex(repo => this.sameRepo(repo.path, targetPath));
    if (after) insertionIndex += 1;
    this.repos.splice(insertionIndex, 0, moved);
    this.syncActiveIndex(activePath);
    this.persistLayout();
    this.render();
    return true;
  }

  onDragStart(event: DragEvent): void {
    const tab = (event.target as HTMLElement).closest?.('.repo-tab') as HTMLElement | null;
    if (!tab || (event.target as HTMLElement).closest('button')) {
      event.preventDefault();
      return;
    }
    this.draggedKey = this.repoKey(tab.dataset.path);
    tab.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.dataset.path ?? '');
    }
  }

  onDragOver(event: DragEvent): void {
    if ((event.target as HTMLElement).closest?.('button')) return;
    const target = (event.target as HTMLElement).closest?.('.repo-tab') as HTMLElement | null;
    if (!this.draggedKey || !target) return;
    const dragged = this.repos.find(repo => this.repoKey(repo.path) === this.draggedKey);
    const targetRepo = this.repos.find(repo => this.sameRepo(repo.path, target.dataset.path ?? ''));
    if (!dragged || !targetRepo || this.isPinned(dragged) !== this.isPinned(targetRepo)) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    this.dragOverAfter = event.clientX >= rect.left + (rect.width / 2);
    this.dragOverKey = this.repoKey(target.dataset.path);
    this.container!.querySelectorAll<HTMLElement>('.repo-tab').forEach(element => {
      element.classList.toggle(
        'is-drag-over-before',
        this.repoKey(element.dataset.path) === this.dragOverKey && !this.dragOverAfter
      );
      element.classList.toggle(
        'is-drag-over-after',
        this.repoKey(element.dataset.path) === this.dragOverKey && this.dragOverAfter
      );
    });
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  onDrop(event: DragEvent): void {
    if ((event.target as HTMLElement).closest?.('button')) return;
    const target = (event.target as HTMLElement).closest?.('.repo-tab') as HTMLElement | null;
    if (!this.draggedKey || !target) return;
    event.preventDefault();
    const dragged = this.repos.find(repo => this.repoKey(repo.path) === this.draggedKey);
    const targetRepo = this.repos.find(repo => this.sameRepo(repo.path, target.dataset.path ?? ''));
    if (dragged && targetRepo) {
      this.moveRepo(dragged.path, targetRepo.path, this.dragOverAfter);
    }
    this.clearDragState();
  }

  clearDragState(): void {
    this.container!.querySelectorAll<HTMLElement>('.repo-tab').forEach(element => {
      element.classList.remove('is-dragging', 'is-drag-over-before', 'is-drag-over-after');
    });
    this.draggedKey = null;
    this.dragOverKey = null;
    this.dragOverAfter = false;
  }

  updateSync(repoPath: string, state: SyncState | null): void {
    if (!repoPath) return;
    if (!state) {
      this.syncByRepoPath.delete(repoPath);
    } else {
      this.syncByRepoPath.set(repoPath, state);
    }
    this.render();
  }

  setSyncBusy(repoPath: string, busy: boolean): void {
    if (!repoPath) return;
    if (busy) this.busyRepoPaths.add(repoPath);
    else this.busyRepoPaths.delete(repoPath);
    this.render();
  }

  createSyncIndicator(repoPath: string): HTMLElement | null {
    const state = this.syncByRepoPath.get(repoPath);
    const busy = this.busyRepoPaths.has(repoPath);
    if (!busy && (!state || (!state.ahead && !state.behind))) return null;
    const indicator = document.createElement('span');
    indicator.className = 'sync-indicator repo-tab-sync';
    if (busy) {
      indicator.title = t('tabs.syncing');
      indicator.setAttribute('aria-label', indicator.title);
      indicator.appendChild(this.syncBusyPart());
      return indicator;
    }
    const ahead = state!.ahead || 0;
    const behind = state!.behind || 0;
    indicator.title = t('tabs.syncState', {
      branch: state!.branch,
      ahead,
      behind
    });
    indicator.setAttribute('aria-label', indicator.title);
    if (ahead > 0) indicator.appendChild(this.syncPart('ahead', ahead));
    if (behind > 0) indicator.appendChild(this.syncPart('behind', behind));
    return indicator;
  }

  syncBusyPart(): HTMLElement {
    const part = document.createElement('span');
    part.className = 'sync-indicator-part is-syncing';
    const icon = document.createElement('i');
    icon.className = 'ph ph-circle-notch';
    icon.setAttribute('aria-hidden', 'true');
    part.appendChild(icon);
    return part;
  }

  syncPart(direction: string, count: number): HTMLElement {
    const part = document.createElement('span');
    part.className = `sync-indicator-part is-${direction}`;
    const icon = document.createElement('i');
    icon.className = `ph ph-arrow-${direction === 'ahead' ? 'up' : 'down'}`;
    icon.setAttribute('aria-hidden', 'true');
    part.appendChild(icon);
    const value = document.createElement('span');
    value.textContent = String(count);
    part.appendChild(value);
    return part;
  }

  async selectRepo(index: number): Promise<void> {
    const repoToSelect = this.repos[index];
    if (!repoToSelect) return;
    const backendIndex = this.backendRepos.findIndex(repo => (
      this.sameRepo(repo.path, repoToSelect.path)
    ));
    const repo = await window.gitTree.setActiveRepo(backendIndex) as RepoEntry | undefined;
    if (repo) {
      this.app.state.activeRepoIndex = index;
      this.render();
      this.app.emit('repo:changed', repo);
    }
  }

  async removeRepo(repoPath: string): Promise<void> {
    const active = await window.gitTree.removeRepo(repoPath) as RepoEntry | undefined;
    this.syncByRepoPath.delete(repoPath);
    this.pinnedKeys.delete(this.repoKey(repoPath));
    this.setRepositoryData(await window.gitTree.getRepos() as RepoEntry[], active?.path || null);
    this.persistLayout();
    this.render();
    if (active) this.app.emit('repo:changed', active);
    else this.app.emit('repo:cleared');
  }

  async addRepo(repoPath: string): Promise<void> {
    try {
      const result = await window.gitTree.addRepo(repoPath) as { error?: string; path?: string };
      if (result && !result.error) {
        this.setRepositoryData(await window.gitTree.getRepos() as RepoEntry[], result.path);
        this.render();
        this.app.emit('repo:changed', result);
        this.refreshAllSync();
      } else if (result && result.error) {
        this.app.showToast(result.error, 'error');
      }
    } catch (e) {
      this.app.showToast(`${t('common.error')}: ${(e as Error).message}`, 'error');
    }
  }

  async addRepos(repoPaths: string[]): Promise<{ added?: string[]; failed?: string[]; activeRepo?: RepoEntry } | undefined> {
    const result = await window.gitTree.addRepos(repoPaths) as {
      added?: string[];
      failed?: string[];
      activeRepo?: RepoEntry;
    } | undefined;
    this.setRepositoryData(await window.gitTree.getRepos() as RepoEntry[], result?.activeRepo?.path || null);
    if (result?.activeRepo) {
      this.render();
      this.app.emit('repo:changed', result.activeRepo);
    }
    this.refreshAllSync();
    return result;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { RepoTabs: typeof RepoTabs }).RepoTabs = RepoTabs;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && module.exports) {
  Object.assign(RepoTabs, { splitVisibleAndOverflowRepos, MAX_VISIBLE_REPO_TABS });
  module.exports = RepoTabs;
}

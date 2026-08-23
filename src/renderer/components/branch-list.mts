import type { GitTreeApp } from '../app.mts';
import { BranchNaming, type BranchMetadata } from './branch-naming.mts';
import type { OperationStateInfo } from './conflict-resolver.mts';

interface BranchListInfo {
  [key: string]: unknown;
}

interface BranchListData {
  branches?: Record<string, BranchListInfo>;
  current?: string;
}

interface BranchMetadataEntry {
  kind: string;
  name: string;
  current?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface BranchListMetadata {
  branches?: BranchMetadataEntry[];
  remotes?: Array<{ name: string; provider?: { provider?: string } }>;
  current?: string;
  defaultBranch?: string;
}

interface BranchListStatus {
  error?: unknown;
  current?: string;
  isClean?: boolean;
}


export class BranchListView {
  container: HTMLElement;
  app: GitTreeApp;
  data: BranchListData | null;
  filter: string;
  collapsedFolders: Set<string>;
  collapsedGroups: Set<string>;
  selectedBranchKey: string | null;
  selectedBranchElement: HTMLElement | null;
  selectedBranchKeys: Set<string>;
  selectionAnchorKey: string | null;
  metadata: BranchListMetadata | null;
  status: BranchListStatus | null;
  operationState: unknown;
  checkoutBusy: boolean;
  switchFromDirection: string | null;
  branchMetadataByKey: Map<string, BranchMetadataEntry>;
  searchInput: HTMLInputElement | null;
  loading: boolean;
  shouldReveal: boolean;
  rowStaggerIndex: number;
  activeGhost: {
    ghost: HTMLElement;
    animation: Animation;
    newRow: HTMLElement;
  } | null;

  constructor(container: HTMLElement, app: GitTreeApp) {
    this.container = container;
    this.app = app;
    this.data = null;
    this.filter = '';
    this.collapsedFolders = this.restoreSet('gittree.sidebar.branchFolders');
    this.collapsedGroups = this.restoreSet('gittree.sidebar.branchGroups');
    this.selectedBranchKey = null;
    this.selectedBranchElement = null;
    this.selectedBranchKeys = new Set();
    this.selectionAnchorKey = null;
    this.metadata = null;
    this.status = null;
    this.operationState = null;
    this.checkoutBusy = false;
    this.switchFromDirection = null;
    this.branchMetadataByKey = new Map();
    this.loading = false;
    this.shouldReveal = false;
    this.rowStaggerIndex = 0;
    this.activeGhost = null;
    this.searchInput = document.getElementById('branch-search')! as HTMLInputElement | null;
    if (this.searchInput) {
      this.searchInput.addEventListener('input', () => {
        this.filter = this.searchInput!.value.toLowerCase();
        this.render();
      });
    }
    this.container.addEventListener('click', event => {
      const row = (event.target as HTMLElement).closest('.branch-item') as HTMLElement | null;
      if (row && this.container.contains(row)) this.selectBranchRow(row, event);
    });
    this.container.addEventListener('dblclick', event => {
      const row = (event.target as HTMLElement).closest('.branch-item') as HTMLElement | null;
      if (row && this.container.contains(row)) this.activateBranchRow(row);
    });
    this.container.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      const row = (event.target as HTMLElement).closest('.branch-item') as HTMLElement | null;
      if (!row || !this.container.contains(row)) return;
      event.preventDefault();
      this.activateBranchRow(row);
    });
    this.container.addEventListener('contextmenu', event => {
      const row = (event.target as HTMLElement).closest('.branch-item') as HTMLElement | null;
      if (!row || !this.container.contains(row)) return;
      const key = row.dataset.selectionKey ?? '';
      if (!key) return;
      if (!this.selectedBranchKeys.has(key)) this.selectBranchRow(row, event);
      const branch = this.metadata?.branches?.find(item => (
        item.kind === row.dataset.branchKind && item.name === row.dataset.branchName
      ));
      if (!branch) return;
      const selectedBranches = this.getSelectedBranches();
      this.app.components.branchContextMenu.open(
        event, branch, this.metadata, this.status, this.operationState as OperationStateInfo | null, selectedBranches
      );
    });

    // Inizializza le scorciatoie da tastiera (ESC per dismettere selezione)
    this.initKeyboardShortcuts();
  }

  // Aggiungi listener per ESC su tutta la finestra
  initKeyboardShortcuts(): void {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.selectedBranchKeys.size > 0) {
        this.dismissSelection();
      }
    });
  }

  async load(
    repoPath: string,
    loadSession: { branchMetadata(): Promise<unknown>; status(): Promise<unknown>; operationState(): Promise<unknown> } | null = null,
    options: { background?: boolean } = {}
  ): Promise<void> {
    const background = options.background === true;
    this.setLoading(true, { preserveContent: background });
    try {
      this.app.components.branchContextMenu?.close();
      const [result, metadata, status, operationState] = await Promise.all([
        window.gitTree.getBranches(repoPath),
        loadSession?.branchMetadata() || window.gitTree.getBranchMetadata(repoPath),
        loadSession?.status() || window.gitTree.getStatus(repoPath),
        loadSession?.operationState() || window.gitTree.getOperationState(repoPath)
      ]) as [
        BranchListData & { error?: string },
        BranchListMetadata & { error?: unknown },
        BranchListStatus,
        { error?: unknown }
      ];
      if (!this.app.isCurrentRepo(repoPath)) return;
      if (result?.error) {
        this.data = null;
        this.metadata = null;
        this.status = null;
        this.operationState = null;
        this.branchMetadataByKey = new Map();
        this.container!.innerHTML = '';
        return;
      }
      this.data = result;
      this.metadata = metadata?.error ? null : metadata;
      this.branchMetadataByKey = new Map(
        (this.metadata?.branches || []).map(branch => [
          `${branch.kind}:${branch.name}`,
          branch
        ])
      );
      this.status = status?.error ? null : status;
      this.operationState = operationState?.error ? null : operationState;
      if (!background) {
        if (this.searchInput) this.searchInput!.value = '';
        this.filter = '';
        this.selectedBranchKey = null;
        this.selectedBranchElement = null;
        this.selectedBranchKeys.clear();
        this.selectionAnchorKey = null;
        this.shouldReveal = true;
      }
      this.render();
    } catch {
      this.data = null;
      this.metadata = null;
      this.status = null;
      this.operationState = null;
      this.branchMetadataByKey = new Map();
      this.container!.innerHTML = '';
    }
    finally { this.setLoading(false); }
  }

  setLoading(loading: boolean, { preserveContent = false }: { preserveContent?: boolean } = {}): void {
    this.loading = loading;
    this.container!.classList.toggle('is-project-loading', loading);
    this.container.setAttribute('aria-busy', String(loading));
    if (loading && !preserveContent) {
      this.container!.innerHTML = `<div class="project-loading-inline" role="status" aria-live="polite">
        <i class="ph ph-circle-notch" aria-hidden="true"></i>
        <span>${t('common.loading')}</span>
      </div>`;
    }
  }

  setCurrentBranch(branchName: string): void {
    if (!branchName) return;
    const oldRow = this.container!.querySelector<HTMLElement>('.branch-item.active');
    const newRow = this.container!.querySelector<HTMLElement>(
      `.branch-item[data-remote="false"][data-branch-name="${CSS.escape(branchName ?? '')}"]`
    );
    if (this.data) this.data.current = branchName;
    if (this.status) this.status.current = branchName;
    if (this.metadata) this.metadata.current = branchName;
    for (const branch of this.metadata?.branches || []) {
      if (branch.kind === 'local') branch.current = branch.name === branchName;
    }
    const willSlide = Boolean(oldRow && newRow && oldRow !== newRow);
    if (willSlide && newRow) newRow.classList.add('active-bg-animating');
    this.container!.querySelectorAll<HTMLElement>('.branch-item[data-remote="false"]').forEach(row => {
      row.classList.toggle('active', row.dataset.branchName === branchName);
    });
    if (willSlide && oldRow && newRow) this.slideActiveBackground(oldRow, newRow);
  }

  slideActiveBackground(oldRow: HTMLElement, newRow: HTMLElement): void {
    if (this.activeGhost) {
      this.activeGhost.animation.cancel();
      this.activeGhost.ghost.remove();
      this.activeGhost.newRow.classList.remove('active-bg-animating');
      this.container!.classList.remove('is-sliding-active');
      this.activeGhost = null;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      newRow.classList.remove('active-bg-animating');
      return;
    }
    const container = this.container;
    container.classList.add('is-sliding-active');
    const containerRect = container.getBoundingClientRect();
    const oldRect = oldRow.getBoundingClientRect();
    const newRect = newRow.getBoundingClientRect();
    const startTop = oldRect.top - containerRect.top + container.scrollTop;
    const endTop = newRect.top - containerRect.top + container.scrollTop;
    const startH = oldRect.height;
    const endH = newRect.height;
    const midTop = Math.min(startTop, endTop);
    const midH = Math.max(startTop + startH, endTop + endH) - midTop;
    const ghost = document.createElement('div');
    ghost.className = 'branch-active-ghost';
    ghost.style.left = `${oldRect.left - containerRect.left + container.scrollLeft}px`;
    ghost.style.width = `${oldRect.width}px`;
    ghost.style.top = `${startTop}px`;
    ghost.style.height = `${startH}px`;
    container.appendChild(ghost);
    const distance = Math.abs(endTop - startTop);
    const duration = Math.round(Math.min(560, Math.max(400, 340 + distance * 0.45)));
    const animation = ghost.animate(
      [
        {
          top: `${startTop}px`,
          height: `${startH}px`,
          easing: 'cubic-bezier(0.2, 0, 0, 1)'
        },
        {
          top: `${midTop}px`,
          height: `${midH}px`,
          offset: 0.4,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
        },
        {
          top: `${endTop}px`,
          height: `${endH}px`
        }
      ],
      { duration, fill: 'forwards' }
    );
    this.activeGhost = { ghost, animation, newRow };
    animation.onfinish = () => {
      newRow.classList.remove('active-bg-animating');
      ghost.remove();
      container.classList.remove('is-sliding-active');
      this.activeGhost = null;
    };
  }

  render(): void {
    this.container!.innerHTML = '';
    this.selectedBranchElement = null;
    this.rowStaggerIndex = 0;
    if (!this.data) return;
    const branches = this.data.branches || {};
    const current = this.data.current;
    const f = this.filter;

    let locals: Array<{ name: string; full?: string; info: BranchListInfo }> = [];
    let remotes: Array<{ name: string; full?: string; info: BranchListInfo }> = [];
    for (const [name, info] of Object.entries(branches)) {
      if (name.startsWith('remotes/')) {
        remotes.push({ name: name.replace('remotes/', ''), full: name, info });
      } else {
        locals.push({ name, info });
      }
    }

    if (f) {
      locals = locals.filter(b => b.name.toLowerCase().includes(f));
      remotes = remotes.filter(b => b.name.toLowerCase().includes(f));
    }

    if (!locals.length && !remotes.length) {
      this.container!.innerHTML = `<div class="branch-empty">${f ? t('sidebar.noMatch') : t('sidebar.noBranches')}</div>`;
      return;
    }

    const reveal = this.shouldReveal;
    this.shouldReveal = false;
    this.container!.classList.toggle('is-revealing', reveal);

    const frag = document.createDocumentFragment();

    if (locals.length) {
      this.renderCollapsibleGroup(frag, t('sidebar.local'), 'local', locals, current ?? '', false);
    }

    if (remotes.length) {
      this.renderCollapsibleGroup(frag, t('sidebar.remote'), 'remote', remotes, current ?? '', true);
    }

    this.container.appendChild(frag);
  }

  renderCollapsibleGroup(
    frag: DocumentFragment,
    label: string,
    groupId: string,
    branches: Array<{ name: string; full?: string; info: BranchListInfo }>,
    current: string,
    isRemote: boolean
  ): void {
    const collapsed = this.collapsedGroups.has(groupId);

    const header = document.createElement('div');
    header.className = 'branch-group-header';
    header.dataset.groupId = groupId;
    header.innerHTML = `
      <i class="ph ph-caret-down branch-group-arrow${collapsed ? ' collapsed' : ''}"></i>
      <span>${label}</span>
    `;
    header.onclick = () => this.toggleGroup(groupId, header);
    frag.appendChild(header);

    const body = document.createElement('div');
    body.className = `branch-group-body${collapsed ? ' is-collapsed' : ''}`;
    body.dataset.groupBody = groupId;

    const folders = new Map<string, Array<{ name: string; full?: string; info: BranchListInfo }>>();
    const root: Array<{ name: string; full?: string; info: BranchListInfo }> = [];

    branches.forEach(b => {
      const idx = b.name.lastIndexOf('/');
      if (idx > 0) {
        const folder = b.name.substring(0, idx);
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder)!.push(b);
      } else {
        root.push(b);
      }
    });

    root.forEach(b => body.appendChild(this.branchRow(b, current, isRemote)));

    for (const [folder, items] of folders) {
      const folderKey = `${groupId}:${folder}`;
      const fCollapsed = this.collapsedFolders.has(folderKey);

      const folderHeader = document.createElement('div');
      folderHeader.className = 'branch-folder-header';
      folderHeader.dataset.folderKey = folderKey;
      folderHeader.innerHTML = `
        <i class="ph ph-caret-down branch-folder-arrow${fCollapsed ? ' collapsed' : ''}"></i>
        <i class="ph ph-folder-simple"></i>
        <span class="branch-folder-name">${this.esc(folder)}/</span>
        <span class="branch-folder-count">${items.length}</span>
      `;
      folderHeader.onclick = () => this.toggleFolder(folderKey, folderHeader);
      body.appendChild(folderHeader);

      items.forEach(b => {
        const leafName = b.name.slice(folder.length + 1);
        const row = this.branchRow(b, current, isRemote, leafName);
        row.dataset.folderKey = folderKey;
        if (fCollapsed) row.classList.add('is-folder-collapsed');
        body.appendChild(row);
      });
    }

    frag.appendChild(body);
  }

  toggleGroup(groupId: string, header: HTMLElement): void {
    if (this.collapsedGroups.has(groupId)) this.collapsedGroups.delete(groupId);
    else this.collapsedGroups.add(groupId);
    this.persistSet('gittree.sidebar.branchGroups', this.collapsedGroups);
    const collapsed = this.collapsedGroups.has(groupId);
    header.querySelector('.branch-group-arrow')?.classList.toggle('collapsed', collapsed);
    this.container!.querySelector(`[data-group-body="${CSS.escape(groupId ?? '')}"]`)
      ?.classList.toggle('is-collapsed', collapsed);
  }

  toggleFolder(folderKey: string, header: HTMLElement): void {
    if (this.collapsedFolders.has(folderKey)) this.collapsedFolders.delete(folderKey);
    else this.collapsedFolders.add(folderKey);
    this.persistSet('gittree.sidebar.branchFolders', this.collapsedFolders);
    const collapsed = this.collapsedFolders.has(folderKey);
    header.querySelector('.branch-folder-arrow')?.classList.toggle('collapsed', collapsed);
    this.container!.querySelectorAll<HTMLElement>(
      `.branch-item[data-folder-key="${CSS.escape(folderKey ?? '')}"]`
    ).forEach(row => row.classList.toggle('is-folder-collapsed', collapsed));
  }

  branchRow(
    branch: { name: string; full?: string; info: BranchListInfo },
    current: string,
    isRemote = false,
    displayName: string = branch.name
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'branch-item';
    el.style.setProperty('--item-index', String(Math.min(this.rowStaggerIndex || 0, 14)));
    this.rowStaggerIndex = (this.rowStaggerIndex || 0) + 1;
    if (displayName !== branch.name) el.classList.add('is-nested');
    el.tabIndex = 0;
    el.dataset.branchName = branch.name;
    el.dataset.remote = String(isRemote);
    el.dataset.branchKind = isRemote ? 'remote' : 'local';
    if (!isRemote && branch.name === current) el.classList.add('active');
    const selectionKey = `${isRemote ? 'remote' : 'local'}:${branch.name}`;
    el.dataset.selectionKey = selectionKey;
    if (this.selectedBranchKeys.has(selectionKey)) {
      el.classList.add('selected');
      if (this.selectedBranchKeys.size > 1) el.classList.add('multi-selected');
      this.selectedBranchElement = el;
    }

    const icon = document.createElement('i');
    icon.className = `ph ${isRemote ? 'ph-cloud' : 'ph-git-branch'} branch-icon`;

    const name = document.createElement('span');
    name.className = 'branch-name';
    name.textContent = displayName;
    name.title = isRemote ? `remotes/${branch.name}` : branch.name;

    const meta = document.createElement('span');
    meta.className = 'branch-meta';
    const metadata = this.branchMetadataByKey.get(
      `${isRemote ? 'remote' : 'local'}:${branch.name}`
    );
    const syncSummary = document.createElement('span');
    syncSummary.className = 'sync-indicator branch-sync-summary';
    if (!isRemote && (metadata?.ahead ?? 0) > 0) {
      syncSummary.appendChild(this.syncBadge('ahead', metadata!.ahead!, metadata!.upstream!));
    }
    if (!isRemote && (metadata?.behind ?? 0) > 0) {
      syncSummary.appendChild(this.syncBadge('behind', metadata!.behind!, metadata!.upstream!));
    }
    if (syncSummary.childElementCount) meta.appendChild(syncSummary);
    if (isRemote) {
      const bdg = document.createElement('span');
      bdg.className = 'badge badge-remote';
      bdg.textContent = t('sidebar.remote');
      meta.appendChild(bdg);
    }

    el.appendChild(icon);
    el.appendChild(name);
    el.appendChild(meta);
    return el;
  }

  syncBadge(direction: string, count: number, upstream: string): HTMLElement {
    const key = direction === 'ahead' ? 'sidebar.aheadOfUpstream' : 'sidebar.behindUpstream';
    const label = t(key, { count, upstream });
    const badge = document.createElement('span');
    badge.className = `sync-indicator-part branch-sync-badge is-${direction}`;
    badge.title = label;
    badge.setAttribute('aria-label', label);

    const icon = document.createElement('i');
    icon.className = `ph ph-arrow-${direction === 'ahead' ? 'up' : 'down'}`;
    icon.setAttribute('aria-hidden', 'true');
    const value = document.createElement('span');
    value.textContent = String(count);

    badge.appendChild(icon);
    badge.appendChild(value);
    return badge;
  }

  selectBranchRow(row: HTMLElement, event: MouseEvent | null = null): void {
    const key = row.dataset.selectionKey ?? '';
    const toggle = event && this.app.isPrimaryModifier(event);
    const shift = event && event.shiftKey;

    if (shift && this.selectionAnchorKey) {
      const allRows = [...this.container!.querySelectorAll<HTMLElement>('.branch-item')];
      const keys = allRows.map(r => r.dataset.selectionKey);
      const startIdx = keys.indexOf(this.selectionAnchorKey);
      const endIdx = keys.indexOf(key);
      if (startIdx !== -1 && endIdx !== -1) {
        if (!toggle) this.selectedBranchKeys.clear();
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        for (let i = from; i <= to; i += 1) this.selectedBranchKeys.add(keys[i] ?? '');
      }
    } else if (toggle) {
      if (this.selectedBranchKeys.has(key)) this.selectedBranchKeys.delete(key);
      else this.selectedBranchKeys.add(key);
      this.selectionAnchorKey = key;
    } else {
      this.selectedBranchKeys.clear();
      this.selectedBranchKeys.add(key);
      this.selectionAnchorKey = key;
    }

    this.selectedBranchKey = key ?? null;
    this.updateVisibleSelection();
    this.updateBatchBar();
  }

  updateVisibleSelection(): void {
    this.container!.querySelectorAll<HTMLElement>('.branch-item').forEach(row => {
      const isSelected = this.selectedBranchKeys.has(row.dataset.selectionKey ?? '');
      row.classList.toggle('selected', isSelected);
      row.classList.toggle('multi-selected', isSelected && this.selectedBranchKeys.size > 1);
    });
    this.selectedBranchElement = this.container!.querySelector<HTMLElement>(
      `.branch-item[data-selection-key="${CSS.escape(this.selectedBranchKey ?? '')}"]`
    );
  }

  updateBatchBar(): void {
    const footer = document.getElementById('batch-operations-footer')!;
    const countSpan = footer?.querySelector<HTMLElement>('.batch-selection-count');
    const namesContainer = footer?.querySelector<HTMLElement>('.batch-selected-names');
    const pullBtn = footer?.querySelector<HTMLButtonElement>('[data-batch-pull]');
    const deleteBtn = footer?.querySelector<HTMLButtonElement>('[data-batch-delete]');
    const compareBtn = footer?.querySelector<HTMLButtonElement>('[data-batch-compare]');
    const dismissBtn = footer?.querySelector<HTMLButtonElement>('[data-batch-dismiss]');

    if (this.selectedBranchKeys.size > 1) {
      const count = this.selectedBranchKeys.size;
      if (countSpan) countSpan.textContent = t('sidebar.batchSelected', { count });

      if (namesContainer) {
        const branches = this.getSelectedBranches();
        const keys = [...this.selectedBranchKeys];
        namesContainer.innerHTML = '';
        const fragment = document.createDocumentFragment();

        const displayCount = Math.min(branches.length, 5);
        for (let index = 0; index < displayCount; index += 1) {
          const branch = branches[index];
          const chip = document.createElement('span');
          chip.className = 'batch-selected-names__item';
          chip.dataset.branchName = branch.name;
          chip.title = branch.kind === 'remote' ? `remotes/${branch.name}` : branch.name;
          const label = document.createElement('span');
          label.className = 'batch-selected-names__label';
          label.textContent = branch.name.split('/').pop() ?? '';
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'batch-selected-names__remove';
          remove.setAttribute('aria-label', t('sidebar.batchRemove', { branch: branch.name }));
          remove.title = t('sidebar.batchRemove', { branch: branch.name });
          remove.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
          remove.onclick = () => this.removeSelectedBranch(keys[index]);
          chip.append(label, remove);
          fragment.appendChild(chip);
        }

        if (branches.length > 5) {
          const more = document.createElement('span');
          more.className = 'batch-selected-names__item is-more';
          more.textContent = `+${branches.length - 5}`;
          more.title = t('sidebar.batchMore', { count: branches.length - 5 });
          fragment.appendChild(more);
        }

        namesContainer.appendChild(fragment);
      }

      if (pullBtn) { pullBtn.onclick = () => this.batchPull(); pullBtn.disabled = false; }
      if (deleteBtn) { deleteBtn.onclick = () => this.batchDelete(); deleteBtn.disabled = false; }
      if (compareBtn) { compareBtn.onclick = () => this.batchCompare(); compareBtn.disabled = false; }
      if (dismissBtn) { dismissBtn.onclick = () => this.dismissSelection(); dismissBtn.disabled = false; }

      footer.classList.add('is-visible');
    } else {
      footer?.classList.remove('is-visible');
      footer?.classList.remove('is-busy');

      if (pullBtn) { pullBtn.onclick = null; pullBtn.disabled = true; }
      if (deleteBtn) { deleteBtn.onclick = null; deleteBtn.disabled = true; }
      if (compareBtn) { compareBtn.onclick = null; compareBtn.disabled = true; }
      if (dismissBtn) { dismissBtn.onclick = null; dismissBtn.disabled = true; }
    }
  }

  removeSelectedBranch(key: string): void {
    if (!this.selectedBranchKeys.delete(key)) return;
    if (this.selectedBranchKeys.size === 0) this.selectionAnchorKey = null;
    this.updateVisibleSelection();
    this.updateBatchBar();
  }

  getSelectedBranches(): BranchMetadataEntry[] {
    const branches = [];
    for (const key of this.selectedBranchKeys) {
      const [kind, ...nameParts] = key.split(':');
      const name = nameParts.join(':');
      const branch = (this.metadata?.branches || []).find(
        b => b.kind === kind && b.name === name
      );
      if (branch) branches.push(branch);
    }
    return branches;
  }

  async batchDelete(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    const branches = this.getSelectedBranches().filter(b => b.kind === 'local');
    if (!branches.length) return;

    const confirmed = await this.confirmDialog(
      t('sidebar.batchDelete'),
      t('sidebar.batchDeleteConfirm', { count: branches.length }),
      t('branchMenu.deleteAction')
    );
    if (!confirmed) return;

    let result = await window.gitTree.batchDeleteBranches(
      repo.path, branches.map(b => b.name), false
    ) as {
      error?: string;
      results?: Array<{ success?: boolean; branch?: string }>;
    };
    if (result?.error) { this.app.showToast(result.error, 'error'); return; }

    const failed = (result.results || []).filter(r => !r.success);
    const succeeded = (result.results || []).filter(r => r.success);

    if (failed.length) {
      const forceConfirmed = await this.confirmDialog(
        t('branchMenu.forceDeleteTitle'),
        t('sidebar.batchForceDeleteConfirm', { count: failed.length }),
        t('branchMenu.forceDeleteAction'),
        true
      );
      if (forceConfirmed) {
        const forceResult = await window.gitTree.batchDeleteBranches(
          repo.path, failed.map(r => r.branch), true
        ) as {
          error?: string;
          results?: Array<{ success?: boolean; branch?: string }>;
        };
        if (!forceResult?.error) {
          succeeded.push(...(forceResult.results || []).filter(r => r.success));
        }
      }
    }

    if (succeeded.length) {
      this.app.showToast(t('sidebar.batchDeleteAllSuccess', { count: succeeded.length }), 'success');
    }
    this.selectedBranchKeys.clear();
    this.selectionAnchorKey = null;
    this.updateBatchBar();
    this.app.emit('refresh');
  }

  async batchCompare(): Promise<void> {
    const branches = this.getSelectedBranches();
    if (branches.length === 2) {
      this.app.components.compare.compare(branches[0].name, branches[1].name);
    } else if (branches.length > 2) {
      this.app.components.compare.compareMatrix(branches.slice(0, 8) as Array<{ name: string }>);
    }
  }

  async batchPull(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;

    const branches = this.getSelectedBranches().filter(b => b.kind === 'local');
    if (!branches.length) return;

    // Aggiorna lo stato UI
    const footer = document.getElementById('batch-operations-footer')!;
    const infoSection = footer?.querySelector<HTMLElement>('.batch-selection-info');
    const namesContainer = footer?.querySelector<HTMLElement>('.batch-selected-names');
    if (infoSection) infoSection.classList.add('is-busy');
    footer?.classList.add('is-busy');

    this.app.setRemoteActionBusy('btn-pull', true);
    this.app.showToast(t('feedback.pullingMultiple', { count: branches.length }), 'info');

    try {
      let successCount = 0;
      let failCount = 0;

      for (const branch of branches) {
        const parts = branch.upstream?.split('/');
        if (parts && parts.length === 2) {
          const [remote, remoteBranch] = parts;
          const result = await window.gitTree.pull(repo.path, remote, remoteBranch) as { error?: string };

          const chip = namesContainer?.querySelector<HTMLElement>(
            `.batch-selected-names__item[data-branch-name="${CSS.escape(String(branch.name))}"]`
          );
          if (result.error) {
            failCount++;
            this.app.showToast(`Failed to pull ${branch.name}: ${result.error}`, 'error');
            if (chip) {
              chip.classList.add('is-error');
              const icon = document.createElement('i');
              icon.className = 'ph ph-x-circle';
              icon.setAttribute('aria-hidden', 'true');
              chip.appendChild(icon);
            }
          } else {
            successCount++;
            if (chip) {
              chip.classList.add('is-success');
              const icon = document.createElement('i');
              icon.className = 'ph ph-check';
              icon.setAttribute('aria-hidden', 'true');
              chip.appendChild(icon);
            }
          }
        }
      }

      if (failCount === 0) {
        this.app.showToast(t('feedback.pullAllComplete', { count: successCount }), 'success');
      } else if (successCount > 0) {
        this.app.showToast(
          t('feedback.pullPartialComplete', { success: successCount, failure: failCount }),
          'warning'
        );
      }

      if (this.app.isCurrentRepo(repo.path)) await this.app.refresh();
    } finally {
      this.app.setRemoteActionBusy('btn-pull', false);
      if (infoSection) infoSection.classList.remove('is-busy');
      footer?.classList.remove('is-busy');
      setTimeout(() => this.dismissSelection(), 500); // Ritardo per vedere i risultati
    }
  }

  dismissSelection(): void {
    this.selectedBranchKeys.clear();
    this.selectionAnchorKey = null;
    this.updateVisibleSelection();
    this.updateBatchBar();
  }

  confirmDialog(title: string, message: string, actionLabel: string, danger = false): Promise<unknown> {
    return this.app.dialogs.confirm({
      title,
      message,
      cancelLabel: t('common.cancel'),
      actionLabel,
      danger
    });
  }

  activateBranchRow(row: HTMLElement): void {
    const branchName = row.dataset.branchName;
    if (!branchName) return;
    if (this.checkoutBusy) return;
    this.switchFromDirection = this.detectSwitchDirection(row);
    if (row.dataset.remote === 'true') {
      this.checkoutRemote(branchName.split('/').pop() ?? '', branchName, row);
    } else {
      this.checkout(branchName, row);
    }
  }

  detectSwitchDirection(row: HTMLElement): string | null {
    const activeRow = this.container!.querySelector<HTMLElement>('.branch-item.active');
    if (!activeRow || activeRow === row) return null;
    return row.getBoundingClientRect().top > activeRow.getBoundingClientRect().top
      ? 'top'
      : 'bottom';
  }

  setRowBusy(row: HTMLElement | null, busy: boolean): void {
    if (!row) return;
    row.classList.toggle('is-checking-out', busy);
    const icon = row.querySelector<HTMLElement>('.branch-icon');
    if (!icon) return;
    if (busy) {
      icon.dataset.originalIcon = icon.className;
      icon.className = 'ph ph-circle-notch branch-icon';
    } else if (icon.dataset.originalIcon) {
      icon.className = icon.dataset.originalIcon;
      delete icon.dataset.originalIcon;
    }
  }

  async checkout(name: string, row: HTMLElement | null = null): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || this.checkoutBusy) return;
    row = row || this.container!.querySelector<HTMLElement>(
      `.branch-item[data-branch-kind="local"][data-branch-name="${CSS.escape(name)}"]`
    );
    this.checkoutBusy = true;
    this.setRowBusy(row, true);
    try {
      const r = await window.gitTree.checkoutBranch(repo.path, name) as { error?: string };
      if (r.error) { this.app.showToast(r.error, 'error'); return; }
      if (!this.app.isCurrentRepo(repo.path)) return;
      await this.app.afterBranchCheckout(r, repo.path);
    } finally {
      this.checkoutBusy = false;
      this.switchFromDirection = null;
      this.setRowBusy(row, false);
    }
  }

  async checkoutRemote(localName: string, remoteName: string, row: HTMLElement | null = null): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || this.checkoutBusy) return;
    row = row || this.container!.querySelector<HTMLElement>(
      `.branch-item[data-branch-kind="remote"][data-branch-name="${CSS.escape(remoteName)}"]`
    );
    this.checkoutBusy = true;
    this.setRowBusy(row, true);
    try {
      const r = await window.gitTree.checkoutTrackingBranch(repo.path, remoteName) as { error?: string };
      if (r.error) { this.app.showToast(r.error, 'error'); return; }
      if (!this.app.isCurrentRepo(repo.path)) return;
      await this.app.afterBranchCheckout(r, repo.path);
    } finally {
      this.checkoutBusy = false;
      this.switchFromDirection = null;
      this.setRowBusy(row, false);
    }
  }

  async promptCreateBranch(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    const result = await this.quickBranchDialog(repo.path) as { success?: boolean; name?: string } | null;
    if (!result?.success) return;
    this.app.showToast(t('feedback.branchCreated', { branch: result.name }), 'success');
    await this.app.refresh({ silent: true });
  }

  createBranch(repoPath: string, name: string): Promise<unknown> {
    return window.gitTree.createBranch(repoPath, name);
  }

  quickBranchDialog(repoPath: string): Promise<Record<string, unknown> | null> {
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    const prefixes: Record<string, string> = {
      feature: BranchNaming.detectPrefix('feature', (this.metadata ?? undefined) as BranchMetadata | undefined),
      bugfix: BranchNaming.detectPrefix('bugfix', (this.metadata ?? undefined) as BranchMetadata | undefined)
    };
    const localNames = new Set(
      (this.metadata?.branches || [])
        .filter(branch => branch.kind === 'local')
        .map(branch => branch.name.toLowerCase())
    );

    return new Promise(resolve => {
      dialog.className = 'confirm-dialog quick-branch-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'quick-branch-title');
      dialog.innerHTML = `
        <form class="branch-dialog-form quick-branch-form">
          <div class="quick-branch-heading">
            <span class="eyebrow">${this.esc(t('sidebar.quickBranchEyebrow'))}</span>
            <h3 id="quick-branch-title">${this.esc(t('sidebar.quickBranchTitle'))}</h3>
            <p>${this.esc(t('sidebar.quickBranchHelp'))}</p>
          </div>
          <fieldset class="quick-branch-types">
            <legend>${this.esc(t('sidebar.branchType'))}</legend>
            <div class="segmented-control" role="group">
              <button class="btn active" type="button" data-branch-type="feature"
                aria-pressed="true">
                <i class="ph ph-sparkle" aria-hidden="true"></i>
                ${this.esc(t('sidebar.featureBranch'))}
              </button>
              <button class="btn" type="button" data-branch-type="bugfix"
                aria-pressed="false">
                <i class="ph ph-bug" aria-hidden="true"></i>
                ${this.esc(t('sidebar.bugfixBranch'))}
              </button>
              <button class="btn" type="button" data-branch-type="custom"
                aria-pressed="false">
                <i class="ph ph-pencil-simple" aria-hidden="true"></i>
                ${this.esc(t('sidebar.customBranch'))}
              </button>
            </div>
          </fieldset>
          <label>
            ${this.esc(t('sidebar.branchDescription'))}
            <input name="description" maxlength="160" required autofocus
              placeholder="${this.esc(t('sidebar.branchDescriptionPlaceholder'))}">
          </label>
          <div class="quick-branch-preview">
            <span>${this.esc(t('sidebar.branchPreview'))}</span>
            <code data-branch-preview>${this.esc(`${prefixes.feature}/`)}</code>
          </div>
          <p class="quick-branch-convention" data-branch-convention></p>
          <p class="quick-branch-error" data-branch-error aria-live="polite"></p>
          <div class="confirm-actions">
            <button class="btn" type="button" data-cancel>${this.esc(t('common.cancel'))}</button>
            <button class="btn btn-primary" type="submit" data-create disabled>
              <i class="ph ph-git-branch" aria-hidden="true"></i>
              ${this.esc(t('sidebar.createBranch'))}
            </button>
          </div>
        </form>`;
      overlay.classList.remove('is-hidden');

      const form = dialog.querySelector('form') as HTMLFormElement;
      const input = (form.elements as unknown as Record<string, HTMLInputElement>).description;
      const preview = dialog.querySelector<HTMLElement>('[data-branch-preview]')!;
      const convention = dialog.querySelector<HTMLElement>('[data-branch-convention]')!;
      const error = dialog.querySelector<HTMLElement>('[data-branch-error]')!;
      const create = dialog.querySelector<HTMLButtonElement>('[data-create]')!;
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!;
      const typeButtons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-branch-type]')];
      let selectedType = 'feature';
      let submitting = false;

      const update = () => {
        const value = input.value;
        const name = BranchNaming.compose(selectedType, value, (this.metadata ?? undefined) as BranchMetadata | undefined);
        const exists = Boolean(name && localNames.has(name.toLowerCase()));
        preview.textContent = name || (
          selectedType === 'custom' ? t('sidebar.customBranchPlaceholder') : `${prefixes[selectedType]}/`
        );
        convention.textContent = selectedType === 'custom'
          ? t('sidebar.customConvention')
          : t('sidebar.detectedConvention', {
              prefix: `${prefixes[selectedType]}/`
            });
        input.placeholder = selectedType === 'custom'
          ? t('sidebar.customBranchPlaceholder')
          : t('sidebar.branchDescriptionPlaceholder');
        error.textContent = exists
          ? t('sidebar.branchAlreadyExists', { branch: name })
          : (value.trim() && !name ? t('sidebar.invalidBranchDescription') : '');
        create.disabled = submitting || !name || exists;
      };

      const finish = (value: Record<string, unknown> | null) => {
        document.removeEventListener('keydown', onKeydown);
        overlay.removeEventListener('click', onOverlayClick);
        overlay.classList.add('is-hidden');
        dialog.className = 'confirm-dialog';
        dialog.removeAttribute('role');
        dialog.removeAttribute('aria-modal');
        dialog.removeAttribute('aria-labelledby');
        dialog.innerHTML = '';
        resolve(value);
      };
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || submitting) return;
        event.preventDefault();
        finish(null);
      };
      const onOverlayClick = (event: MouseEvent) => {
        if (event.target === overlay && !submitting) finish(null);
      };

      typeButtons.forEach(button => {
        button.onclick = () => {
          selectedType = button.dataset.branchType ?? 'feature';
          typeButtons.forEach(item => {
            const active = item === button;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
          });
          update();
          input.focus();
        };
      });
      input.addEventListener('input', update);
      cancel.onclick = () => {
        if (!submitting) finish(null);
      };
      form.onsubmit = async event => {
        event.preventDefault();
        const name = BranchNaming.compose(selectedType, input.value, (this.metadata ?? undefined) as BranchMetadata | undefined);
        if (!name || localNames.has(name.toLowerCase())) return;
        submitting = true;
        form.classList.add('is-submitting');
        input.disabled = true;
        typeButtons.forEach(button => { button.disabled = true; });
        cancel.disabled = true;
        create!.querySelector('i')!.className = 'ph ph-circle-notch';
        update();
        error.textContent = t('sidebar.creatingBranch');
        try {
          const result = await this.createBranch(repoPath, name) as { success?: boolean; error?: string; name?: string };
          if (!result?.success || result?.error) {
            throw new Error(result?.error || t('sidebar.branchCreateFailed'));
          }
          finish({ ...result, name: result.name || name });
        } catch (branchError) {
          submitting = false;
          form.classList.remove('is-submitting');
          input.disabled = false;
          typeButtons.forEach(button => { button.disabled = false; });
          cancel.disabled = false;
          create!.querySelector('i')!.className = 'ph ph-git-branch';
          update();
          error.textContent = (branchError as Error).message || t('sidebar.branchCreateFailed');
          input.focus();
        }
      };
      document.addEventListener('keydown', onKeydown);
      overlay.addEventListener('click', onOverlayClick);
      update();
      input.focus();
    });
  }

  get current(): string | undefined { return this.data?.current; }

  restoreSet(storageKey: string): Set<string> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      return new Set(Array.isArray(parsed) ? parsed as string[] : []);
    } catch {
      return new Set();
    }
  }

  persistSet(storageKey: string, values: Set<string>): void {
    localStorage.setItem(storageKey, JSON.stringify([...values]));
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { BranchListView: typeof BranchListView }).BranchListView = BranchListView;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = BranchListView;
}

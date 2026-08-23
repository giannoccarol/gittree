interface BranchRef {
  name: string;
  kind: string;
  current?: boolean;
  upstream?: string;
}

interface BranchMetadataShape {
    branches?: Array<{ name: string; kind: string; current?: boolean; upstream?: string }>;
  remotes?: Array<{ name: string; provider?: { provider?: string } }>;
  current?: string;
  defaultBranch?: string;
}

interface StatusShape {
  isClean?: boolean;
  modified?: string[];
  not_added?: string[];
  created?: string[];
  deleted?: string[];
}

interface OperationStateShape {
  type?: string;
}


import type { CheckoutResult, GitTreeApp } from '../app.mts';

interface MenuItem {
  icon: string;
  label: string;
  action?: string | null;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  children?: MenuItem[];
  separator?: boolean;
}

export class BranchContextMenu {
  app: GitTreeApp;
  branch: BranchRef | null;
  metadata: BranchMetadataShape | null;
  status: StatusShape | null;
  operationState: OperationStateShape | null;
  selectedBranches: BranchRef[];
  element: HTMLElement;
  onDocumentPointer: (event: PointerEvent) => void;
  onDocumentClick: (event: MouseEvent) => void;
  onScroll: (event: Event) => void;
  onKeyDown: (event: KeyboardEvent) => void;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.branch = null;
    this.metadata = null;
    this.status = null;
    this.operationState = null;
    this.selectedBranches = [];
    this.element = document.createElement('div');
    this.element.className = 'branch-context-menu is-hidden';
    this.element.setAttribute('role', 'menu');
    document.body.appendChild(this.element);

    this.onDocumentPointer = event => {
      if (!this.element.contains(event.target as Node)) this.close();
    };
    this.onDocumentClick = event => {
      if (!this.element.contains(event.target as Node)) this.close();
    };
    this.onScroll = event => {
      if (!this.element.contains(event.target as Node)) this.close();
    };
    this.onKeyDown = event => this.handleKeyDown(event);
    document.addEventListener('pointerdown', this.onDocumentPointer, true);
    document.addEventListener('click', this.onDocumentClick, true);
    document.addEventListener('scroll', this.onScroll, true);
    document.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', () => this.close());
    window.addEventListener('blur', () => this.close());
  }

  open(
    event: MouseEvent,
    branch: BranchRef,
    metadata: BranchMetadataShape | null,
    status: StatusShape | null,
    operationState: OperationStateShape | null,
    selectedBranches: BranchRef[] = []
  ): void {
    event.preventDefault();
    this.branch = branch;
    this.metadata = metadata || { branches: [], remotes: [] };
    this.status = status || {};
    this.operationState = operationState || {};
    this.selectedBranches = selectedBranches.length > 1 ? selectedBranches : [];
    this.render();
    this.element.classList.remove('is-hidden');
    this.place(event.clientX, event.clientY);
    requestAnimationFrame(() => this.focusFirst());
  }

  close(): void {
    if (this.element.classList.contains('is-hidden')) return;
    this.element.classList.add('is-hidden');
    this.element.innerHTML = '';
    this.branch = null;
  }

  render(): void {
    const b = this.branch as BranchRef;
    const current = this.metadata?.current || this.app.state.currentBranch;
    const pending = Boolean(this.operationState?.type);
    const dirty = this.status && this.status.isClean === false;
    const isLocal = b.kind === 'local';
    const isCurrent = isLocal && b.current;
    const remoteParts = b.kind === 'remote' ? this.splitRemote(b.name) : null;
    const upstreamParts = b.upstream ? this.splitRemote(b.upstream) : null;
    const currentMetadata = (this.metadata?.branches || []).find(item => item.current);
    const pullUpstream = isLocal
      ? (isCurrent ? b.upstream : '')
      : (currentMetadata?.upstream === b.name ? b.name : '');
    const mutationReason = pending
      ? t('branchMenu.pendingOperation', { operation: this.operationState!.type })
      : '';
    const blockingFiles = [
      ...(this.status?.modified || []),
      ...(this.status?.not_added || []),
      ...(this.status?.created || []),
      ...(this.status?.deleted || [])
    ];
    const cleanReason = dirty
      ? `${t('branchMenu.cleanRequired')}${blockingFiles.length ? `: ${blockingFiles.slice(0, 3).join(', ')}${blockingFiles.length > 3 ? '…' : ''}` : ''}`
      : mutationReason;
    const remotes = this.metadata?.remotes || [];
    const remoteBranches = (this.metadata?.branches || []).filter(item => item.kind === 'remote');

    const isMulti = this.selectedBranches.length > 1;

    if (isMulti) {
      const localSelected = this.selectedBranches.filter(br => br.kind === 'local');
      const actions: Array<MenuItem | { separator: boolean }> = [
        this.item('ph-trash', t('branchMenu.deleteMultiple', { count: localSelected.length }), 'batch-delete',
          !localSelected.length || pending, mutationReason, true),
        this.item('ph-arrows-left-right', t('branchMenu.compareMultiple', { count: this.selectedBranches.length }), 'batch-compare',
          this.selectedBranches.length < 2, '')
      ];

      this.element.innerHTML = actions.filter(Boolean).map(action => this.renderItem(action!)).join('');
      this.element.querySelectorAll('[data-action]:not([aria-disabled="true"])').forEach(item => {
        item.addEventListener('click', event => {
          event.stopPropagation();
          const action = (item as HTMLElement).dataset.action;
          if (action) this.execute(action);
        });
      });
      return;
    }

    const actions: Array<MenuItem | { separator: boolean } | null> = [
      this.item('ph-arrow-circle-right', t('branchMenu.checkout', { branch: b.name }), 'checkout',
        isCurrent || pending, isCurrent ? t('branchMenu.alreadyCurrent') : mutationReason),
      this.item('ph-git-merge', t('branchMenu.mergeIntoCurrent', {
        branch: b.name,
        target: current
      }), 'merge',
        b.name === current || pending,
        b.name === current ? t('branchMenu.sameBranch') : cleanReason),
      this.item('ph-git-branch', t('branchMenu.rebaseOnto', { branch: b.name }), 'rebase',
        b.name === current || dirty || pending,
        b.name === current ? t('branchMenu.sameBranch') : cleanReason),
      { separator: true },
      this.item('ph-cloud-arrow-down', t('branchMenu.fetch', { branch: b.name }), 'fetch',
        (!remoteParts && !upstreamParts) || pending,
        mutationReason || t('branchMenu.noUpstream')),
      this.item('ph-download-simple', t('branchMenu.pullTracked'), 'pull',
        !pullUpstream || pending,
        !pullUpstream ? t('branchMenu.currentOnly') : mutationReason),
      isLocal
        ? this.submenu('ph-upload-simple', b.upstream ? t('branchMenu.pushTracked') : t('branchMenu.pushTo'), [
            ...(b.upstream ? [this.item('ph-arrow-up', b.upstream, 'push-tracked', pending, mutationReason)] : []),
            ...remotes.map(remote => this.item('ph-cloud', remote.name, `push:${remote.name}`, pending, mutationReason))
          ], remotes.length === 0, t('branchMenu.noRemotes'))
        : null,
      isLocal
        ? this.submenu('ph-link', t('branchMenu.trackRemote'), remoteBranches.map(remoteBranch =>
            this.item('ph-cloud', remoteBranch.name, `track:${remoteBranch.name}`, pending, mutationReason)
          ), remoteBranches.length === 0, t('branchMenu.noRemoteBranches'))
        : null,
      dirty && isLocal
        ? this.item('ph-archive', t('branchMenu.stashChanges'), 'stash', pending, mutationReason)
        : null,
      { separator: true },
      this.item('ph-arrows-left-right', t('branchMenu.diffAgainstCurrent'), 'diff',
        b.name === current, t('branchMenu.sameBranch')),
      { separator: true },
      isLocal
        ? this.item('ph-pencil-simple', t('branchMenu.rename', { branch: b.name }), 'rename',
            pending, mutationReason)
        : this.item('ph-pencil-simple', t('branchMenu.renameUnavailable'), null, true,
            t('branchMenu.localOnly')),
      this.item('ph-trash', t('branchMenu.delete', { branch: b.name }), 'delete',
        isCurrent || pending, isCurrent ? t('branchMenu.deleteCurrent') : mutationReason, true),
      { separator: true },
      this.item('ph-tabs', t('branchMenu.newWorktree'), 'worktree',
        !isLocal || pending,
        !isLocal ? t('branchMenu.localOnly') : mutationReason),
      this.item('ph-git-pull-request', t('branchMenu.createPullRequest'), 'pull-request',
        !this.hasSupportedProvider() || pending,
        mutationReason || t('branchMenu.unsupportedProvider')),
      { separator: true },
      this.item('ph-tag', t('branchMenu.pushTags'), 'push-tags',
        remotes.length === 0 || pending,
        remotes.length === 0 ? t('branchMenu.noRemotes') : mutationReason),
      this.item('ph-sliders-horizontal', t('branchMenu.manageRemotes'), 'manage-remotes',
        pending, mutationReason),
      this.item('ph-clock-counter-clockwise', t('branchMenu.viewReflog'), 'view-reflog',
        pending, mutationReason)
    ];

    this.element.innerHTML = actions.filter(Boolean).map(action => this.renderItem(action!)).join('');
    this.element.querySelectorAll('[data-action]:not([aria-disabled="true"])').forEach(item => {
      item.addEventListener('click', event => {
        event.stopPropagation();
        const action = (item as HTMLElement).dataset.action;
        if (action) this.execute(action);
      });
    });
  }

  item(icon: string, label: string, action: string | null, disabled = false, reason = '', danger = false): MenuItem {
    return { icon, label, action, disabled, reason, danger };
  }

  submenu(icon: string, label: string, children: MenuItem[], disabled = false, reason = ''): MenuItem {
    return { icon, label, children, disabled, reason };
  }

  renderItem(item: Partial<MenuItem> & { separator?: boolean }): string {
    if (item.separator) return '<div class="branch-menu-separator" role="separator"></div>';
    const disabled = item.disabled ? ' aria-disabled="true"' : '';
    const action = item.action ? ` data-action="${this.esc(item.action)}"` : '';
    const title = item.reason ? ` title="${this.esc(item.reason)}"` : '';
    const danger = item.danger ? ' danger' : '';
    const submenu = item.children ? ' has-submenu' : '';
    const childHtml = item.children
      ? `<div class="branch-context-submenu" role="menu">${item.children.map(child => this.renderItem(child)).join('')}</div>`
      : '';
    return `<div class="branch-menu-item${danger}${submenu}" role="menuitem" tabindex="-1"${action}${disabled}${title}>
      <i class="ph ${item.icon}" aria-hidden="true"></i>
      <span>${this.esc(item.label)}</span>
      ${item.children ? '<i class="ph ph-caret-right branch-menu-caret" aria-hidden="true"></i>' : ''}
      ${childHtml}
    </div>`;
  }

  async execute(action: string): Promise<void> {
    const repo = this.app.state.repo;
    const b = this.branch;
    if (!repo || !b) return;
    this.close();

    let result: { error?: string; conflictState?: { type?: string }; path?: string } | undefined | null;
    try {
      if (action === 'batch-delete') {
        this.app.components.branchList.batchDelete();
        return;
      }
      if (action === 'batch-compare') {
        this.app.components.branchList.batchCompare();
        return;
      }

      if (action === 'checkout') {
        result = (b.kind === 'remote'
          ? await window.gitTree.checkoutTrackingBranch(repo.path, b.name)
          : await window.gitTree.checkoutBranch(repo.path, b.name)) as typeof result;
      } else if (action === 'merge') {
        this.app.components.merge.open(
          b.name,
          String(this.metadata?.current || this.app.state.currentBranch)
        );
        return;
      } else if (action === 'rebase') {
        result = await window.gitTree.rebaseBranch(repo.path, b.name) as typeof result;
      } else if (action === 'fetch') {
        const parts = b.kind === 'remote' ? this.splitRemote(b.name) : this.splitRemote(b.upstream);
        result = await window.gitTree.fetchBranch(repo.path, parts.remote, parts.branch) as typeof result;
      } else if (action === 'pull') {
        const parts = this.splitRemote(b.kind === 'remote' ? b.name : b.upstream);
        result = await window.gitTree.pull(repo.path, parts.remote, parts.branch) as typeof result;
      } else if (action === 'push-tracked') {
        const parts = this.splitRemote(b.upstream);
        result = await window.gitTree.push(repo.path, parts.remote, b.name) as typeof result;
      } else if (action.startsWith('push:')) {
        result = await window.gitTree.push(repo.path, action.slice(5), b.name, !b.upstream) as typeof result;
      } else if (action.startsWith('track:')) {
        result = await window.gitTree.trackBranch(repo.path, b.name, action.slice(6)) as typeof result;
      } else if (action === 'stash') {
        result = await window.gitTree.stash(repo.path, `GitTree: before branch operation on ${b.name}`) as typeof result;
      } else if (action === 'diff') {
        await this.app.components.compare.compare(b.name, String(this.metadata?.current));
        return;
      } else if (action === 'rename') {
        const nextName = await this.promptText(t('branchMenu.renameTitle'), b.name);
        if (!nextName || nextName === b.name) return;
        result = await window.gitTree.renameBranch(repo.path, b.name, nextName) as typeof result;
      } else if (action === 'delete') {
        result = await this.deleteBranch(repo.path, b);
        if (!result) return;
      } else if (action === 'pull-request') {
        await this.openPullRequest(repo.path, b);
        return;
      } else if (action === 'worktree') {
        await this.createWorktreeForBranch(repo, b);
        return;
      }

      if (result?.error) {
        if (result.conflictState?.type) await this.app.components.conflict.open(result.conflictState);
        this.app.showToast(result.error, 'error');
        return;
      }
      if (action === 'checkout') {
        if (!this.app.isCurrentRepo(repo.path)) return;
        await this.app.afterBranchCheckout(result as CheckoutResult, repo.path);
        this.app.showToast(t('branchMenu.operationComplete'), 'success');
        return;
      }
      if (action === 'push-tags') {
        const defaultRemote = this.metadata?.remotes?.[0]?.name;
        if (!defaultRemote) return;
        const remote = await this.promptRemote(defaultRemote);
        if (!remote) return;
        result = await window.gitTree.pushTags(repo.path, remote) as typeof result;
        if (result?.error) { this.app.showToast(result.error, 'error'); return; }
        this.app.showToast(t('branchMenu.tagsPushed', { remote }), 'success');
        return;
      }
      if (action === 'manage-remotes') {
        this.close();
        await this.app.components.settings.open('remotes');
        return;
      }
      if (action === 'view-reflog') {
        this.close();
        await this.app.components.reflog.open();
        return;
      }
      this.app.showToast(t('branchMenu.operationComplete'), 'success');
      this.app.emit('refresh');
    } catch (error) {
      this.app.showToast((error as Error).message, 'error');
    }
  }

  async deleteBranch(repoPath: string, branch: BranchRef): Promise<{ error?: string } | null> {
    const confirmed = await this.confirm(
      t('branchMenu.deleteTitle'),
      t('branchMenu.deleteConfirm', { branch: branch.name }),
      t('branchMenu.deleteAction')
    );
    if (!confirmed) return null;
    if (branch.kind === 'remote') {
      const parts = this.splitRemote(branch.name);
      return window.gitTree.deleteRemoteBranch(repoPath, parts.remote, parts.branch) as Promise<{ error?: string }>;
    }
    const safe = await window.gitTree.deleteBranch(repoPath, branch.name, false) as { error?: string };
    if (!safe?.error) return safe;
    const force = await this.confirm(
      t('branchMenu.forceDeleteTitle'),
      t('branchMenu.forceDeleteConfirm', { branch: branch.name }),
      t('branchMenu.forceDeleteAction'),
      true
    );
    return force ? window.gitTree.deleteBranch(repoPath, branch.name, true) as Promise<{ error?: string }> : null;
  }

  async openPullRequest(repoPath: string, branch: BranchRef): Promise<void> {
    const supported = (this.metadata?.remotes || []).filter(remote => remote.provider?.provider);
    if (!supported.length) return;
    const upstream = branch.upstream ? this.splitRemote(branch.upstream) : null;
    const defaultRemote = supported.find(remote => remote.name === upstream?.remote) || supported[0];
    const provider = defaultRemote.provider?.provider;
    const canApi = ['github', 'gitlab', 'azure'].includes(String(provider))
      && ((await window.gitTree.getProviderStatus(provider)) as { connected?: boolean })?.connected;
    if (canApi && this.app.components.pullRequests) {
      const view = this.app.components.pullRequests;
      const source = branch.kind === 'remote'
        ? this.splitRemote(branch.name).branch
        : branch.name;
      this.app.setWorkspaceMode('pullRequests');
      await view.setProvider(String(provider));
      await view.openCreateDialog({ source, force: true });
      return;
    }
    const values = await this.pullRequestDialog(defaultRemote.name, String(this.metadata!.defaultBranch)) as { remote: string; target: string } | null;
    if (!values) return;
    let source = branch.kind === 'remote' ? this.splitRemote(branch.name).branch : branch.name;
    if (branch.kind === 'local' && (!branch.upstream || upstream!.remote !== values.remote)) {
      const pushed = await window.gitTree.push(repoPath, values.remote, branch.name, true) as { error?: string };
      if (pushed?.error) {
        this.app.showToast(pushed.error, 'error');
        return;
      }
    }
    const result = await window.gitTree.openPullRequest(
      repoPath, values.remote, source, values.target
    ) as { error?: string };
    if (result?.error) this.app.showToast(result.error, 'error');
  }

  pullRequestDialog(remote: string, target: string): Promise<unknown> {
    return this.formDialog(t('branchMenu.prTitle'), `
      <label>${this.esc(t('branchMenu.remoteLabel'))}
        <select name="remote">${(this.metadata?.remotes || []).filter(item => item.provider?.provider)
          .map(item => `<option value="${this.esc(item.name)}"${item.name === remote ? ' selected' : ''}>${this.esc(item.name)}</option>`)
          .join('')}</select>
      </label>
      <label>${this.esc(t('branchMenu.targetLabel'))}
        <input name="target" value="${this.esc(target || '')}" required>
      </label>
    `, form => ({
      remote: (form.elements as unknown as Record<string, HTMLSelectElement>).remote.value,
      target: (form.elements as unknown as Record<string, HTMLInputElement>).target.value.trim()
    }));
  }

  promptText(title: string, value = ''): Promise<unknown> {
    return this.formDialog(title, `<label>${this.esc(t('branchMenu.branchNameLabel'))}<input name="value" value="${this.esc(value)}" required autofocus></label>`,
      form => (form.elements as unknown as Record<string, HTMLInputElement>).value.value.trim());
  }

  promptRemote(defaultRemote: string): Promise<unknown> {
    const remotes = this.metadata?.remotes || [];
    return this.formDialog(t('branchMenu.pushTags'), `
      <label>${this.esc(t('branchMenu.remoteLabel'))}
        <select name="remote">${remotes
          .map(item => `<option value="${this.esc(item.name)}"${item.name === defaultRemote ? ' selected' : ''}>${this.esc(item.name)}</option>`)
          .join('')}</select>
      </label>
    `, form => (form.elements as unknown as Record<string, HTMLSelectElement>).remote.value);
  }

  async createWorktreeForBranch(repo: { path?: string }, branch: BranchRef): Promise<void> {
    const directory = await window.gitTree.selectDirectory();
    if (!directory) return;
    const values = await this.formDialog(t('branchMenu.worktreeBranch'), `
      <label>${this.esc(t('agents.branchMode'))}
        <select name="mode">
          <option value="new">${this.esc(t('agents.newBranch'))}</option>
          <option value="existing">${this.esc(t('agents.existingBranch'))}</option>
        </select>
      </label>
      <label>${this.esc(t('agents.baseRef'))}<input name="baseRef" value="${this.esc(branch.name)}" maxlength="512" required></label>
      <label>${this.esc(t('agents.branch'))}<input name="branch" value="${this.esc(`${branch.name}-worktree`)}" maxlength="255" required></label>
    `, form => ({
      createBranch: (form.elements as unknown as Record<string, HTMLSelectElement>).mode.value === 'new',
      baseRef: (form.elements as unknown as Record<string, HTMLInputElement>).baseRef.value.trim(),
      branch: (form.elements as unknown as Record<string, HTMLInputElement>).branch.value.trim()
    })) as { createBranch: boolean; baseRef: string; branch: string } | null;
    if (!values) return;
    const result = await window.gitTree.createManagedWorktree(repo.path, directory, values) as { error?: string; path?: string };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      return;
    }
    this.app.showToast(t('branchMenu.worktreeCreated', { path: result.path }), 'success');
    await this.app.components.repoTabs.addRepo(String(result.path));
  }

  formDialog(title: string, fields: string, extract: (form: HTMLFormElement) => unknown): Promise<unknown> {
    return this.app.dialogs.form({
      title,
      fields,
      extract,
      cancelLabel: t('common.cancel'),
      actionLabel: t('common.continue')
    });
  }

  confirm(title: string, message: string, actionLabel: string, danger = false): Promise<unknown> {
    return this.app.dialogs.confirm({
      title,
      message,
      cancelLabel: t('common.cancel'),
      actionLabel,
      danger
    });
  }

  place(x: number, y: number): void {
    this.element.classList.toggle('open-left', x > window.innerWidth - 620);
    this.element.classList.toggle('open-up', y > window.innerHeight - 440);
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
    const rect = this.element.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  focusFirst(): void {
    this.element.querySelector<HTMLElement>('.branch-menu-item:not([aria-disabled="true"])')?.focus();
  }

  handleKeyDown(event: KeyboardEvent): void {
    if (this.element.classList.contains('is-hidden')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const items = [...((active?.parentElement || this.element) as HTMLElement).children]
      .filter(item => (item as HTMLElement).classList?.contains('branch-menu-item') && item.getAttribute('aria-disabled') !== 'true') as HTMLElement[];
    const index = active ? items.indexOf(active) : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    } else if (event.key === 'ArrowRight') {
      const child = active?.querySelector<HTMLElement>('.branch-context-submenu .branch-menu-item:not([aria-disabled="true"])');
      if (child) { event.preventDefault(); child.focus(); }
    } else if (event.key === 'ArrowLeft' && active?.closest('.branch-context-submenu')) {
      event.preventDefault();
      active.closest<HTMLElement>('.has-submenu')?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      active?.click();
    }
  }

  splitRemote(value = ''): { remote: string; branch: string } {
    const index = value.indexOf('/');
    return { remote: value.slice(0, index), branch: value.slice(index + 1) };
  }

  hasSupportedProvider(): boolean {
    return (this.metadata?.remotes || []).some(remote => remote.provider?.provider);
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { BranchContextMenu: typeof BranchContextMenu }).BranchContextMenu = BranchContextMenu;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = BranchContextMenu;
}

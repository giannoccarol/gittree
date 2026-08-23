import type { GitTreeApp } from '../app.mts';

interface CommitPreview {
  action: string;
  allowed: boolean;
  reason?: string;
  commits: Array<{ hash: string; subject: string }>;
  files: string[];
  target?: string;
  workingTree?: { clean?: boolean };
  error?: string;
}


export class CommitContextMenu {
  app: GitTreeApp;
  hashes: string[];
  previews: Record<string, CommitPreview>;
  generation: number;
  element: HTMLElement;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.hashes = [];
    this.previews = {};
    this.generation = 0;
    this.element = document.createElement('div');
    this.element.className = 'commit-context-menu is-hidden';
    this.element.setAttribute('role', 'menu');
    document.body.appendChild(this.element);

    document.addEventListener('pointerdown', event => {
      if (!this.element.contains(event.target as Node)) this.close();
    }, true);
    document.addEventListener('scroll', () => this.close(), true);
    document.addEventListener('keydown', event => this.handleKeyDown(event));
    window.addEventListener('resize', () => this.close());
    window.addEventListener('blur', () => this.close());
  }

  open(event: MouseEvent, hashes: string[]): void {
    if (!this.app.state.repo || !hashes.length) return;
    event.preventDefault();
    this.hashes = hashes;
    this.previews = {};
    const generation = ++this.generation;
    this.render();
    this.element.classList.remove('is-hidden');
    this.place(event.clientX, event.clientY);
    requestAnimationFrame(() => this.focusFirst());
    this.loadPreviews(generation, this.app.state.repo.path, hashes, {
      x: event.clientX,
      y: event.clientY
    });
  }

  loadPreviews(generation: number, repoPath: string, hashes: string[], position: { x: number; y: number }): Promise<unknown> {
    const settle = (action: string, request: unknown) => Promise.resolve(request)
      .then(result => this.normalizePreview(action, result))
      .catch((error: Error) => this.normalizePreview(action, { error: error?.message || String(error) }))
      .then(preview => {
        if (generation !== this.generation || this.element.classList.contains('is-hidden')) return;
        this.previews[action] = preview;
        this.render();
        this.place(position.x, position.y);
      });

    const requests = [];
    try {
      requests.push(settle(
        'cherry-pick',
        window.gitTree.previewCommitAction(repoPath, 'cherry-pick', hashes)
      ));
    } catch (error) {
      requests.push(settle('cherry-pick', Promise.reject(error)));
    }
    if (hashes.length === 1) {
      try {
        requests.push(settle(
          'rebase',
          window.gitTree.previewCommitAction(repoPath, 'rebase', hashes)
        ));
      } catch (error) {
        requests.push(settle('rebase', Promise.reject(error)));
      }
    } else {
      requests.push(settle('rebase', {
        action: 'rebase',
        allowed: false,
        reason: t('commitMenu.singleRebase'),
        commits: [],
        files: []
      }));
    }
    return Promise.all(requests);
  }

  normalizePreview(action: string, preview: unknown): CommitPreview {
    if (preview && typeof (preview as { allowed?: unknown }).allowed === 'boolean') {
      const source = preview as { allowed: boolean; commits?: unknown[]; files?: unknown[] } & Record<string, unknown>;
      return {
        ...source,
        action,
        commits: Array.isArray(source.commits) ? source.commits as Array<{ hash: string; subject: string }> : [],
        files: Array.isArray(source.files) ? source.files as string[] : []
      };
    }
    return {
      action,
      allowed: false,
      reason: (preview as { error?: string })?.error || t('common.error'),
      commits: [],
      files: []
    };
  }

  render(): void {
    const rebaseLoading = !Object.hasOwn(this.previews, 'rebase');
    const cherryPickLoading = !Object.hasOwn(this.previews, 'cherry-pick');
    const rebase = this.previews.rebase;
    const cherryPick = this.previews['cherry-pick'];
    const actions = [
      {
        action: 'compare-commits',
        icon: 'ph-arrows-left-right',
        label: t('commitMenu.compareCommits'),
        disabled: this.hashes.length !== 2,
        reason: this.hashes.length !== 2 ? t('commitMenu.compareRequiresTwo') : ''
      },
      {
        action: 'explain-commit',
        icon: 'ph-sparkle',
        label: t('commitMenu.aiExplain'),
        disabled: this.hashes.length !== 1,
        reason: this.hashes.length !== 1 ? t('commitMenu.aiExplainSingle') : ''
      },
      {
        action: 'create-tag',
        icon: 'ph-tag',
        label: t('commitMenu.createTag'),
        disabled: this.hashes.length !== 1,
        reason: this.hashes.length !== 1 ? t('commitMenu.createTagSingle') : ''
      },
      {
        action: 'delete-tag',
        icon: 'ph-tag-simple',
        label: t('commitMenu.deleteTag'),
        disabled: this.hashes.length !== 1,
        reason: this.hashes.length !== 1 ? t('commitMenu.deleteTagSingle') : ''
      },
      {
        action: 'restore-file',
        icon: 'ph-arrow-counter-clockwise',
        label: t('commitMenu.checkoutFile'),
        disabled: this.hashes.length !== 1,
        reason: this.hashes.length !== 1 ? t('commitMenu.checkoutFileSingle') : ''
      },
      {
        action: 'rebase',
        icon: 'ph-git-branch',
        label: t('commitMenu.rebase'),
        disabled: rebaseLoading || this.hashes.length !== 1 || rebase?.allowed !== true,
        reason: this.hashes.length !== 1
          ? t('commitMenu.singleRebase')
          : (rebase?.reason || (rebaseLoading ? t('common.loading') : ''))
      },
      {
        action: 'cherry-pick',
        icon: 'ph-copy',
        label: t('commitMenu.cherryPick', { count: this.hashes.length }),
        disabled: cherryPickLoading || cherryPick?.allowed !== true,
        reason: cherryPick?.reason || (cherryPickLoading ? t('common.loading') : '')
      }
    ];
    this.element.innerHTML = actions.map(item => `
      <div class="branch-menu-item" role="menuitem" tabindex="-1"
        data-action="${item.action}"
        ${item.disabled ? 'aria-disabled="true"' : ''}
        ${item.reason ? `title="${this.esc(item.reason)}"` : ''}>
        <i class="ph ${item.icon}" aria-hidden="true"></i>
        <span>${this.esc(item.label)}</span>
      </div>
    `).join('');
    this.element.querySelectorAll<HTMLElement>('[data-action]:not([aria-disabled="true"])').forEach(item => {
      item.onclick = event => {
        event.stopPropagation();
        this.execute((item as HTMLElement).dataset.action ?? '');
      };
    });
  }

  async execute(action: string): Promise<void> {
    const repo = this.app.state.repo;
    if (action === 'compare-commits') {
      if (!repo || this.hashes.length !== 2) return;
      this.close();
      this.app.components.commitCompare.open(this.hashes[0], this.hashes[1]);
      return;
    }
    if (action === 'explain-commit') {
      if (!repo || this.hashes.length !== 1) return;
      this.close();
      await this.explainCommitDialog(repo, this.hashes[0]);
      return;
    }
    if (action === 'create-tag') {
      if (!repo || this.hashes.length !== 1) return;
      this.close();
      await this.createTagDialog(repo, this.hashes[0]);
      return;
    }
    if (action === 'delete-tag') {
      if (!repo || this.hashes.length !== 1) return;
      this.close();
      await this.deleteTagDialog(repo, this.hashes[0]);
      return;
    }
    if (action === 'restore-file') {
      if (!repo || this.hashes.length !== 1) return;
      this.close();
      await this.restoreFileDialog(repo, this.hashes[0]);
      return;
    }
    const preview = this.previews[action];
    if (!repo || preview?.allowed !== true) return;
    const hashes = [...this.hashes];
    const repoPath = repo.path;
    this.close();
    if (!await this.previewDialog(preview)) return;
    const result = (action === 'rebase'
      ? await window.gitTree.rebaseOntoCommit(repoPath, hashes[0])
      : await window.gitTree.cherryPick(repoPath, hashes)) as { error?: string; conflictState?: { type?: string }; head?: string };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      if (result.conflictState?.type) {
        await this.app.components.conflict.open(result.conflictState);
      }
      return;
    }
    this.app.showToast(t('commitMenu.completed'), 'success');
    await this.app.refresh({ selectHash: result.head, silent: true });
  }

  async explainCommitDialog(repo: { path?: string }, hash: string): Promise<unknown> {
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    const language = await this.aiLanguage().catch(() => 'en');
    return new Promise(resolve => {
      dialog.className = 'confirm-dialog ai-explain-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = `
        <div class="ai-explain-loading">
          <i class="ph ph-circle-notch" aria-hidden="true"></i>
          <span>${this.esc(t('commitMenu.aiExplaining'))}</span>
        </div>`;
      overlay.classList.remove('is-hidden');
      let settled = false;
      const finish = (value: null) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown);
        overlay.classList.add('is-hidden');
        dialog.className = 'confirm-dialog';
        dialog.removeAttribute('role');
        dialog.removeAttribute('aria-modal');
        dialog.innerHTML = '';
        resolve(value);
      };
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') finish(null);
      };
      document.addEventListener('keydown', onKeydown);
      window.gitTree.explainCommit(repo.path, {
        hash,
        language
      }).then((rawResult: unknown) => {
        const result = rawResult as { error?: string; summary?: string; body?: string } | undefined;
        if (result?.error) {
          finish(null);
          this.app.showToast(result.error, 'error');
          return;
        }
        dialog.innerHTML = `
          <div class="ai-explain-result">
            <span class="eyebrow">${this.esc(hash.slice(0, 8))}</span>
            <h3>${this.esc(result?.summary ?? '')}</h3>
            <div class="ai-explain-body">${this.esc(result?.body ?? '')}</div>
            <div class="confirm-actions">
              <button class="btn btn-primary" type="button" data-close>${this.esc(t('common.cancel'))}</button>
            </div>
          </div>`;
        dialog.querySelector<HTMLElement>('[data-close]')!.onclick = () => finish(null);
      }).catch((error: Error) => {
        finish(null);
        this.app.showToast(error?.message || t('common.error'), 'error');
      });
    });
  }

  async aiLanguage(): Promise<string> {
    const settings = await window.gitTree.getAiSettings().then(
      (value): { language?: string } | null => (value ?? null) as { language?: string } | null,
      (): null => null
    );
    if (settings?.language === 'en' || settings?.language === 'it') {
      return settings.language;
    }
    const current = localStorage.getItem('gittree.language') || 'en';
    return current.startsWith('it') ? 'it' : 'en';
  }

  createTagDialog(repo: { path?: string }, hash: string): Promise<unknown> {
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    return new Promise(resolve => {
      dialog.className = 'confirm-dialog tag-create-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'tag-create-title');
      dialog.innerHTML = `
        <form class="tag-create-form">
          <span class="eyebrow">${this.esc(hash.slice(0, 8))}</span>
          <h3 id="tag-create-title">${this.esc(t('commitMenu.createTagTitle'))}</h3>
          <label>
            <span>${this.esc(t('commitMenu.tagName'))}</span>
            <input name="name" maxlength="255" required autofocus
              placeholder="${this.esc(t('commitMenu.tagNamePlaceholder'))}">
          </label>
          <label>
            <span>${this.esc(t('commitMenu.tagMessage'))}</span>
            <textarea name="message" maxlength="10000" rows="4"
              placeholder="${this.esc(t('commitMenu.tagMessagePlaceholder'))}"></textarea>
          </label>
          <p class="tag-create-error" data-tag-error aria-live="polite"></p>
          <div class="confirm-actions">
            <button class="btn" type="button" data-cancel>${this.esc(t('common.cancel'))}</button>
            <button class="btn btn-primary" type="submit" data-create>
              <i class="ph ph-tag" aria-hidden="true"></i>
              ${this.esc(t('commitMenu.createTagTitle'))}
            </button>
          </div>
        </form>`;
      overlay.classList.remove('is-hidden');
      const form = dialog.querySelector('form')! as HTMLFormElement;
      const error = dialog.querySelector<HTMLElement>('[data-tag-error]')!;
      const create = dialog.querySelector<HTMLButtonElement>('[data-create]')!;
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!;
      let submitting = false;
      const finish = (value: unknown) => {
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
        if (event.key === 'Escape' && !submitting) finish(null);
      };
      const onOverlayClick = (event: MouseEvent) => {
        if (event.target === overlay && !submitting) finish(null);
      };
      cancel.onclick = () => {
        if (!submitting) finish(null);
      };
      form.onsubmit = async event => {
        event.preventDefault();
        submitting = true;
        create.disabled = true;
        cancel.disabled = true;
        (form.elements as unknown as Record<string, HTMLInputElement>).name.disabled = true;
        (form.elements as unknown as Record<string, HTMLTextAreaElement>).message.disabled = true;
        create.querySelector('i')!.className = 'ph ph-circle-notch';
        error.textContent = '';
        try {
          const result = await window.gitTree.createTag(
            repo.path,
            (form.elements as unknown as Record<string, HTMLInputElement>).name.value.trim(),
            hash,
            (form.elements as unknown as Record<string, HTMLTextAreaElement>).message.value
          ) as { success?: boolean; error?: string; name?: string };
          if (!result?.success || result?.error) {
            throw new Error(result?.error || t('commitMenu.tagCreateFailed'));
          }
          finish(result);
          this.app.showToast(t('commitMenu.tagCreated', { tag: result.name }), 'success');
          await this.app.refresh({ selectHash: hash, silent: true });
        } catch (tagError) {
          submitting = false;
          create.disabled = false;
          cancel.disabled = false;
          (form.elements as unknown as Record<string, HTMLInputElement>).name.disabled = false;
          (form.elements as unknown as Record<string, HTMLTextAreaElement>).message.disabled = false;
          create.querySelector('i')!.className = 'ph ph-tag';
          error.textContent = (tagError as Error).message || t('commitMenu.tagCreateFailed');
          (form.elements as unknown as Record<string, HTMLInputElement>).name.focus();
        }
      };
      document.addEventListener('keydown', onKeydown);
      overlay.addEventListener('click', onOverlayClick);
      (form.elements as unknown as Record<string, HTMLInputElement>).name.focus();
    });
  }

  async deleteTagDialog(repo: { path?: string }, hash: string): Promise<unknown> {
    const tagsResult = await window.gitTree.getTagsAtCommit(repo.path, hash) as unknown;
    const tags = Array.isArray(tagsResult) ? tagsResult as string[] : [];
    if ((tagsResult as { error?: string })?.error || !tags.length) {
      this.app.showToast((tagsResult as { error?: string })?.error || t('commitMenu.noTagsAtCommit'), 'warning');
      return undefined;
    }
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    return new Promise(resolve => {
      dialog.className = 'confirm-dialog tag-delete-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = `
        <span class="eyebrow">${this.esc(hash.slice(0, 8))}</span>
        <h3>${this.esc(t('commitMenu.deleteTagTitle'))}</h3>
        <div class="tag-delete-list">
          ${tags.map(tag => `
            <label class="tag-delete-item">
              <input type="checkbox" value="${this.esc(tag)}">
              <i class="ph ph-tag" aria-hidden="true"></i>
              <span>${this.esc(tag)}</span>
            </label>
          `).join('')}
        </div>
        <p class="tag-create-error" data-tag-error aria-live="polite"></p>
        <div class="confirm-actions">
          <button class="btn" type="button" data-cancel>${this.esc(t('common.cancel'))}</button>
          <button class="btn btn-danger" type="button" data-delete disabled>
            <i class="ph ph-trash" aria-hidden="true"></i>
            ${this.esc(t('commitMenu.deleteTagAction'))}
          </button>
        </div>`;
      overlay.classList.remove('is-hidden');
      const error = dialog.querySelector<HTMLElement>('[data-tag-error]')!;
      const del = dialog.querySelector<HTMLButtonElement>('[data-delete]')!;
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!;
      const checkboxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      const sync = () => {
        del.disabled = !checkboxes.some(checkbox => checkbox.checked);
      };
      checkboxes.forEach(checkbox => {
        checkbox.onchange = sync;
      });
      let submitting = false;
      const finish = (value: unknown) => {
        document.removeEventListener('keydown', onKeydown);
        overlay.removeEventListener('click', onOverlayClick);
        overlay.classList.add('is-hidden');
        dialog.className = 'confirm-dialog';
        dialog.removeAttribute('role');
        dialog.removeAttribute('aria-modal');
        dialog.innerHTML = '';
        resolve(value);
      };
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !submitting) finish(null);
      };
      const onOverlayClick = (event: MouseEvent) => {
        if (event.target === overlay && !submitting) finish(null);
      };
      cancel.onclick = () => {
        if (!submitting) finish(null);
      };
      del.onclick = async () => {
        const selected = checkboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
        if (!selected.length || submitting) return;
        submitting = true;
        del.disabled = true;
        cancel.disabled = true;
        del.querySelector('i')!.className = 'ph ph-circle-notch';
        error.textContent = '';
        try {
          for (const tag of selected) {
            const result = await window.gitTree.deleteTag(repo.path, tag) as { success?: boolean; error?: string };
            if (!result?.success || result?.error) {
              throw new Error(result?.error || t('commitMenu.tagDeleteFailed'));
            }
          }
          finish(true);
          this.app.showToast(
            t('commitMenu.tagsDeleted', { count: selected.length }),
            'success'
          );
          await this.app.refresh({ selectHash: hash, silent: true });
        } catch (tagError) {
          submitting = false;
          del.disabled = false;
          cancel.disabled = false;
          del.querySelector('i')!.className = 'ph ph-trash';
          error.textContent = (tagError as Error).message || t('commitMenu.tagDeleteFailed');
        }
      };
      document.addEventListener('keydown', onKeydown);
      overlay.addEventListener('click', onOverlayClick);
      checkboxes[0]?.focus();
    });
  }

  async restoreFileDialog(repo: { path?: string }, hash: string): Promise<unknown> {
    const treeResult = await window.gitTree.getFileTree(repo.path, hash) as unknown;
    const files = Array.isArray(treeResult) ? treeResult as string[] : [];
    if ((treeResult as { error?: string })?.error || !files.length) {
      this.app.showToast((treeResult as { error?: string })?.error || t('commitMenu.noFilesAtCommit'), 'warning');
      return undefined;
    }
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    return new Promise(resolve => {
      dialog.className = 'confirm-dialog checkout-file-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = `
        <span class="eyebrow">${this.esc(hash.slice(0, 8))}</span>
        <h3>${this.esc(t('commitMenu.checkoutFileTitle'))}</h3>
        <p class="checkout-file-help">${this.esc(t('commitMenu.checkoutFileHelp'))}</p>
        <label class="checkout-file-search search-clearable">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input type="search" placeholder="${this.esc(t('commitMenu.checkoutFileFilter'))}" aria-label="${this.esc(t('commitMenu.checkoutFileFilter'))}">
        </label>
        <div class="tag-delete-list checkout-file-list" data-file-list></div>
        <p class="tag-create-error" data-file-error aria-live="polite"></p>
        <div class="confirm-actions">
          <button class="btn" type="button" data-cancel>${this.esc(t('common.cancel'))}</button>
          <button class="btn btn-primary" type="button" data-restore disabled>
            <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
            ${this.esc(t('commitMenu.checkoutFileAction'))}
          </button>
        </div>`;
      overlay.classList.remove('is-hidden');
      const list = dialog.querySelector<HTMLElement>('[data-file-list]')!;
      const error = dialog.querySelector<HTMLElement>('[data-file-error]')!;
      const restoreButton = dialog.querySelector<HTMLButtonElement>('[data-restore]')!;
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!;
      const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
      let selectedPath: string | null = null;
      let submitting = false;

      const renderList = () => {
        const needle = (search.value || '').trim().toLowerCase();
        const visible = files
          .filter(file => !needle || file.toLowerCase().includes(needle))
          .slice(0, 500);
        list.innerHTML = visible.map(file => `
          <label class="tag-delete-item checkout-file-item${file === selectedPath ? ' is-selected' : ''}" data-file="${this.esc(file)}">
            <i class="ph ph-file-code" aria-hidden="true"></i>
            <span>${this.esc(file)}</span>
          </label>
        `).join('') || `<div class="settings-empty">${this.esc(t('commitMenu.noFilesMatch'))}</div>`;
        list.querySelectorAll<HTMLElement>('[data-file]').forEach(item => {
          item.onclick = () => {
            selectedPath = (item as HTMLElement).dataset.file ?? null;
            list.querySelectorAll('[data-file]').forEach(other => {
              other.classList.toggle('is-selected', other === item);
            });
            restoreButton.disabled = false;
          };
        });
      };
      search.oninput = renderList;
      renderList();

      const finish = (value: unknown) => {
        document.removeEventListener('keydown', onKeydown);
        overlay.removeEventListener('click', onOverlayClick);
        overlay.classList.add('is-hidden');
        dialog.className = 'confirm-dialog';
        dialog.removeAttribute('role');
        dialog.removeAttribute('aria-modal');
        dialog.innerHTML = '';
        resolve(value);
      };
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !submitting) finish(null);
      };
      const onOverlayClick = (event: MouseEvent) => {
        if (event.target === overlay && !submitting) finish(null);
      };
      cancel.onclick = () => {
        if (!submitting) finish(null);
      };
      restoreButton.onclick = async () => {
        if (!selectedPath || submitting) return;
        submitting = true;
        restoreButton.disabled = true;
        cancel.disabled = true;
        restoreButton.querySelector('i')!.className = 'ph ph-circle-notch';
        error.textContent = '';
        try {
          const result = await window.gitTree.restoreFileFromCommit(
            repo.path,
            hash,
            selectedPath
          ) as { success?: boolean; error?: string };
          if (!result?.success || result?.error) {
            throw new Error(result?.error || t('commitMenu.checkoutFileFailed'));
          }
          finish(true);
          this.app.showToast(t('commitMenu.fileRestored'), 'success');
          await this.app.refresh({ selectHash: hash, silent: true });
        } catch (restoreError) {
          submitting = false;
          restoreButton.disabled = false;
          cancel.disabled = false;
          restoreButton.querySelector('i')!.className = 'ph ph-arrow-counter-clockwise';
          error.textContent = (restoreError as Error).message || t('commitMenu.checkoutFileFailed');
        }
      };
      document.addEventListener('keydown', onKeydown);
      overlay.addEventListener('click', onOverlayClick);
      search.focus();
    });
  }

  previewDialog(preview: CommitPreview): Promise<boolean> {
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    return new Promise(resolve => {
      const commits = preview.commits || [];
      const files = preview.files || [];
      dialog.innerHTML = `
        <div class="commit-action-preview">
          <span class="eyebrow">${this.esc(t('commitMenu.previewEyebrow'))}</span>
          <h3>${this.esc(t(
            preview.action === 'rebase' ? 'commitMenu.rebaseTitle' : 'commitMenu.cherryPickTitle'
          ))}</h3>
          <div class="commit-preview-status ${preview.allowed ? 'allowed' : 'blocked'}">
            <i class="ph ${preview.allowed ? 'ph-check-circle' : 'ph-warning-circle'}"></i>
            <span>${this.esc(preview.allowed ? t('commitMenu.ready') : (preview.reason ?? ''))}</span>
          </div>
          <dl class="commit-preview-facts">
            <div><dt>${this.esc(t('commitMenu.target'))}</dt><dd><code>${this.esc((preview.target || '').slice(0, 12))}</code></dd></div>
            <div><dt>${this.esc(t('commitMenu.commits'))}</dt><dd>${commits.length}</dd></div>
            <div><dt>${this.esc(t('commitMenu.files'))}</dt><dd>${files.length}</dd></div>
            <div><dt>${this.esc(t('commitMenu.workingTree'))}</dt><dd>${this.esc(preview.workingTree?.clean ? t('commitMenu.clean') : t('commitMenu.dirty'))}</dd></div>
          </dl>
          <div class="commit-preview-scroll">
            ${commits.map(commit => `<div class="commit-preview-row">
              <code>${this.esc(commit.hash.slice(0, 8))}</code>
              <span>${this.esc(commit.subject)}</span>
            </div>`).join('')}
            ${files.slice(0, 100).map(file => `<div class="commit-preview-file">
              <i class="ph ph-file"></i><span>${this.esc(file)}</span>
            </div>`).join('')}
          </div>
          <div class="confirm-actions">
            <button class="btn" type="button" data-cancel>${this.esc(t('common.cancel'))}</button>
            <button class="btn btn-primary" type="button" data-confirm ${preview.allowed ? '' : 'disabled'}>
              ${this.esc(t('common.continue'))}
            </button>
          </div>
        </div>`;
      overlay.classList.remove('is-hidden');
      const finish = (value: boolean) => {
        overlay.classList.add('is-hidden');
        dialog.innerHTML = '';
        resolve(value);
      };
      dialog.querySelector<HTMLElement>('[data-cancel]')!.onclick = () => finish(false);
      dialog.querySelector<HTMLElement>('[data-confirm]')!.onclick = () => finish(true);
      dialog.querySelector<HTMLElement>(preview.allowed ? '[data-confirm]' : '[data-cancel]')?.focus();
    });
  }

  close(): void {
    if (this.element.classList.contains('is-hidden')) return;
    this.generation += 1;
    this.element.classList.add('is-hidden');
    this.element.innerHTML = '';
  }

  place(x: number, y: number): void {
    const margin = 8;
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
    const rect = this.element.getBoundingClientRect();
    this.element.style.left = `${Math.max(
      margin,
      Math.min(x, window.innerWidth - rect.width - margin)
    )}px`;
    this.element.style.top = `${Math.max(
      margin,
      Math.min(y, window.innerHeight - rect.height - margin)
    )}px`;
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
    const items = [...this.element.querySelectorAll<HTMLElement>(
      '.branch-menu-item:not([aria-disabled="true"])'
    )];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length].focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    }
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { CommitContextMenu: typeof CommitContextMenu }).CommitContextMenu = CommitContextMenu;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = CommitContextMenu;
}

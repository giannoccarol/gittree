

type GitFlowMode = 'start' | 'finish';
type GitFlowType = 'feature' | 'release' | 'hotfix';

import type { GitTreeApp } from '../app.mts';

export class GitFlow {
  app: GitTreeApp;
  overlay: HTMLElement;
  dialog: HTMLElement;
  mode: GitFlowMode;
  type: GitFlowType;
  localBranches: string[];
  currentBranch: string;
  finishTarget: string | null;
  handedOff: boolean;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.overlay = document.getElementById('modal-overlay')! as HTMLElement;
    this.dialog = document.getElementById('modal-dialog')! as HTMLElement;
    this.mode = 'start';
    this.type = 'feature';
    this.localBranches = [];
    this.currentBranch = '';
    this.finishTarget = null;
    this.handedOff = false;
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.dialog.classList.contains('gitflow-dialog')) {
        event.preventDefault();
        this.close();
      }
    });
  }

  async open(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) {
      this.app.showToast(t('gitflow.openRepositoryFirst'), 'error');
      return;
    }
    const alreadyOpen = !this.overlay.classList.contains('is-hidden')
      && this.dialog.classList.contains('gitflow-dialog');
    if (!alreadyOpen) {
      this.dialog.className = 'confirm-dialog gitflow-dialog';
      this.dialog.innerHTML = `
        <div class="modal-loading">
          <i class="ph ph-circle-notch" aria-hidden="true"></i>
          <span>${this.esc(t('common.loading'))}</span>
        </div>`;
      this.overlay.classList.remove('is-hidden');
    }
    try {
      const [metadata, status] = await Promise.all([
        window.gitTree.getBranchMetadata(repo.path),
        window.gitTree.getStatus(repo.path)
      ]) as [
        { branches?: Array<{ kind?: unknown; name?: unknown }> } | undefined,
        { current?: string } | undefined
      ];
      this.localBranches = (metadata?.branches || [])
        .filter(branch => branch.kind === 'local')
        .map(branch => branch.name as string);
      this.currentBranch = status?.current || '';
      this.mode = 'start';
      this.type = 'feature';
      this.finishTarget = null;
      this.render();
      this.overlay.classList.remove('is-hidden');
      this.dialog.querySelector<HTMLElement>('#gitflow-description')?.focus();
    } catch (error) {
      if (this.dialog.classList.contains('gitflow-dialog')) this.close();
      this.app.showToast((error as Error)?.message || t('common.error'), 'error');
    }
  }

  close(): void {
    this.overlay.classList.add('is-hidden');
    this.overlay.onclick = null;
    this.dialog.className = 'confirm-dialog';
    this.dialog.innerHTML = '';
  }

  gitflowBranches(): string[] {
    return this.localBranches.filter(name => this.branchType(name));
  }

  branchType(name: string): GitFlowType | null {
    if (name.startsWith('feature/')) return 'feature';
    if (name.startsWith('release/')) return 'release';
    if (name.startsWith('hotfix/')) return 'hotfix';
    return null;
  }

  productionBranch(names: string[]): string {
    if (names.includes('main')) return 'main';
    if (names.includes('master')) return 'master';
    return this.currentBranch || names[0] || '';
  }

  integrationBranch(names: string[]): string {
    if (names.includes('develop')) return 'develop';
    return this.productionBranch(names);
  }

  baseForType(type: GitFlowType): string {
    return type === 'hotfix'
      ? this.productionBranch(this.localBranches)
      : this.integrationBranch(this.localBranches);
  }

  previewName(): string {
    const input = this.dialog.querySelector('#gitflow-description') as HTMLInputElement | null;
    const slug = BranchNaming.slugify(input?.value || '');
    return slug ? `${this.type}/${slug}` : '';
  }

  versionFromBranch(name: string): string {
    let suffix = name.split('/').slice(1).join('-') || 'release';
    if (suffix.startsWith('v')) suffix = suffix.slice(1);
    return suffix;
  }

  render(): void {
    const branches = this.gitflowBranches();
    this.dialog.className = 'confirm-dialog gitflow-dialog';
    this.dialog.innerHTML = `
      <div class="settings-header">
        <div>
          <span class="eyebrow">${this.esc(t('gitflow.eyebrow'))}</span>
          <h2>${this.esc(t('gitflow.title'))}</h2>
        </div>
        <button class="btn-icon" type="button" data-gitflow-close
          title="${this.esc(t('common.close'))}" aria-label="${this.esc(t('common.close'))}">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="settings-scroll">
        <div class="segmented-control gitflow-tabs" role="tablist">
          <button type="button" class="btn btn-small${this.mode === 'start' ? ' active' : ''}"
            data-gitflow-mode="start">${this.esc(t('gitflow.startTab'))}</button>
          <button type="button" class="btn btn-small${this.mode === 'finish' ? ' active' : ''}"
            data-gitflow-mode="finish">${this.esc(t('gitflow.finishTab'))}</button>
        </div>

        <section class="settings-section gitflow-panel" data-gitflow-panel="start"
          ${this.mode === 'start' ? '' : 'hidden'}>
          <div class="settings-section-heading">
            <i class="ph ph-git-branch" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('gitflow.startTab'))}</h3>
              <p>${this.esc(t('gitflow.startHelp'))}</p>
            </div>
          </div>
          <div class="gitflow-types" role="group">
            ${(['feature', 'release', 'hotfix'] as const).map(type => `
              <button type="button" class="gitflow-type${type === this.type ? ' selected' : ''}"
                data-gitflow-type="${type}">
                <i class="ph ${this.typeIcon(type)}" aria-hidden="true"></i>
                <span>${this.esc(t(`gitflow.type_${type}`))}</span>
                <small>${this.esc(this.baseForType(type))}</small>
              </button>`).join('')}
          </div>
          <label class="gitflow-field">
            <span>${this.esc(t('gitflow.descriptionLabel'))}</span>
            <input type="text" id="gitflow-description" maxlength="120"
              placeholder="${this.esc(t('gitflow.descriptionPlaceholder'))}">
          </label>
          <div class="gitflow-preview">
            <span class="gitflow-preview-label">${this.esc(t('gitflow.preview'))}</span>
            <code id="gitflow-preview-name">—</code>
          </div>
          <div class="gitflow-actions">
            <button type="button" class="btn btn-primary" id="gitflow-start" disabled>
              <i class="ph ph-plus" aria-hidden="true"></i>
              ${this.esc(t('gitflow.startButton'))}
            </button>
          </div>
        </section>

        <section class="settings-section gitflow-panel" data-gitflow-panel="finish"
          ${this.mode === 'finish' ? '' : 'hidden'}>
          <div class="settings-section-heading">
            <i class="ph ph-git-merge" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('gitflow.finishTab'))}</h3>
              <p>${this.esc(t('gitflow.finishHelp'))}</p>
            </div>
          </div>
          <div class="gitflow-branch-list">
            ${branches.length ? branches.map(name => `
              <button type="button" class="gitflow-branch" data-gitflow-branch="${this.esc(name)}">
                <span class="badge ${this.typeBadge(this.branchType(name))}">
                  ${this.esc(this.branchType(name))}
                </span>
                <span class="gitflow-branch-name">${this.esc(name)}</span>
              </button>`).join('')
              : `<div class="settings-empty">${this.esc(t('gitflow.noBranches'))}</div>`}
          </div>
          <div class="gitflow-actions">
            <button type="button" class="btn btn-primary" id="gitflow-finish" disabled>
              <i class="ph ph-git-merge" aria-hidden="true"></i>
              ${this.esc(t('gitflow.finishButton'))}
            </button>
          </div>
        </section>
      </div>
    `;
    this.bind();
  }

  typeIcon(type: string): string {
    return ({ feature: 'ph-lightbulb', release: 'ph-package', hotfix: 'ph-first-aid' } as Record<string, string>)[type] || 'ph-git-branch';
  }

  typeBadge(type: string | null): string {
    return ({ feature: 'badge-branch', release: 'badge-tag', hotfix: 'badge-conflict' } as Record<string, string>)[type ?? ''] || 'badge-branch';
  }

  bind(): void {
    const closeButton = this.dialog.querySelector('[data-gitflow-close]') as HTMLElement | null;
    if (closeButton) closeButton.onclick = () => this.close();
    this.overlay.onclick = event => {
      if (event.target === this.overlay) this.close();
    };

    this.dialog.querySelectorAll<HTMLElement>('[data-gitflow-mode]').forEach(button => {
      button.onclick = () => {
        this.mode = button.dataset.gitflowMode as GitFlowMode;
        this.render();
      };
    });

    if (this.mode === 'start') this.bindStart();
    else this.bindFinish();
  }

  bindStart(): void {
    const description = this.dialog.querySelector('#gitflow-description') as HTMLInputElement | null;
    const preview = this.dialog.querySelector('#gitflow-preview-name') as HTMLElement | null;
    const startButton = this.dialog.querySelector('#gitflow-start') as HTMLButtonElement | null;

    const updatePreview = () => {
      const name = this.previewName();
      if (preview) preview.textContent = name || '—';
      if (startButton) startButton.disabled = !name;
    };

    if (description) description.oninput = updatePreview;
    this.dialog.querySelectorAll<HTMLElement>('[data-gitflow-type]').forEach(button => {
      button.onclick = () => {
        this.type = button.dataset.gitflowType as GitFlowType;
        this.dialog.querySelectorAll<HTMLElement>('[data-gitflow-type]').forEach(other => {
          other.classList.toggle('selected', other === button);
        });
        updatePreview();
      };
    });
    if (startButton) startButton.onclick = () => this.startBranch();
    updatePreview();
  }

  bindFinish(): void {
    const finishButton = this.dialog.querySelector('#gitflow-finish') as HTMLButtonElement | null;
    this.dialog.querySelectorAll<HTMLElement>('[data-gitflow-branch]').forEach(button => {
      button.onclick = () => {
        this.finishTarget = button.dataset.gitflowBranch ?? null;
        this.dialog.querySelectorAll<HTMLElement>('[data-gitflow-branch]').forEach(other => {
          other.classList.toggle('selected', other === button);
        });
        if (finishButton) finishButton.disabled = false;
      };
    });
    if (finishButton) finishButton.onclick = () => {
      if (this.finishTarget) this.finishBranch(this.finishTarget);
    };
  }

  setBusy(busy: boolean): void {
    this.dialog.querySelectorAll<HTMLButtonElement>('#gitflow-start, #gitflow-finish').forEach(button => {
      button.disabled = busy;
    });
  }

  async startBranch(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    const name = this.previewName();
    if (!name) {
      this.app.showToast(t('gitflow.invalidDescription'), 'error');
      return;
    }
    const base = this.baseForType(this.type);
    this.setBusy(true);
    const result = await window.gitTree.createBranch(repo.path, name, base) as { error?: string } | undefined;
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      this.setBusy(false);
      return;
    }
    this.app.showToast(t('gitflow.started', { branch: name }), 'success');
    this.close();
    this.app.emit('refresh');
  }

  async checkoutAndMerge(target: string, source: string): Promise<void> {
    const repo = this.app.state.repo;
    const checkout = await window.gitTree.checkoutBranch(repo!.path, target) as { error?: string } | undefined;
    if (checkout?.error) throw new Error(checkout.error);
    const merge = await window.gitTree.merge(repo!.path, source, 'noff') as { error?: string; conflictState?: { type?: string } } | undefined;
    if (merge?.error) {
      if (merge.conflictState?.type) {
        this.handedOff = true;
        this.close();
        await this.app.components.conflict.open(merge.conflictState);
      }
      throw new Error(merge.error);
    }
  }

  async tagHead(name: string, message: string): Promise<void> {
    const repo = this.app.state.repo;
    const log = await window.gitTree.getLog(repo!.path, 1) as { latest?: { hash?: string } } | undefined;
    const hash = log?.latest?.hash;
    if (!hash) throw new Error('Could not resolve HEAD for tagging');
    const tag = await window.gitTree.createTag(repo!.path, name, hash, message) as { error?: string } | undefined;
    if (tag?.error) throw new Error(tag.error);
  }

  async finishBranch(branchName: string): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    const type = this.branchType(branchName);
    const names = this.localBranches;
    const integration = this.integrationBranch(names);
    const production = this.productionBranch(names);
    const version = this.versionFromBranch(branchName);

    this.setBusy(true);
    this.handedOff = false;
    try {
      if (type === 'feature') {
        await this.checkoutAndMerge(integration, branchName);
      } else if (type === 'release') {
        await this.checkoutAndMerge(integration, branchName);
        if (production !== integration) await this.checkoutAndMerge(production, branchName);
        await this.tagHead(`v${version}`, branchName);
      } else if (type === 'hotfix') {
        await this.checkoutAndMerge(production, branchName);
        await this.tagHead(`v${version}`, branchName);
        if (integration !== production) await this.checkoutAndMerge(integration, branchName);
      }
      const del = await window.gitTree.deleteBranch(repo.path, branchName, false) as { error?: string } | undefined;
      if (del?.error) throw new Error(del.error);
      this.app.showToast(t('gitflow.finished', { branch: branchName }), 'success');
      this.close();
      this.app.emit('refresh');
    } catch (err) {
      if (!this.handedOff) {
        this.app.showToast((err as Error).message || String(err), 'error');
        this.setBusy(false);
      }
      this.app.emit('refresh');
    }
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { GitFlow: typeof GitFlow }).GitFlow = GitFlow;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = GitFlow;
}

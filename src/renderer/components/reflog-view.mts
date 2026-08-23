import type { GitTreeApp } from '../app.mts';

interface ReflogEntry {
  hash: string;
  ref: string;
  message: string;
  date?: string;
}


export class ReflogView {
  app: GitTreeApp;
  container: HTMLElement;
  entries: ReflogEntry[];

  constructor(app: GitTreeApp) {
    this.app = app;
    this.container = document.getElementById('merge-workspace-overlay')! as HTMLElement;
    this.entries = [];
  }

  async open(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    this.showLoading();
    try {
      const result = await window.gitTree.getReflog(repo.path) as { error?: string } | ReflogEntry[];
      if ((result as { error?: string })?.error) throw new Error((result as { error?: string }).error);
      this.entries = Array.isArray(result) ? result : [];
      this.render();
    } catch (error) {
      this.app.showToast((error as Error).message, 'error');
      this.hide();
    }
  }

  showLoading(): void {
    this.container!.classList.remove('is-hidden');
    this.container!.innerHTML = `<div class="empty-state">${this.esc(t('common.loading'))}</div>`;
  }

  render(): void {
    this.container!.innerHTML = `
      <div class="reflog-view">
        <header class="reflog-header">
          <div class="reflog-heading">
            <span class="eyebrow">${this.esc(t('reflog.eyebrow'))}</span>
            <h2>${this.esc(t('reflog.title'))}</h2>
          </div>
          <button class="btn" id="reflog-close" type="button">
            <i class="ph ph-x" aria-hidden="true"></i>
            <span>${this.esc(t('common.close'))}</span>
          </button>
        </header>
        <div class="reflog-body">
          ${this.entries.length
            ? this.entries.map((entry, index) => this.renderEntry(entry, index)).join('')
            : `<div class="empty-state">${this.esc(t('reflog.empty'))}</div>`}
        </div>
      </div>`;
    document.getElementById('reflog-close')!.onclick = () => this.hide();
    this.container!.querySelectorAll('[data-reflog-entry]').forEach(row => {
      row.querySelectorAll<HTMLElement>('[data-action]').forEach(button => {
        button.onclick = () => this.runAction(button.dataset.action ?? '', Number((row as HTMLElement).dataset.reflogEntry ?? ''));
      });
    });
  }

  renderEntry(entry: ReflogEntry, index: number): string {
    const date = entry.date ? new Date(entry.date).toLocaleString() : '';
    return `
      <div class="reflog-row" data-reflog-entry="${index}">
        <code class="reflog-hash">${this.esc(entry.hash.slice(0, 8))}</code>
        <span class="reflog-ref" title="${this.esc(entry.ref)}">${this.esc(entry.ref)}</span>
        <span class="reflog-message" title="${this.esc(entry.message)}">${this.esc(entry.message)}</span>
        <span class="reflog-date">${this.esc(date)}</span>
        <span class="reflog-actions">
          <button class="btn btn-small" type="button" data-action="branch" title="${this.esc(t('reflog.createBranch'))}" aria-label="${this.esc(t('reflog.createBranch'))}">
            <i class="ph ph-git-branch" aria-hidden="true"></i>
          </button>
          <button class="btn btn-small" type="button" data-action="copy" title="${this.esc(t('reflog.copyHash'))}" aria-label="${this.esc(t('reflog.copyHash'))}">
            <i class="ph ph-copy" aria-hidden="true"></i>
          </button>
        </span>
      </div>`;
  }

  async runAction(action: string, index: number): Promise<void> {
    const repo = this.app.state.repo;
    const entry = this.entries[index];
    if (!repo || !entry) return;
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(entry.hash);
        this.app.showToast(t('reflog.hashCopied'), 'success');
      } catch {
        this.app.showToast(t('reflog.copyFailed'), 'error');
      }
      return;
    }
    if (action === 'branch') {
      const name = await this.promptBranchName();
      if (!name) return;
      const result = await window.gitTree.createBranch(repo.path, name, entry.hash) as { error?: string };
      if (result?.error) {
        this.app.showToast(result.error, 'error');
        return;
      }
      this.hide();
      this.app.showToast(t('reflog.branchCreated', { branch: name }), 'success');
      this.app.emit('refresh');
    }
  }

  promptBranchName(): Promise<string | null> {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'repository-picker-overlay';
      overlay.innerHTML = `
        <section class="repository-picker" role="dialog" aria-modal="true">
          <header class="repository-picker-header">
            <div>
              <span class="eyebrow">${this.esc(t('reflog.createBranch'))}</span>
              <h2>${this.esc(t('reflog.createBranchTitle'))}</h2>
            </div>
          </header>
          <form class="clone-dialog-body remote-prompt-form">
            <label>
              <span>${this.esc(t('branchMenu.branchNameLabel'))}</span>
              <input class="clone-url-input" type="text" spellcheck="false" autocomplete="off" required autofocus>
            </label>
            <footer class="repository-picker-footer">
              <div>
                <button class="btn btn-secondary" type="button" data-action="cancel">${this.esc(t('common.cancel'))}</button>
                <button class="btn btn-primary" type="submit">${this.esc(t('reflog.createBranchAction'))}</button>
              </div>
            </footer>
          </form>
        </section>`;
      const finish = (value: string | null) => {
        overlay.remove();
        document.removeEventListener('keydown', keydown);
        resolve(value);
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') finish(null);
      };
      document.body.appendChild(overlay);
      overlay.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.target === overlay) finish(null);
      });
      overlay!.querySelector<HTMLElement>('[data-action="cancel"]')!.onclick = () => finish(null);
      overlay.querySelector('form')!.onsubmit = event => {
        event.preventDefault();
        const input = overlay.querySelector<HTMLInputElement>('input');
        const value = input!.value.trim();
        if (!value) return;
        finish(value);
      };
      document.addEventListener('keydown', keydown);
      overlay!.querySelector<HTMLInputElement>('input')!.focus();
    });
  }

  hide(): void {
    this.container!.classList.add('is-hidden');
    this.container!.innerHTML = '';
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { ReflogView: typeof ReflogView }).ReflogView = ReflogView;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ReflogView;
}

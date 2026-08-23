
import type { GitTreeApp } from '../app.mts';

interface ScannedRepository {
  name: string;
  path: string;
}

export class WelcomeScreen {
  screen: HTMLElement;
  recentList: HTMLElement;
  onboardingContainer: HTMLElement | null;
  steps: string[];
  storageKey: string;
  app: GitTreeApp | null;
  repositoryPicker: HTMLElement | null;
  repositoryPickerKeydown: ((event: KeyboardEvent) => void) | null;
  scanList: HTMLElement | null;
  scanRenderFrame: number | null;
  scanId: string | number | null;
  scanFinished: boolean;
  unsubscribeScanProgress: (() => void) | null;
  unsubscribeScanComplete: (() => void) | null;
  knownRepositoryPaths: Set<string>;
  scanRepositories: ScannedRepository[];
  scanSelection: Set<string>;
  scanQuery: string;

  constructor() {
    this.screen = document.getElementById('welcome-screen')! as HTMLElement;
    this.recentList = document.getElementById('recent-repos')! as HTMLElement;
    this.onboardingContainer = document.getElementById('welcome-onboarding')!;
    this.steps = ['open', 'branch', 'commit'];
    this.storageKey = 'gittree.onboarding';
    this.app = null;
    this.repositoryPicker = null;
    this.repositoryPickerKeydown = null;
    this.scanList = null;
    this.scanRenderFrame = null;
    this.scanId = null;
    this.scanFinished = false;
    this.unsubscribeScanProgress = null;
    this.unsubscribeScanComplete = null;
    this.knownRepositoryPaths = new Set();
    this.scanRepositories = [];
    this.scanSelection = new Set();
    this.scanQuery = '';
  }

  async init(app: GitTreeApp): Promise<void> {
    this.app = app;
    const openButton = document.getElementById('btn-open-repo')! as HTMLElement | null;
    if (openButton) openButton.onclick = () => this.openRepositoryPicker();
    const cloneButton = document.getElementById('btn-clone-repo')! as HTMLElement | null;
    if (cloneButton) cloneButton.onclick = () => this.cloneRepo();
    await this.loadRecent();
    this.renderOnboarding();
  }

  readProgress(): Record<string, boolean> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null');
      return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {};
    } catch {
      return {};
    }
  }

  markStep(step: string): void {
    if (!this.steps.includes(step)) return;
    const progress = this.readProgress();
    progress[step] = true;
    localStorage.setItem(this.storageKey, JSON.stringify(progress));
    this.renderOnboarding();
  }

  renderOnboarding(): void {
    if (!this.onboardingContainer) return;
    const progress = this.readProgress();
    const complete = this.steps.every(step => progress[step]);
    this.onboardingContainer.classList.toggle('is-hidden', complete);
    if (complete) return;
    this.onboardingContainer.innerHTML = `
      <div class="onboarding-card">
        <div class="onboarding-title">${this.esc(t('onboarding.title'))}</div>
        ${this.steps.map(step => `
          <div class="onboarding-step${progress[step] ? ' is-done' : ''}">
            <i class="ph ${progress[step] ? 'ph-check-circle' : 'ph-circle'}" aria-hidden="true"></i>
            <span>${this.esc(t(`onboarding.${step}`))}</span>
          </div>
        `).join('')}
      </div>`;
  }

  async openRepo(): Promise<void> {
    try {
      if (!window.gitTree) return;
      const dir = await window.gitTree.selectDirectory();
      if (!dir) return;
      const isRepo = await window.gitTree.checkIsGitRepo(dir);
      if (!isRepo) { this.app!.showToast(t('feedback.notRepo'), 'error'); return; }
      await this.app!.components.repoTabs!.addRepo(dir as string);
    } catch (e) { this.app!.showToast('Error: ' + (e as Error).message, 'error'); }
  }

  openRepositoryPicker(): void {
    this.closeRepositoryPicker();
    const overlay = document.createElement('div');
    overlay.className = 'repository-picker-overlay';
    overlay.innerHTML = `
      <section class="repository-picker" role="dialog" aria-modal="true" aria-labelledby="repository-picker-title">
        <header class="repository-picker-header">
          <div>
            <span class="eyebrow">${t('discovery.eyebrow')}</span>
            <h2 id="repository-picker-title">${t('discovery.title')}</h2>
          </div>
          <button class="icon-btn repository-picker-close" type="button" aria-label="${t('common.close')}">
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </header>
        <div class="repository-picker-options">
          <button class="repository-picker-option" type="button" data-mode="single">
            <i class="ph ph-folder-open" aria-hidden="true"></i>
            <span><strong>${t('discovery.single')}</strong><small>${t('discovery.singleHelp')}</small></span>
            <i class="ph ph-caret-right" aria-hidden="true"></i>
          </button>
          <button class="repository-picker-option" type="button" data-mode="clone">
            <i class="ph ph-download-simple" aria-hidden="true"></i>
            <span><strong>${t('discovery.clone')}</strong><small>${t('discovery.cloneHelp')}</small></span>
            <i class="ph ph-caret-right" aria-hidden="true"></i>
          </button>
          <button class="repository-picker-option" type="button" data-mode="scan">
            <i class="ph ph-folders" aria-hidden="true"></i>
            <span><strong>${t('discovery.scan')}</strong><small>${t('discovery.scanHelp')}</small></span>
            <i class="ph ph-caret-right" aria-hidden="true"></i>
          </button>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    this.repositoryPicker = overlay;
    overlay.querySelector<HTMLElement>('.repository-picker-close')!.onclick = () => this.closeRepositoryPicker();
    overlay.addEventListener('mousedown', (event: MouseEvent) => {
      if (event.target === overlay) this.closeRepositoryPicker();
    });
    overlay.querySelector<HTMLElement>('[data-mode="single"]')!.onclick = async () => {
      this.closeRepositoryPicker();
      await this.openRepo();
    };
    overlay.querySelector<HTMLElement>('[data-mode="clone"]')!.onclick = async () => {
      this.closeRepositoryPicker();
      await this.cloneRepo();
    };
    overlay.querySelector<HTMLElement>('[data-mode="scan"]')!.onclick = async () => {
      const rootPath = await window.gitTree.selectDirectory() as string | null;
      if (rootPath) await this.startRepositoryScan(rootPath);
    };
    this.repositoryPickerKeydown = event => {
      if (event.key === 'Escape') this.closeRepositoryPicker();
    };
    document.addEventListener('keydown', this.repositoryPickerKeydown);
    overlay.querySelector<HTMLElement>('[data-mode="single"]')!.focus();
  }

  async startRepositoryScan(rootPath: string): Promise<void> {
    if (!this.repositoryPicker) return;
    const repositories = await window.gitTree.getRepos() as Array<{ path?: string }> | undefined;
    this.knownRepositoryPaths = new Set(
      (repositories || []).map((repo: { path?: string }) => this.pathKey(String(repo.path ?? '')))
    );
    this.scanRepositories = [];
    this.scanSelection = new Set();
    this.scanQuery = '';
    this.scanFinished = false;
    const pickerEl = this.repositoryPicker!.querySelector('.repository-picker');
    if (!pickerEl) return;
    pickerEl.innerHTML = `
      <header class="repository-picker-header">
        <div>
          <span class="eyebrow">${t('discovery.scanningEyebrow')}</span>
          <h2>${t('discovery.results')}</h2>
          <p class="repository-picker-root"></p>
        </div>
        <button class="icon-btn repository-picker-close" type="button" aria-label="${t('common.close')}">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </header>
      <div class="repository-scan-toolbar">
        <label class="repository-scan-search search-clearable">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input type="search" placeholder="${t('discovery.search')}" aria-label="${t('discovery.search')}">
          <button type="button" class="search-clear-btn is-hidden" aria-label="${t('common.clearSearch')}">
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </label>
        <button class="btn btn-secondary btn-sm" type="button" data-action="all">${t('discovery.selectAll')}</button>
        <button class="btn btn-secondary btn-sm" type="button" data-action="none">${t('discovery.selectNone')}</button>
      </div>
      <div class="repository-scan-status" role="status">
        <span class="repository-scan-spinner"><i class="ph ph-spinner-gap" aria-hidden="true"></i></span>
        <span data-status>${t('discovery.scanning', { count: 0 })}</span>
      </div>
      <div class="repository-scan-list" role="listbox" aria-multiselectable="true">
        <div class="repository-scan-spacer"></div>
        <div class="repository-scan-rows"></div>
      </div>
      <footer class="repository-picker-footer">
        <span data-summary>${t('discovery.selected', { count: 0 })}</span>
        <div>
          <button class="btn btn-secondary" type="button" data-action="cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary" type="button" data-action="import" disabled>${t('discovery.import')}</button>
        </div>
      </footer>`;

    const picker = this.repositoryPicker;
    picker.querySelector<HTMLElement>('.repository-picker-root')!.textContent = rootPath;
    picker.querySelector<HTMLElement>('.repository-picker-close')!.onclick = () => this.closeRepositoryPicker();
    picker.querySelector<HTMLElement>('[data-action="cancel"]')!.onclick = () => this.closeRepositoryPicker();
    picker.querySelector<HTMLElement>('[data-action="all"]')!.onclick = () => {
      this.visibleScanRepositories().forEach(repo => {
        if (!this.knownRepositoryPaths.has(this.pathKey(repo.path))) {
          this.scanSelection.add(repo.path);
        }
      });
      this.renderRepositoryScan();
    };
    picker.querySelector<HTMLElement>('[data-action="none"]')!.onclick = () => {
      this.visibleScanRepositories().forEach(repo => this.scanSelection.delete(repo.path));
      this.renderRepositoryScan();
    };
    picker.querySelector<HTMLElement>('[data-action="import"]')!.onclick = () => this.importScannedRepositories();
    picker.querySelector<HTMLInputElement>('input[type="search"]')!.oninput = event => {
      this.scanQuery = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
      this.scanList!.scrollTop = 0;
      this.renderRepositoryScan();
    };
    this.app?.setupClearableSearches?.(picker);
    this.scanList = picker.querySelector('.repository-scan-list');
    this.scanList!.addEventListener('scroll', () => {
      if (this.scanRenderFrame) return;
      this.scanRenderFrame = requestAnimationFrame(() => {
        this.scanRenderFrame = null;
        this.renderRepositoryScan();
      });
    }, { passive: true });

    const scanUpdate = (payload: unknown) => {
      const update = payload as {
        scanId?: string | number;
        repository?: ScannedRepository;
        scannedDirectories?: number;
      };
      if (update.scanId !== this.scanId) return;
      if (update.repository) this.appendScannedRepository(update.repository);
      this.updateScanStatus(update.scannedDirectories);
    };
    const scanComplete = (payload: unknown) => {
      const result = payload as {
        scanId?: string | number;
        repositories?: ScannedRepository[];
        scannedDirectories?: number;
        error?: unknown;
        canceled?: boolean;
      };
      if (result.scanId !== this.scanId) return;
      this.scanFinished = true;
      for (const repository of result.repositories || []) this.appendScannedRepository(repository);
      this.updateScanStatus(result.scannedDirectories, result);
      this.renderRepositoryScan();
    };
    this.unsubscribeScanProgress = window.gitTree.onRepositoryScanProgress(scanUpdate);
    this.unsubscribeScanComplete = window.gitTree.onRepositoryScanComplete(scanComplete);
    const started = await window.gitTree.startRepositoryScan(rootPath) as { scanId: string | number };
    this.scanId = started.scanId;
  }

  appendScannedRepository(repository: ScannedRepository): void {
    if (this.scanRepositories.some(item => this.pathKey(item.path) === this.pathKey(repository.path))) return;
    this.scanRepositories.push(repository);
    if (!this.knownRepositoryPaths.has(this.pathKey(repository.path))) {
      this.scanSelection.add(repository.path);
    }
    this.renderRepositoryScan();
  }

  visibleScanRepositories(): ScannedRepository[] {
    if (!this.scanQuery) return this.scanRepositories;
    return this.scanRepositories.filter(repo => (
      repo.name.toLocaleLowerCase().includes(this.scanQuery) ||
      repo.path.toLocaleLowerCase().includes(this.scanQuery)
    ));
  }

  renderRepositoryScan(): void {
    if (!this.repositoryPicker || !this.scanList) return;
    const items = this.visibleScanRepositories();
    const rowHeight = 54;
    const overscan = 12;
    const viewportRows = Math.ceil(this.scanList!.clientHeight / rowHeight);
    const start = Math.max(0, Math.floor(this.scanList!.scrollTop / rowHeight) - overscan);
    const end = Math.min(items.length, start + viewportRows + overscan * 2);
    const spacer = this.scanList!.querySelector<HTMLElement>('.repository-scan-spacer')!;
    const rows = this.scanList!.querySelector<HTMLElement>('.repository-scan-rows')!;
    spacer.style.height = `${items.length * rowHeight}px`;
    rows.style.transform = `translateY(${start * rowHeight}px)`;
    rows.innerHTML = '';

    for (let index = start; index < end; index += 1) {
      const repository = items[index];
      const existing = this.knownRepositoryPaths.has(this.pathKey(repository.path));
      const row = document.createElement('label');
      row.className = `repository-scan-row${existing ? ' is-existing' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(this.scanSelection.has(repository.path)));
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = existing;
      checkbox.checked = !existing && this.scanSelection.has(repository.path);
      checkbox.onchange = () => {
        if (checkbox.checked) this.scanSelection.add(repository.path);
        else this.scanSelection.delete(repository.path);
        this.updateScanSummary();
      };
      const details = document.createElement('span');
      details.className = 'repository-scan-details';
      const name = document.createElement('strong');
      name.textContent = repository.name;
      const location = document.createElement('small');
      location.textContent = repository.path;
      details.append(name, location);
      row.append(checkbox, details);
      if (existing) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = t('discovery.alreadyAdded');
        row.appendChild(badge);
      }
      rows.appendChild(row);
    }
    this.updateScanSummary();
  }

  updateScanStatus(scannedDirectories: number | undefined, result?: { error?: unknown; canceled?: boolean }): void {
    if (!this.repositoryPicker) return;
    const status = this.repositoryPicker!.querySelector<HTMLElement>('[data-status]')!;
    const spinner = this.repositoryPicker!.querySelector<HTMLElement>('.repository-scan-spinner')!;
    if (result) {
      spinner.classList.add('is-hidden');
      status.textContent = result.error
        ? String(result.error)
        : result.canceled
          ? t('discovery.canceled')
          : t('discovery.complete', {
              repositories: this.scanRepositories.length,
              directories: scannedDirectories || 0
            });
    } else {
      status.textContent = t('discovery.scanning', { count: scannedDirectories || 0 });
    }
  }

  updateScanSummary(): void {
    if (!this.repositoryPicker) return;
    const count = this.scanSelection.size;
    this.repositoryPicker!.querySelector('[data-summary]')!.textContent = t('discovery.selected', { count });
    const btn = this.repositoryPicker!.querySelector('[data-action="import"]') as HTMLButtonElement;
    if (!btn) return;
    btn.disabled = count === 0;
  }

  async importScannedRepositories(): Promise<void> {
    const button = this.repositoryPicker?.querySelector('[data-action="import"]') as HTMLButtonElement | null;
    if (!button || button.disabled) return;
    button.disabled = true;
    const result = await this.app!.components.repoTabs!.addRepos([...this.scanSelection]);
    this.closeRepositoryPicker();
    await this.loadRecent();
    if (result?.failed?.length) {
      this.app!.showToast(t('discovery.partialFailure', { count: result.failed.length }), 'warning');
    } else {
      this.app!.showToast(t('discovery.imported', { count: result?.added?.length || 0 }), 'success');
    }
  }

  closeRepositoryPicker(): void {
    if (this.scanId && !this.scanFinished) window.gitTree.cancelRepositoryScan(this.scanId);
    if (this.unsubscribeScanProgress) this.unsubscribeScanProgress();
    if (this.unsubscribeScanComplete) this.unsubscribeScanComplete();
    if (this.repositoryPickerKeydown) {
      document.removeEventListener('keydown', this.repositoryPickerKeydown);
    }
    if (this.scanRenderFrame) cancelAnimationFrame(this.scanRenderFrame);
    this.repositoryPicker?.remove();
    this.repositoryPicker = null;
    this.scanList = null;
    this.scanId = null;
    this.unsubscribeScanProgress = null;
    this.unsubscribeScanComplete = null;
  }

  pathKey(value: string): string {
    return window.gitTree?.platform === 'win32' ? value.toLocaleLowerCase() : value;
  }

  async cloneRepo(): Promise<void> {
    const cloneUrl = await this.cloneDialog();
    if (!cloneUrl) return;
    const parentDirectory = await window.gitTree.selectDirectory();
    if (!parentDirectory) return;
    this.app!.showToast(t('feedback.cloning'), 'info');
    try {
      const result = await window.gitTree.cloneRepository(cloneUrl, parentDirectory) as { error?: string; path: string };
      if (result?.error) { this.app!.showToast(result.error, 'error'); return; }
      this.app!.showToast(t('feedback.cloneComplete'), 'success');
      await this.app!.components.repoTabs!.addRepo(result.path);
    } catch (e) {
      this.app!.showToast('Error: ' + (e as Error).message, 'error');
    }
  }

  cloneDialog(): Promise<string | null> {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'repository-picker-overlay';
      overlay.innerHTML = `
        <section class="repository-picker" role="dialog" aria-modal="true" aria-labelledby="clone-dialog-title">
          <header class="repository-picker-header">
            <div>
              <span class="eyebrow">${t('welcome.clone')}</span>
              <h2 id="clone-dialog-title">${t('clone.title')}</h2>
            </div>
            <button class="icon-btn repository-picker-close" type="button" aria-label="${t('common.close')}">
              <i class="ph ph-x" aria-hidden="true"></i>
            </button>
          </header>
          <div class="clone-dialog-body">
            <label>
              <span>${t('clone.urlLabel')}</span>
              <input class="clone-url-input" type="text" placeholder="https://github.com/user/repo.git" spellcheck="false" autocomplete="off">
            </label>
          </div>
          <footer class="repository-picker-footer">
            <div>
              <button class="btn btn-secondary" type="button" data-action="cancel">${t('common.cancel')}</button>
              <button class="btn btn-primary" type="button" data-action="next">${t('clone.next')}</button>
            </div>
          </footer>
        </section>`;
      const finish = (value: string | null) => {
        overlay.remove();
        document.removeEventListener('keydown', keydown);
        resolve(value);
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') finish(null);
        if (event.key === 'Enter') submit();
      };
      const submit = () => {
        const input = overlay.querySelector('.clone-url-input') as HTMLInputElement;
        const value = input.value.trim();
        if (!value) return;
        finish(value);
      };
      document.body.appendChild(overlay);
      overlay.querySelector<HTMLElement>('.repository-picker-close')!.onclick = () => finish(null);
      overlay.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.target === overlay) finish(null);
      });
      overlay.querySelector<HTMLElement>('[data-action="cancel"]')!.onclick = () => finish(null);
      overlay.querySelector<HTMLElement>('[data-action="next"]')!.onclick = submit;
      document.addEventListener('keydown', keydown);
      overlay.querySelector<HTMLElement>('.clone-url-input')!.focus();
    });
  }

  async loadRecent(): Promise<void> {
    try {
      const repos = await window.gitTree.getRepos() as Array<{ name?: string; path?: string }> | undefined;
      if (!repos || !repos.length) { this.recentList.innerHTML = ''; return; }
      this.recentList.innerHTML = `<div class="welcome-recent-title">${t('welcome.recent')}</div>`;
      repos.slice(0, 5).forEach((repo, index) => {
        const el = document.createElement('div');
        el.className = 'welcome-recent-item';
        el.style.setProperty('--item-index', String(index));
        el.innerHTML = `<div class="recent-name">${this.esc(repo.name ?? '')}</div><div class="recent-path">${this.esc(repo.path ?? '')}</div>`;
        el.addEventListener('click', () => {
          this.app!.components.repoTabs!.addRepo(repo.path!);
        });
        this.recentList.appendChild(el);
      });
    } catch (e) { console.error('loadRecent:', e); }
  }

  show(): void {
    this.screen.classList.remove('is-hidden');
    document.getElementById('workspace')!.classList.add('is-hidden');
  }

  hide(): void {
    this.screen.classList.add('is-hidden');
    document.getElementById('workspace')!.classList.remove('is-hidden');
  }

  esc(value: unknown): string { return HtmlEncoder.encode(value); }
}

if (typeof window !== 'undefined') {
  (window as unknown as { WelcomeScreen: typeof WelcomeScreen }).WelcomeScreen = WelcomeScreen;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = WelcomeScreen;
}

import type { GitTreeApp } from '../app.mts';
import { isAgentsFeatureEnabled } from '../ai-feature-gate.mts';

interface ConflictBlock {
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  base?: string | null;
  current?: string | null;
  incoming?: string | null;
  smartCombination?: string | null;
}

interface ConflictFileState {
  error?: string;
  path: string;
  binary?: boolean;
  result?: string;
  blocks?: ConflictBlock[];
  base?: string;
  current?: string;
  incoming?: string;
  eol?: string;
  snapshotId?: string;
}

export interface OperationStateInfo {
  type?: string;
  conflicts?: string[];
  error?: unknown;
}

interface PushAfter {
  remote: string;
  branch: string;
}

declare const ConflictHighlight: {
  splitLines: (content: unknown) => string[];
  buildHighlightLines: (content: unknown, blocks?: ConflictBlock[]) => Array<{ kind: string; text: string }>;
};

function rangeLines(start: number, end: number): number[] {
  const lines = [];
  for (let line = start; line <= end; line += 1) lines.push(line);
  return lines;
}

export class ConflictResolver {
  app: GitTreeApp;
  container: HTMLElement;
  state: OperationStateInfo | null;
  allFiles: string[];
  currentPath: string | null;
  current: ConflictFileState | null;
  resultContent: string;
  blocks: ConflictBlock[];
  activeBlockIndex: number;
  pendingBinaryStrategy: string | null;
  dirty: boolean;
  manualEdited: boolean;
  undoStack: Array<{ content: string; blocks: ConflictBlock[]; activeBlockIndex: number }>;
  blockCounts: Map<string, number | null>;
  binaryMap: Map<string, boolean>;
  fileFilter: string;
  reparseTimer: ReturnType<typeof setTimeout> | null;
  explainingBlock: boolean;
  aiExplanation: { blockIndex: number; summary: string; body: string } | null;
  layout: string;
  highlightRows: Array<{ kind: string; text: string }> | null;
  syncFrame: number;
  globalKeysHandler: ((event: KeyboardEvent) => void) | null;
  closeResolveAllMenu: ((event: MouseEvent) => void) | null;
  pushAfter: PushAfter | null;
  minimized: boolean;
  isRefreshingDisk: boolean;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.container = document.getElementById('merge-workspace-overlay')!;
    this.state = null;
    this.allFiles = [];
    this.currentPath = null;
    this.current = null;
    this.resultContent = '';
    this.blocks = [];
    this.activeBlockIndex = 0;
    this.pendingBinaryStrategy = null;
    this.dirty = false;
    this.manualEdited = false;
    this.undoStack = [];
    this.blockCounts = new Map();
    this.binaryMap = new Map();
    this.fileFilter = '';
    this.reparseTimer = null;
    this.explainingBlock = false;
    this.aiExplanation = null;
    this.highlightRows = null;
    this.syncFrame = 0;
    this.globalKeysHandler = null;
    this.closeResolveAllMenu = null;
    this.pushAfter = null;
    this.minimized = false;
    this.isRefreshingDisk = false;
    this.layout = localStorage.getItem('gittree.mergeEditor.layout') === 'vertical'
      ? 'vertical'
      : 'horizontal';
    window.addEventListener('beforeunload', event => {
      if (!this.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  async open(state: OperationStateInfo | null = null, options: { pushAfter?: PushAfter } | null = null): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    this.state = state?.type ? state : await window.gitTree.getOperationState(repo.path) as OperationStateInfo;
    if (this.state?.error) {
      this.app.showToast(this.state.error as string, 'error');
      return;
    }
    if (!this.state?.type) return;
    if (options?.pushAfter) this.pushAfter = options.pushAfter;
    const conflicts = this.state.conflicts || [];
    this.allFiles = [...conflicts];
    this.blockCounts = new Map<string, number | null>(
      conflicts.map((file: string): [string, number | null] => [file, null])
    );
    this.binaryMap = new Map();
    this.currentPath = conflicts[0] || null;
    this.current = null;
    this.dirty = false;
    this.undoStack = [];
    this.fileFilter = '';
    this.minimized = false;
    this.render();
    this.container!.classList.remove('is-hidden');
    this.updateBanner();
    if (this.currentPath) await this.loadFile(this.currentPath);
  }

  remainingFiles(): string[] {
    return (this.state?.conflicts || []).filter(file => this.allFiles.includes(file));
  }

  unresolvedCount(): number | null {
    const remaining = this.remainingFiles();
    const known = remaining
      .map(file => this.blockCounts.get(file))
      .filter(count => Number.isInteger(count)) as number[];
    return known.length === remaining.length ? known.reduce((sum, count) => sum + count, 0) : null;
  }

  updateBanner(): void {
    const banner = this.app.components.operationBanner as unknown as { setOperation: (s: unknown) => void } | undefined;
    if (banner && this.state?.type && !this.container.classList.contains('is-hidden')) {
      banner.setOperation(null);
    } else if (banner) {
      banner.setOperation(this.state);
    }
  }

  renderStepper(): string {
    const total = this.allFiles.length;
    const resolved = total - this.remainingFiles().length;
    const hasConflicts = this.remainingFiles().length > 0;
    const pushLabel = this.pushAfter ? `${t('mergeWorkspace.stepPush')} • ${this.esc(this.pushAfter.branch)}` : (t('mergeWorkspace.stepPush') || 'Push');
    return `
      <div class="conflict-stepper" aria-label="${this.esc(t('mergeWorkspace.stepperLabel') || 'Avanzamento')}">
        <div class="conflict-stepper-item is-done"><span class="conflict-stepper-index"><i class="ph ph-check" aria-hidden="true"></i></span><span>${this.esc(t('mergeWorkspace.stepPreview') || 'Anteprima')}</span></div>
        <span class="conflict-stepper-sep is-done" aria-hidden="true"></span>
        <div class="conflict-stepper-item is-active"><span class="conflict-stepper-index">2</span><span>${this.esc(t('conflicts.title'))} • ${resolved}/${total}</span></div>
        <span class="conflict-stepper-sep" aria-hidden="true"></span>
        <div class="conflict-stepper-item ${!hasConflicts ? '' : ''}"><span class="conflict-stepper-index">3</span><span>${this.esc(pushLabel)}</span></div>
      </div>
    `;
  }

  render(): void {
    const conflicts = this.remainingFiles();
    const resolved = this.allFiles.length - conflicts.length;
    const total = this.allFiles.length;
    const conflictsSum = this.unresolvedCount();
    const canContinue = conflicts.length === 0;
    this.container!.innerHTML = `
      <div class="conflict-workspace">
        <header class="conflict-header">
          <div class="conflict-header-title">
            <span class="eyebrow">${this.esc(t('conflicts.operation', { operation: String(this.state!.type ?? '') }))}</span>
            <h2>${this.esc(t('conflicts.title'))}</h2>
            <span class="conflict-progress">${this.esc(t('conflicts.filesResolved', { resolved, total }))}</span>
          </div>
          <div class="conflict-header-actions">
            ${conflictsSum !== null && conflictsSum > 0
              ? `<span class="badge badge-conflict">${this.esc(t('conflicts.blockCountTotal', { count: conflictsSum }))}</span>`
              : ''}
            <span class="badge ${conflicts.length ? 'badge-conflict' : 'badge-head'}">${conflicts.length} ${this.esc(t('conflicts.remaining'))}</span>
            <button class="btn btn-small conflict-refresh-btn" id="conflict-refresh" title="${this.esc(t('conflicts.refreshTitle'))}">
              <i class="ph ph-arrows-clockwise" aria-hidden="true"></i><span>${this.esc(t('conflicts.refresh'))}</span>
            </button>
            <button class="btn btn-small" id="conflict-minimize" title="${this.esc(t('conflicts.minimizeTitle'))}">
              <i class="ph ph-minus" aria-hidden="true"></i><span>${this.esc(t('conflicts.minimize'))}</span>
            </button>
            <button class="btn" id="conflict-abort"><i class="ph ph-x-circle" aria-hidden="true"></i><span>${this.esc(t('conflicts.abort'))}</span></button>
            ${['rebase', 'cherry-pick'].includes(String(this.state!.type)) ? `
              <button class="btn" id="conflict-skip"><i class="ph ph-skip-forward" aria-hidden="true"></i><span>${this.esc(t('conflicts.skip'))}</span></button>
            ` : ''}
            <button class="btn btn-primary" id="conflict-continue" ${canContinue ? '' : 'disabled'}>
              <i class="ph ph-arrow-right" aria-hidden="true"></i><span>${this.esc(this.pushAfter ? t('conflicts.continueAndPush') : t('common.continue'))}</span>
            </button>
            <button class="btn-icon" id="conflict-close" aria-label="${this.esc(t('common.close'))}" title="${this.esc(t('common.close'))}">
              <i class="ph ph-x" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        ${this.renderStepper()}
        <div class="conflict-body">
          <aside class="conflict-file-list" aria-label="${this.esc(t('conflicts.files'))}">
            <div class="conflict-file-search search-clearable">
              <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
              <input type="text" id="conflict-file-filter" class="conflict-file-filter-input" placeholder="${this.esc(t('conflicts.filterFiles'))}" data-i18n-placeholder="conflicts.filterFiles">
              <button type="button" class="search-clear-btn is-hidden" id="conflict-file-filter-clear" aria-label="${this.esc(t('common.clearSearch'))}" data-i18n-aria-label="common.clearSearch">
                <i class="ph ph-x" aria-hidden="true"></i>
              </button>
            </div>
            <div class="conflict-file-scroll" id="conflict-file-scroll">
              ${this.renderFileList()}
            </div>
            <div class="conflict-minimized-hint">
              <i class="ph ph-info" aria-hidden="true"></i>
              <span>${this.esc(t('conflicts.externalHint'))}</span>
            </div>
          </aside>
          <main class="conflict-editor" id="conflict-editor">
            <div class="empty-state">${this.esc(conflicts.length ? t('common.loading') : t('conflicts.readyContinue'))}</div>
          </main>
        </div>
        <footer class="conflict-wizard-footer">
          <div class="conflict-wizard-step">
            <i class="ph ph-git-merge" aria-hidden="true"></i>
            <span>${this.esc(t('conflicts.wizardStep', { resolved, total }))}</span>
            ${this.pushAfter ? `<span class="badge badge-remote"><i class="ph ph-upload-simple" aria-hidden="true"></i> ${this.esc(t('mergeWorkspace.mergeAndPush'))}</span>` : ''}
          </div>
          <div class="conflict-header-secondary">
            <button class="btn btn-small" id="conflict-wizard-refresh"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i>${this.esc(t('conflicts.refresh'))}</button>
            <button class="btn btn-small" id="conflict-wizard-minimize"><i class="ph ph-eye-slash" aria-hidden="true"></i>${this.esc(t('conflicts.minimize'))}</button>
          </div>
          <div class="conflict-wizard-actions">
            <button class="btn" id="conflict-wizard-abort">${this.esc(t('conflicts.abort'))}</button>
            <button class="btn btn-primary" id="conflict-wizard-continue" ${canContinue ? '' : 'disabled'}>
              ${this.esc(this.pushAfter ? t('conflicts.continueAndPush') : t('common.continue'))}
            </button>
          </div>
        </footer>
      </div>`;

    (document.getElementById('conflict-abort')! as HTMLElement).onclick = () => this.abort();
    document.getElementById('conflict-wizard-abort')?.addEventListener('click', () => this.abort());
    document.getElementById('conflict-skip')?.addEventListener('click', () => this.skip());
    (document.getElementById('conflict-continue')! as HTMLElement).onclick = () => this.continue();
    document.getElementById('conflict-wizard-continue')?.addEventListener('click', () => this.continue());
    document.getElementById('conflict-refresh')?.addEventListener('click', () => this.refreshFromDisk());
    document.getElementById('conflict-wizard-refresh')?.addEventListener('click', () => this.refreshFromDisk());
    document.getElementById('conflict-minimize')?.addEventListener('click', () => this.minimize());
    document.getElementById('conflict-wizard-minimize')?.addEventListener('click', () => this.minimize());
    document.getElementById('conflict-close')?.addEventListener('click', () => this.minimize());
    const filterInput = document.getElementById('conflict-file-filter')! as HTMLInputElement | null;
    if (filterInput) {
      filterInput.value = this.fileFilter;
      filterInput.oninput = () => {
        this.fileFilter = filterInput.value;
        const clearButton = document.getElementById('conflict-file-filter-clear')!;
        if (clearButton) clearButton.classList.toggle('is-hidden', !this.fileFilter);
        this.refreshFileList();
      };
      filterInput.onkeydown = event => {
        if (event.key === 'Escape') {
          filterInput.value = '';
          this.fileFilter = '';
          document.getElementById('conflict-file-filter-clear')?.classList.add('is-hidden');
          this.refreshFileList();
        }
      };
      (document.getElementById('conflict-file-filter-clear')! as HTMLElement).onclick = () => {
        filterInput.value = '';
        this.fileFilter = '';
        document.getElementById('conflict-file-filter-clear')!.classList.add('is-hidden');
        this.refreshFileList();
      };
    }
    this.bindGlobalKeys();
  }

  renderFileList(): string {
    const needle = this.fileFilter.trim().toLowerCase();
    const remaining = this.remainingFiles();
    const rows = this.allFiles
      .filter(file => !needle || file.toLowerCase().includes(needle))
      .map(file => {
        const isResolved = !remaining.includes(file);
        const isActive = file === this.currentPath;
        const blockCount = this.blockCounts.get(file);
        const binary = this.binaryMap.get(file);
        const showCount = !isResolved && Number.isInteger(blockCount) && (blockCount ?? 0) > 0;
        return `
          <button class="conflict-file-item${isActive ? ' active' : ''}${isResolved ? ' is-resolved' : ''}"
            data-file="${this.esc(file)}" ${isResolved ? 'disabled' : ''} title="${this.esc(file)}">
            <i class="ph ${isResolved ? 'ph-check-circle' : 'ph-warning-circle'} conflict-file-status" aria-hidden="true"></i>
            <span class="conflict-file-name">${this.esc(file)}</span>
            ${this.dirty && file === this.currentPath ? `<i class="ph ph-dot-outline conflict-file-unsaved" aria-hidden="true" title="${this.esc(t('conflicts.unsaved'))}"></i>` : ''}
            ${showCount ? `<span class="badge badge-conflict conflict-file-count" title="${this.esc(t('conflicts.blockCountTitle', { count: blockCount }))}">${Number(blockCount ?? 0)}</span>` : ''}
            ${binary ? `<span class="badge conflict-file-binary">${this.esc(t('conflicts.binary'))}</span>` : ''}
          </button>`;
      });
    return rows.length
      ? rows.join('')
      : `<div class="conflict-file-empty">${this.esc(t('conflicts.noFilesMatch'))}</div>`;
  }

  refreshFileList(): void {
    const scroll = document.getElementById('conflict-file-scroll')!;
    if (!scroll) return;
    scroll.innerHTML = this.renderFileList();
    scroll.querySelectorAll<HTMLElement>('[data-file]').forEach(button => {
      button.onclick = async () => {
        if (!await this.confirmDiscard()) return;
        await this.loadFile(String((button as HTMLElement).dataset.file ?? ''));
      };
    });
  }

  async refreshFromDisk(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || this.isRefreshingDisk) return;
    this.isRefreshingDisk = true;
    const btn = document.getElementById('conflict-refresh') as HTMLButtonElement | null;
    const wBtn = document.getElementById('conflict-wizard-refresh') as HTMLButtonElement | null;
    [btn, wBtn].forEach(b => {
      if (b) {
        b.disabled = true;
        b.classList.add('is-spinning');
        const i = b.querySelector('i');
        if (i) i.className = 'ph ph-circle-notch';
      }
    });
    try {
      const freshState = await window.gitTree.getOperationState(repo.path) as OperationStateInfo;
      if (!freshState?.type) {
        this.app.showToast(t('operationBanner.noOperation'), 'success');
        this.hide();
        this.app.emit('refresh');
        return;
      }
      this.state = freshState;
      const remaining = freshState.conflicts || [];
      // Sync allFiles
      const newSet = new Set([...this.allFiles, ...remaining]);
      this.allFiles = [...newSet];
      for (const f of remaining) if (!this.blockCounts.has(f)) this.blockCounts.set(f, null);
      // If current file still conflicted, reload it
      if (this.currentPath && remaining.includes(this.currentPath)) {
        await this.loadFile(this.currentPath);
      } else if (remaining.length) {
        this.currentPath = remaining[0];
        await this.loadFile(this.currentPath);
      } else {
        this.currentPath = null;
        this.current = null;
      }
      // Re-count blocks for remaining files where needed by reading them if not yet known
      for (const file of remaining) {
        if (this.blockCounts.get(file) === null) {
          try {
            const info = await window.gitTree.readConflict(repo.path, file) as ConflictFileState;
            this.blockCounts.set(file, info?.blocks?.length ?? 0);
            if (info?.binary) this.binaryMap.set(file, true);
          } catch (_e) { void _e; }
        }
      }
      this.render();
      if (this.currentPath) await this.loadFile(this.currentPath);
      else {
        const editor = document.getElementById('conflict-editor');
        if (editor) editor.innerHTML = `<div class="empty-state">${this.esc(t('conflicts.readyContinue'))}</div>`;
      }
      this.app.showToast(t('conflicts.refreshed'), 'success');
      this.updateBanner();
    } catch (e) {
      this.app.showToast((e as Error).message, 'error');
    } finally {
      this.isRefreshingDisk = false;
      [btn, wBtn].forEach(b => {
        if (b) {
          b.disabled = false;
          b.classList.remove('is-spinning');
          const i = b.querySelector('i');
          if (i) i.className = 'ph ph-arrows-clockwise';
        }
      });
    }
  }

  minimize(): void {
    if (!this.state?.type) {
      this.hide();
      return;
    }
    // Hide overlay but keep state, show banner
    this.container.classList.add('is-hidden');
    const banner = this.app.components.operationBanner as unknown as { setOperation: (s: unknown) => void } | undefined;
    if (banner) banner.setOperation(this.state);
    this.app.showToast(t('conflicts.minimized'), 'info');
  }

  resume(): void {
    if (!this.state?.type) return;
    this.minimized = false;
    this.container.classList.remove('is-hidden');
    const banner = this.app.components.operationBanner as unknown as { setOperation: (s: unknown) => void } | undefined;
    if (banner) banner.setOperation(null);
  }

  async loadFile(filePath: string): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    this.currentPath = filePath;
    this.current = await window.gitTree.readConflict(repo.path, filePath) as ConflictFileState;
    if (this.current?.error) {
      this.app.showToast(this.current.error, 'error');
      return;
    }
    this.resultContent = String(this.current!.result ?? '');
    this.blocks = (this.current!.blocks || []).map(block => ({ ...block }));
    this.activeBlockIndex = 0;
    this.aiExplanation = null;
    this.pendingBinaryStrategy = null;
    this.manualEdited = false;
    this.dirty = false;
    this.undoStack = [];
    this.blockCounts.set(filePath, this.blocks.length);
    if (this.current!.binary) this.binaryMap.set(filePath, true);
    this.refreshFileList();
    this.renderEditor();
  }

  renderEditor(): void {
    if (!this.current) return;
    const editor = document.getElementById('conflict-editor')!;
    if (!editor) return;
    const file = this.current;
    const blockCount = this.blocks.length;
    editor.innerHTML = `
      <div class="conflict-editor-toolbar">
        <div class="conflict-current-file">
          <strong>${this.esc(file.path)}</strong>
          ${file.binary ? `<span class="badge">${this.esc(t('conflicts.binary'))}</span>` : ''}
          ${!file.binary && blockCount > 0 ? `<span class="badge badge-conflict">${this.esc(t('conflicts.blockCountTitle', { count: blockCount }))}</span>` : ''}
          ${!file.binary && blockCount === 0 ? `<span class="badge badge-head">${this.esc(t('conflicts.noConflictsBadge') || 'Risolto')}</span>` : ''}
        </div>
        <div class="conflict-toolbar-actions">
          ${file.binary ? `
            <button class="btn" data-binary="ours">${this.esc(t('conflicts.acceptCurrent'))}</button>
            <button class="btn" data-binary="theirs">${this.esc(t('conflicts.acceptIncoming'))}</button>
          ` : `
            <div class="conflict-resolve-all">
              <button class="btn" id="conflict-resolve-all">${this.esc(t('conflicts.resolveAll'))}<i class="ph ph-caret-down" aria-hidden="true"></i></button>
              <div class="conflict-resolve-all-menu is-hidden">
                <button class="conflict-resolve-all-item" data-all="current">${this.esc(t('conflicts.resolveAllCurrent'))}</button>
                <button class="conflict-resolve-all-item" data-all="incoming">${this.esc(t('conflicts.resolveAllIncoming'))}</button>
                <button class="conflict-resolve-all-item" data-all="both">${this.esc(t('conflicts.resolveAllBoth'))}</button>
              </div>
            </div>
            <button class="btn" data-whole="current" title="${this.esc(t('conflicts.useCurrentFile'))}">${this.esc(t('conflicts.useCurrentFile'))}</button>
            <button class="btn" data-whole="incoming" title="${this.esc(t('conflicts.useIncomingFile'))}">${this.esc(t('conflicts.useIncomingFile'))}</button>
            <button class="btn" id="conflict-refresh-file" title="${this.esc(t('conflicts.refreshFileTitle'))}"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i>${this.esc(t('conflicts.refreshFile'))}</button>
            <button class="btn" id="conflict-layout">
              <i class="ph ph-layout" aria-hidden="true"></i>${this.esc(
                this.layout === 'horizontal' ? t('conflicts.verticalLayout') : t('conflicts.horizontalLayout')
              )}
            </button>
            <button class="btn" id="conflict-undo" disabled title="${this.esc(t('conflicts.undo'))}">
              <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>${this.esc(t('conflicts.undo'))}
            </button>
          `}
          <button class="btn btn-primary" id="conflict-mark-resolved" ${this.canMarkResolved() ? '' : 'disabled'}>
            <i class="ph ph-check-circle" aria-hidden="true"></i>${this.esc(t('conflicts.markResolved'))}
          </button>
        </div>
      </div>
      ${file.binary ? this.renderBinaryState() : this.renderTextEditor()}`;

    editor.querySelectorAll<HTMLElement>('[data-binary]').forEach(button => {
      button.onclick = () => {
        this.pendingBinaryStrategy = String((button as HTMLElement).dataset.binary ?? '');
        this.dirty = true;
        editor.querySelectorAll('[data-binary]').forEach(item => {
          item.classList.toggle('active', item === button);
        });
        this.updateMarkButton();
      };
    });
    editor.querySelectorAll<HTMLElement>('[data-whole]').forEach(button => {
      button.onclick = () => this.useWholeFile(String((button as HTMLElement).dataset.whole));
    });
    const resolveAllButton = document.getElementById('conflict-resolve-all')!;
    if (resolveAllButton) {
      resolveAllButton.onclick = event => {
        event.stopPropagation();
        const menu = document.querySelector('.conflict-resolve-all-menu');
        menu?.classList.toggle('is-hidden');
      };
      editor.querySelectorAll<HTMLElement>('.conflict-resolve-all-item').forEach(item => {
        item.onclick = () => {
          document.querySelector('.conflict-resolve-all-menu')?.classList.add('is-hidden');
          this.applyToAll(String((item as HTMLElement).dataset.all));
        };
      });
      if (this.closeResolveAllMenu) {
        document.removeEventListener('click', this.closeResolveAllMenu);
      }
      document.addEventListener('click', this.closeResolveAllMenu = event => {
        if (!(event.target as HTMLElement).closest('.conflict-resolve-all')) {
          document.querySelector('.conflict-resolve-all-menu')?.classList.add('is-hidden');
        }
      });
    }
    document.getElementById('conflict-layout')?.addEventListener('click', () => {
      this.layout = this.layout === 'horizontal' ? 'vertical' : 'horizontal';
      localStorage.setItem('gittree.mergeEditor.layout', this.layout);
      this.renderEditor();
    });
    document.getElementById('conflict-refresh-file')?.addEventListener('click', () => this.refreshFromDisk());
    document.getElementById('conflict-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('conflict-mark-resolved')?.addEventListener('click', () => this.markResolved());
    document.getElementById('conflict-ai-explain')?.addEventListener('click', () => this.explainBlock());
    document.getElementById('conflict-ai-delegate')?.addEventListener('click', () => this.delegateToAgent());
    const resultEditor = document.getElementById('conflict-result-editor')! as HTMLTextAreaElement | null;
    if (resultEditor) resultEditor.value = this.resultContent;
    this.bindTextEditor();
    this.renderAiPanel();
  }

  async explainBlock(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || this.explainingBlock) return;
    const blockIndex = this.activeBlockIndex;
    this.explainingBlock = true;
    this.setBlockExplainBusy(true);
    try {
      const result = await window.gitTree.explainConflict(repo.path, {
        file: this.currentPath,
        blockIndex,
        language: await this.aiLanguage()
      }) as { error?: string; summary?: string; body?: string };
      if (result?.error) {
        this.app.showToast(result.error, 'error');
        return;
      }
      this.aiExplanation = {
        blockIndex,
        summary: result.summary || '',
        body: result.body || ''
      };
      this.renderAiPanel();
      this.app.showToast(t('conflicts.aiExplained'), 'success');
    } finally {
      this.explainingBlock = false;
      this.setBlockExplainBusy(false);
    }
  }

  setBlockExplainBusy(busy: boolean): void {
    const button = document.getElementById('conflict-ai-explain')! as HTMLButtonElement | null;
    if (!button) return;
    const icon = button.querySelector('i') as HTMLElement;
    const label = button.querySelector('span') as HTMLElement;
    button.disabled = busy;
    if (busy) {
      icon.className = 'ph ph-circle-notch';
      label.textContent = t('conflicts.aiExplaining');
      return;
    }
    icon.className = 'ph ph-sparkle';
    label.textContent = t('conflicts.aiExplain');
  }

  renderAiPanel(): void {
    const panel = document.getElementById('conflict-ai-panel')!;
    if (!panel) return;
    const matches = this.aiExplanation
      && this.aiExplanation.blockIndex === this.activeBlockIndex;
    if (!matches) {
      panel.classList.add('is-hidden');
      return;
    }
    (document.getElementById('conflict-ai-title') as HTMLElement).textContent = String(this.aiExplanation!.summary);
    (document.getElementById('conflict-ai-body') as HTMLElement).textContent = String(this.aiExplanation!.body);
    panel.classList.remove('is-hidden');
    (document.getElementById('conflict-ai-close')! as HTMLElement).onclick = () => {
      panel.classList.add('is-hidden');
    };
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

  delegateToAgent(): void {
    const panel = this.app.components?.worktreeAgents;
    if (!panel) return;
    const block = this.blocks[this.activeBlockIndex];
    if (!block) return;
    const prompt = [
      `Resolve the merge conflict in ${this.currentPath} `
        + `(block ${this.activeBlockIndex + 1} of ${this.blocks.length}) `
        + `of the ${this.state?.type || 'git'} operation.`,
      'Analyze the three versions below and produce the merged content',
      'that keeps the intent of both sides.',
      'Return only the merged code or file content; do not run git commands.',
      '--- base version ---',
      block.base || '(empty)',
      '--- current version (ours) ---',
      block.current || '(empty)',
      '--- incoming version (theirs) ---',
      block.incoming || '(empty)'
    ].filter(Boolean).join('\n');
    panel.openNewSession(null, { prefillPrompt: prompt });
  }

  renderBinaryState(): string {
    return `
      <div class="conflict-binary-state">
        <i class="ph ph-file-lock" aria-hidden="true"></i>
        <h3>${this.esc(t('conflicts.binaryTitle'))}</h3>
        <p>${this.esc(t('conflicts.binaryHelp'))}</p>
        <p class="conflict-selection-note">${this.esc(
          this.pendingBinaryStrategy ? t('conflicts.selectionPending') : t('conflicts.chooseVersion')
        )}</p>
      </div>`;
  }

  renderTextEditor(): string {
    const active = this.blocks[this.activeBlockIndex] || null;
    const currentRanges = this.blocks.map(block => this.locateLines(String(this.current!.current ?? ''), String(block.current ?? '')));
    const incomingRanges = this.blocks.map(block => this.locateLines(String(this.current!.incoming), String(block.incoming ?? '')));
    return `
      <div class="conflict-block-toolbar">
        <div class="conflict-navigation">
          <button class="icon-btn" id="conflict-previous" ${this.activeBlockIndex <= 0 ? 'disabled' : ''} aria-label="${this.esc(t('conflicts.previous'))}" title="${this.esc(t('conflicts.previous'))}">
            <i class="ph ph-arrow-up" aria-hidden="true"></i>
          </button>
          <button class="icon-btn" id="conflict-next" ${this.activeBlockIndex >= this.blocks.length - 1 ? 'disabled' : ''} aria-label="${this.esc(t('conflicts.next'))}" title="${this.esc(t('conflicts.next'))}">
            <i class="ph ph-arrow-down" aria-hidden="true"></i>
          </button>
          <strong>${this.esc(t('conflicts.blockCount', {
            current: this.blocks.length ? this.activeBlockIndex + 1 : 0,
            total: this.blocks.length
          }))}</strong>
          <span class="conflict-keyhint" style="margin-left:8px">${this.esc(t('conflicts.navigateHint'))}</span>
        </div>
        ${active && !this.manualEdited ? `
          <div class="conflict-block-actions">
            <span class="conflict-keyhint">${this.esc(t('conflicts.acceptHint'))}</span>
            <button class="btn btn-small" data-choice="current">${this.esc(t('conflicts.acceptCurrent'))}</button>
            <button class="btn btn-small" data-choice="incoming">${this.esc(t('conflicts.acceptIncoming'))}</button>
            <button class="btn btn-small" data-choice="both">${this.esc(t('conflicts.acceptBoth'))}</button>
            <button class="btn btn-small" data-choice="smart" ${active.smartCombination === null ? 'disabled' : ''}>${this.esc(t('conflicts.smartCombination'))}</button>
            <button class="btn btn-small" data-choice="ignore">${this.esc(t('conflicts.ignore'))}</button>
            ${isAgentsFeatureEnabled() ? `
            <button class="btn btn-small" id="conflict-ai-explain" type="button">
              <i class="ph ph-sparkle" aria-hidden="true"></i><span>${this.esc(t('conflicts.aiExplain'))}</span>
            </button>
            <button class="btn btn-small" id="conflict-ai-delegate" type="button">
              <i class="ph ph-robot" aria-hidden="true"></i><span>${this.esc(t('conflicts.aiDelegateToAgent'))}</span>
            </button>` : ''}
          </div>
        ` : `<span class="conflict-manual-note">${this.esc(
          this.manualEdited ? t('conflicts.manualMode') : t('conflicts.noUnresolvedBlocks')
        )}</span>`}
      </div>
      <div id="conflict-ai-panel" class="conflict-ai-panel is-hidden">
        <div class="conflict-ai-header">
          <div class="conflict-ai-heading">
            <i class="ph ph-sparkle" aria-hidden="true"></i>
            <span id="conflict-ai-title"></span>
          </div>
          <button id="conflict-ai-close" class="btn-icon" type="button" data-i18n-aria-label="conflicts.aiExplainClose" aria-label="${this.esc(t('conflicts.aiExplainClose'))}">
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
        <div id="conflict-ai-body" class="conflict-ai-body"></div>
      </div>
      <details class="conflict-base">
        <summary>${this.esc(t('conflicts.base'))}</summary>
        ${this.codePane(String(this.current!.base ?? ''), 'base', false, null, [])}
      </details>
      <div class="conflict-merge-grid is-${this.layout}">
        ${this.sourcePane(t('conflicts.incoming'), String(this.current!.incoming ?? ''), 'incoming', incomingRanges, this.activeBlockIndex)}
        ${this.sourcePane(t('conflicts.current'), String(this.current!.current ?? ''), 'current', currentRanges, this.activeBlockIndex)}
        <section class="conflict-pane conflict-result-pane">
          <div class="conflict-pane-header result">${this.esc(t('conflicts.result'))}</div>
          <div class="conflict-result-editor" id="conflict-result-stack">
            <pre class="conflict-result-gutter" aria-hidden="true"></pre>
            <div class="conflict-result-overlay">
              <pre class="conflict-highlight-layer" id="conflict-highlight-layer" aria-hidden="true"></pre>
              <div class="conflict-action-bar is-hidden" id="conflict-action-bar"></div>
              <textarea id="conflict-result-editor" spellcheck="false" aria-label="${this.esc(t('conflicts.result'))}"></textarea>
            </div>
          </div>
        </section>
      </div>`;
  }

  sourcePane(label: string, content: string, kind: string, blockRanges: Array<{ start: number; end: number } | null>, activeIndex: number): string {
    return `<section class="conflict-pane conflict-source-pane">
      <div class="conflict-pane-header ${kind}">${this.esc(label)}</div>
      ${this.codePane(content, kind, true, blockRanges?.[activeIndex] || null, blockRanges || [])}
    </section>`;
  }

  codePane(content: string, kind: string, synchronized: boolean, activeRange: { start: number; end: number } | null, blockRanges: Array<{ start: number; end: number } | null>): string {
    const lines = ConflictHighlight.splitLines(content).map(line => line.replace(/\r?\n|\r$/, ''));
    const active = activeRange
      ? new Set(rangeLines(activeRange.start, activeRange.end))
      : new Set<number>();
    const blocks = blockRanges
      .map(range => range ? new Set(rangeLines(range.start, range.end)) : new Set<number>());
    const dimmed = blockRanges.length > 0 && !activeRange;
    return `<div class="conflict-code-scroll${synchronized ? ' is-synchronized' : ''}" data-pane="${kind}">
      <pre class="conflict-code-gutter" aria-hidden="true">${lines.map((_, index) => index + 1).join('\n')}</pre>
      <div class="conflict-pane-rows${dimmed ? ' is-dimmed' : ''}">
        ${lines.map((text, index) => {
          const inActive = active.has(index + 1);
          const inBlock = blocks.some(set => set.has(index + 1));
          const css = inActive ? ' is-active' : (inBlock ? ' is-block' : '');
          return `<div class="conflict-pane-row${css}" data-pane-line="${index + 1}">${this.esc(text)}</div>`;
        }).join('')}
      </div>
    </div>`;
  }

  buildResultLayer(): void {
    const layer = document.getElementById('conflict-highlight-layer')!;
    if (!layer) return;
    const rows = ConflictHighlight.buildHighlightLines(this.resultContent, this.blocks);
    layer.innerHTML = rows.map(row => {
      const cls = row.kind === 'plain' ? '' : ` hl-${row.kind}`;
      const text = (row.kind === 'marker' || row.kind === 'separator') ? '' : row.text;
      return `<div class="conflict-hl-row${cls}">${text ? this.esc(text) : ' '}</div>`;
    }).join('');
    this.highlightRows = rows;

    const textarea = document.getElementById('conflict-result-editor')! as HTMLTextAreaElement | null;
    if (textarea) {
      this.refreshResultGutter(textarea, document.querySelector('.conflict-result-gutter'));
      this.syncHighlightScroll(textarea);
    }
    this.positionActionBar();
  }

  positionActionBar(): void {
    const bar = document.getElementById('conflict-action-bar')!;
    const stack = document.getElementById('conflict-result-stack')!;
    if (!bar || !stack) return;
    const block = this.blocks[this.activeBlockIndex];
    if (!block || this.current?.binary) {
      bar.classList.add('is-hidden');
      return;
    }
    const rowIndex = Math.max(0, block.startLine - 1);
    const lineHeight = 21;
    const paddingTop = 8;
    const top = paddingTop + rowIndex * lineHeight - ((document.getElementById('conflict-result-editor')! as HTMLTextAreaElement | null)?.scrollTop || 0);
    stack.style.setProperty('--action-bar-top', `${top}px`);
    bar.innerHTML = `
      <span class="conflict-action-bar-label"><i class="ph ph-warning-circle" aria-hidden="true"></i>${this.esc(t('conflicts.blockCount', {
        current: this.activeBlockIndex + 1,
        total: this.blocks.length
      }))}</span>
      <button class="btn btn-small btn-primary" data-choice="current">${this.esc(t('conflicts.acceptCurrent'))}</button>
      <button class="btn btn-small" data-choice="incoming">${this.esc(t('conflicts.acceptIncoming'))}</button>
      <button class="btn btn-small" data-choice="both">${this.esc(t('conflicts.acceptBoth'))}</button>
      <button class="btn btn-small" data-choice="smart" ${block.smartCombination === null ? 'disabled' : ''}>${this.esc(t('conflicts.smartCombination'))}</button>
    `;
    bar.classList.remove('is-hidden');
    bar.querySelectorAll<HTMLElement>('[data-choice]').forEach(button => {
      button.onclick = () => this.applyBlockChoice((button as HTMLElement).dataset.choice ?? '');
    });
  }

  syncHighlightScroll(textarea: HTMLTextAreaElement): void {
    const layer = document.getElementById('conflict-highlight-layer')!;
    const gutter = document.querySelector('.conflict-result-gutter');
    const stack = document.getElementById('conflict-result-stack')!;
    const bar = document.getElementById('conflict-action-bar')!;
    if (layer) layer.scrollTop = textarea.scrollTop;
    if (gutter) gutter.scrollTop = textarea.scrollTop;
    if (stack) {
      stack.style.setProperty('--action-bar-top', `${8 + Math.max(0, (this.blocks[this.activeBlockIndex]?.startLine || 1) - 1) * 21 - textarea.scrollTop}px`);
    }
    if (bar) bar.classList.toggle('is-hidden', !this.blocks.length);
  }

  bindTextEditor(): void {
    if (this.current?.binary) return;
    document.getElementById('conflict-previous')?.addEventListener('click', () => this.jumpToBlock(this.activeBlockIndex - 1));
    document.getElementById('conflict-next')?.addEventListener('click', () => this.jumpToBlock(this.activeBlockIndex + 1));
    document.querySelectorAll<HTMLElement>('[data-choice]').forEach(button => {
      button.onclick = () => this.applyBlockChoice((button as HTMLElement).dataset.choice ?? '');
    });

    this.bindResultEditor();
    this.bindSourcePanes();
  }

  bindResultEditor(): void {
    const textarea = document.getElementById('conflict-result-editor')! as HTMLTextAreaElement | null;
    if (!textarea) return;
    this.buildResultLayer();
    const active = this.blocks[this.activeBlockIndex];
    if (active && !this.manualEdited) {
      textarea.setSelectionRange(active.startOffset, active.endOffset);
    }
    textarea.addEventListener('input', () => {
      this.resultContent = textarea.value;
      this.dirty = true;
      this.manualEdited = true;
      this.refreshResultGutter(textarea, document.querySelector('.conflict-result-gutter'));
      this.updateMarkButton();
      this.scheduleReparse();
    });
    textarea.addEventListener('scroll', () => {
      this.syncHighlightScroll(textarea);
    }, { passive: true });
    textarea.addEventListener('keydown', event => this.handleEditorKeys(event));
  }

  handleEditorKeys(event: KeyboardEvent): void {
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.jumpToBlock(this.activeBlockIndex - 1);
      return;
    }
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.jumpToBlock(this.activeBlockIndex + 1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.markResolved();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.undo();
    }
    if (!this.manualEdited && this.blocks[this.activeBlockIndex] && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const choice = ({ c: 'current', i: 'incoming', b: 'both' } as Record<string, string>)[event.key.toLowerCase()];
      if (choice) {
        event.preventDefault();
        this.applyBlockChoice(choice);
      }
    }
  }

  bindSourcePanes(): void {
    const synchronized = [...document.querySelectorAll<HTMLElement>('.conflict-code-scroll.is-synchronized')];
    synchronized.forEach(source => {
      source.addEventListener('scroll', () => {
        if (this.syncFrame) return;
        this.syncFrame = requestAnimationFrame(() => {
          this.syncFrame = 0;
          const maximum = Math.max(1, source.scrollHeight - source.clientHeight);
          const ratio = source.scrollTop / maximum;
          synchronized.forEach(target => {
            if (target !== source) {
              target.scrollTop = ratio * Math.max(0, target.scrollHeight - target.clientHeight);
              target.scrollLeft = source.scrollLeft;
            }
          });
        });
      }, { passive: true });
    });
    const pane = document.querySelector<HTMLElement>('.conflict-code-scroll[data-pane="current"]') ||
      document.querySelector<HTMLElement>('.conflict-code-scroll[data-pane="incoming"]');
    if (pane) {
      pane.parentElement!.querySelectorAll<HTMLElement>('.conflict-pane-row[data-pane-line]').forEach(row => {
        row.addEventListener('click', () => {
          const line = Number(row.dataset.paneLine);
          const ranges = pane.dataset.pane === 'current'
            ? this.blocks.map(block => this.locateLines(String(this.current!.current ?? ''), String(block.current ?? '')))
            : this.blocks.map(block => this.locateLines(String(this.current!.incoming), String(block.incoming ?? '')));
          const index = ranges.findIndex(range => range && line >= range.start && line <= range.end);
          if (index !== -1) this.jumpToBlock(index);
        });
      });
    }
  }

  jumpToBlock(index: number): void {
    if (index < 0 || index >= this.blocks.length) return;
    this.activeBlockIndex = index;
    this.renderEditor();
  }

  locateLines(content: string, needle: string): { start: number; end: number } | null {
    if (!needle || needle === '') return null;
    const position = String(content || '').indexOf(needle);
    if (position === -1) return null;
    const before = String(content || '').slice(0, position);
    const start = before.split(/\r?\n|\r/).length;
    const lines = needle.split(/\r?\n|\r/).length;
    return { start, end: start + lines - 1 };
  }

  blockPaneRange(block: ConflictBlock): { start: number; end: number } | null {
    return this.locateLines(this.current?.current || '', String(block.current ?? ''));
  }

  scheduleReparse(): void {
    if (this.reparseTimer) clearTimeout(this.reparseTimer);
    this.reparseTimer = setTimeout(async () => {
      const repo = this.app.state.repo;
      if (!repo || !this.currentPath || this.container!.classList.contains('is-hidden')) return;
      const result = await window.gitTree.parseConflictBlocks(repo.path, this.resultContent) as { error?: string } | ConflictBlock[];
      if ((result as { error?: string })?.error) return;
      this.blocks = ((result as ConflictBlock[]) || []).map(block => ({ ...block }));
      this.activeBlockIndex = Math.min(this.activeBlockIndex, Math.max(0, this.blocks.length - 1));
      this.blockCounts.set(this.currentPath!, this.blocks.length);
      this.updateMarkButton();
      this.buildResultLayer();
      this.refreshFileList();
    }, 500);
  }

  useWholeFile(kind: string): void {
    this.snapshot();
    this.resultContent = String(kind === 'current' ? this.current!.current : this.current!.incoming ?? '');
    this.blocks = [];
    this.activeBlockIndex = 0;
    this.manualEdited = false;
    this.dirty = true;
    this.blockCounts.set(this.currentPath!, 0);
    this.renderEditor();
  }

  applyToAll(choice: string): void {
    if (!this.blocks.length) return;
    this.snapshot();
    const eol = this.current!.eol === 'crlf' ? '\r\n' : '\n';
    for (const block of [...this.blocks]) {
      const currentStr: string | null = block.current ?? null;
      const incomingStr: string | null = block.incoming ?? null;
      let replacement: string | null;
      if (choice === 'current') replacement = currentStr;
      else if (choice === 'incoming') replacement = incomingStr;
      else replacement = `${currentStr}${(currentStr?.endsWith(eol) || !currentStr) ? '' : eol}${incomingStr}`;
      if (replacement === null) continue;
      this.resultContent =
        this.resultContent.slice(0, block.startOffset) +
        replacement +
        this.resultContent.slice(block.endOffset);
      const delta = replacement.length - (block.endOffset - block.startOffset);
      for (const other of this.blocks) {
        if (other.startOffset > block.endOffset) {
          other.startOffset += delta;
          other.endOffset += delta;
        }
      }
    }
    this.blocks = [];
    this.activeBlockIndex = 0;
    this.dirty = true;
    this.blockCounts.set(this.currentPath!, 0);
    this.renderEditor();
  }

  snapshot(): void {
    this.undoStack.push({
      content: this.resultContent,
      blocks: this.blocks.map(block => ({ ...block })),
      activeBlockIndex: this.activeBlockIndex
    });
    if (this.undoStack.length > 30) this.undoStack.shift();
    const undoButton = document.getElementById('conflict-undo')! as HTMLButtonElement | null;
    if (undoButton) undoButton.disabled = false;
  }

  undo(): void {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.resultContent = snapshot.content;
    this.blocks = snapshot.blocks;
    this.activeBlockIndex = Math.min(snapshot.activeBlockIndex, Math.max(0, this.blocks.length - 1));
    this.manualEdited = false;
    this.dirty = true;
    this.blockCounts.set(this.currentPath!, this.blocks.length);
    const undoButton = document.getElementById('conflict-undo')! as HTMLButtonElement | null;
    if (undoButton) undoButton.disabled = this.undoStack.length === 0;
    this.renderEditor();
  }

  applyBlockChoice(choice: string): void {
    const block = this.blocks[this.activeBlockIndex];
    if (!block) return;
    if (choice === 'ignore') {
      this.jumpToBlock(this.activeBlockIndex + 1);
      return;
    }
    this.snapshot();
    const eol = this.current!.eol === 'crlf' ? '\r\n' : '\n';
    const currentStr = block.current ?? null;
    const incomingStr = block.incoming ?? null;
    let replacement: string | null;
    if (choice === 'current') replacement = currentStr;
    else if (choice === 'incoming') replacement = incomingStr;
    else if (choice === 'smart') replacement = block.smartCombination ?? null;
    else replacement = `${currentStr ?? ''}${(currentStr?.endsWith(eol)) ? eol : ''}${incomingStr ?? ''}`;
    if (replacement === null) return;

    const removedLength = block.endOffset - block.startOffset;
    this.resultContent =
      this.resultContent.slice(0, block.startOffset) +
      replacement +
      this.resultContent.slice(block.endOffset);
    const delta = replacement.length - removedLength;
    this.blocks.splice(this.activeBlockIndex, 1);
    for (let index = this.activeBlockIndex; index < this.blocks.length; index += 1) {
      this.blocks[index].startOffset += delta;
      this.blocks[index].endOffset += delta;
    }
    this.activeBlockIndex = Math.min(this.activeBlockIndex, Math.max(0, this.blocks.length - 1));
    this.dirty = true;
    this.blockCounts.set(this.currentPath!, this.blocks.length);
    this.renderEditor();
  }

  refreshResultGutter(textarea: HTMLTextAreaElement, gutter: Element | null): void {
    const count = Math.max(1, textarea.value.split(/\r?\n/).length);
    if (gutter) gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
  }

  canMarkResolved(): boolean {
    if (!this.current) return false;
    if (this.current!.binary) return Boolean(this.pendingBinaryStrategy);
    return (this.blocks.length === 0 || this.manualEdited) && !this.hasConflictMarkers();
  }

  hasConflictMarkers(): boolean {
    return /^(?:<<<<<<<|>>>>>>>)(?:\s|$)/m.test(this.resultContent);
  }

  updateMarkButton(): void {
    const button = document.getElementById('conflict-mark-resolved')! as HTMLButtonElement | null;
    if (button) button.disabled = !this.canMarkResolved();
  }

  async markResolved(): Promise<void> {
    if (!this.canMarkResolved()) {
      this.app.showToast(t('conflicts.unresolvedWarning'), 'warning');
      return;
    }
    if (!await this.confirm(t('conflicts.markResolved'), t('conflicts.markResolvedConfirm'))) return;
    const strategy = this.current!.binary ? (this.pendingBinaryStrategy ?? 'manual') : 'manual';
    await this.resolve(strategy, this.resultContent);
  }

  async resolve(strategy: string, content = ''): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || !this.currentPath) return;
    const result = await window.gitTree.resolveConflict(repo.path, this.currentPath, {
      strategy,
      snapshotId: this.current!.snapshotId,
      ...(strategy === 'manual' ? { content } : {})
    }) as { error?: string; state?: OperationStateInfo };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      if (/changed externally/i.test(result.error)) await this.loadFile(this.currentPath);
      return;
    }
    const resolvedPath = this.currentPath;
    const nextConflicts = result.state?.conflicts || [];
    this.allFiles = [...new Set([...this.allFiles, ...nextConflicts])];
    for (const file of nextConflicts) {
      if (!this.blockCounts.has(file)) this.blockCounts.set(file, null);
    }
    this.blockCounts.set(resolvedPath, 0);
    this.state = result.state ?? null;
    this.currentPath = nextConflicts[0] || null;
    this.current = null;
    this.dirty = false;
    this.undoStack = [];
    const remaining = this.remainingFiles().length;
    if (remaining) {
      this.app.showToast(t('conflicts.fileResolvedToast', {
        file: resolvedPath.split(/[\\/]/).pop(),
        remaining
      }), 'success');
    } else {
      this.app.showToast(t('conflicts.allFilesResolved'), 'success');
    }
    if (this.state?.type) {
      this.render();
      this.updateBanner();
      if (this.currentPath) await this.loadFile(this.currentPath);
    } else {
      // No more conflicts but operation still pending (needs continue)
      this.render();
      this.updateBanner();
      const editor = document.getElementById('conflict-editor');
      if (editor) editor.innerHTML = `<div class="empty-state">${this.esc(t('conflicts.readyContinue'))}<br><button class="btn btn-primary" id="conflict-ready-continue" style="margin-top:12px"><i class="ph ph-check"></i>${this.esc(this.pushAfter ? t('conflicts.continueAndPush') : t('common.continue'))}</button></div>`;
      document.getElementById('conflict-ready-continue')?.addEventListener('click', () => this.continue());
    }
  }

  async continue(): Promise<void> {
    if (this.state?.conflicts?.length) return;
    const repo = this.app.state.repo;
    if (!repo) return;
    const pushContext = this.pushAfter;
    const result = await window.gitTree.continueOperation(repo!.path) as { error?: string };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      const state = await window.gitTree.getOperationState(repo!.path) as OperationStateInfo;
      if (state?.type) await this.open(state);
      return;
    }
    this.hide();
    if (pushContext) {
      this.app.showToast(t('mergeWorkspace.pushing'), 'info');
      const pushResult = await window.gitTree.push(
        repo.path,
        pushContext.remote,
        pushContext.branch,
        true
      ) as { error?: string };
      if (pushResult?.error) {
        this.app.showToast(t('mergeWorkspace.pushFailed', { error: pushResult.error }), 'error');
      } else {
        this.app.showToast(t('mergeWorkspace.mergeAndPushCompleted'), 'success');
      }
      this.pushAfter = null;
    } else {
      this.app.showToast(t('conflicts.completed'), 'success');
    }
    this.app.emit('refresh');
  }

  async abort(): Promise<void> {
    if (!await this.confirm(t('conflicts.abortTitle'), t('conflicts.abortConfirm'))) return;
    const repo = this.app.state.repo;
    const result = await window.gitTree.abortOperation(repo!.path) as { error?: string };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      return;
    }
    this.pushAfter = null;
    this.hide();
    this.app.emit('refresh');
  }

  async skip(): Promise<void> {
    if (!await this.confirm(t('conflicts.skipTitle'), t('conflicts.skipConfirm'))) return;
    const repo = this.app.state.repo;
    const result = await window.gitTree.skipOperation(repo!.path) as { error?: string; state?: OperationStateInfo };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      return;
    }
    if (result.state?.type) {
      await this.open(result.state);
      return;
    }
    this.hide();
    this.app.emit('refresh');
  }

  bindGlobalKeys(): void {
    if (this.globalKeysHandler) {
      document.removeEventListener('keydown', this.globalKeysHandler);
    }
    this.globalKeysHandler = event => {
      if (event.key === 'Escape' && !this.container.classList.contains('is-hidden')) {
        // Esc on fullscreen should minimize, not abort
        const target = event.target as HTMLElement;
        if (target.closest?.('input, textarea')) return;
        event.preventDefault();
        this.minimize();
        return;
      }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const target = event.target;
        if (target === document.getElementById('conflict-result-editor')!) return;
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        this.jumpToBlock(this.activeBlockIndex + direction);
      }
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !this.manualEdited) {
        const choice = ({ c: 'current', i: 'incoming', b: 'both' } as Record<string, string>)[event.key.toLowerCase()];
        if (choice && !(event.target as HTMLElement).closest?.('textarea, input')) {
          event.preventDefault();
          this.applyBlockChoice(choice);
        }
      }
    };
    document.addEventListener('keydown', this.globalKeysHandler);
  }

  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    return this.confirm(t('conflicts.discardTitle'), t('conflicts.discardConfirm')) as Promise<boolean>;
  }

  confirm(title: string, message: string): Promise<unknown> {
    return this.app.dialogs.confirm({
      title,
      message,
      cancelLabel: t('common.cancel'),
      actionLabel: t('common.continue'),
      danger: true
    });
  }

  hide(): void {
    this.container!.classList.add('is-hidden');
    this.container!.innerHTML = '';
    this.state = null;
    this.current = null;
    this.dirty = false;
    this.pushAfter = null;
    this.minimized = false;
    if (this.reparseTimer) clearTimeout(this.reparseTimer);
    if (this.globalKeysHandler) {
      document.removeEventListener('keydown', this.globalKeysHandler);
      this.globalKeysHandler = null;
    }
    if (this.closeResolveAllMenu) {
      document.removeEventListener('click', this.closeResolveAllMenu);
      this.closeResolveAllMenu = null;
    }
    this.updateBanner();
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { ConflictResolver: typeof ConflictResolver }).ConflictResolver = ConflictResolver;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ConflictResolver;
}

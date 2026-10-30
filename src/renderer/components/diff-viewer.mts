import type { GitTreeApp } from '../app.mts';
import { isAgentsFeatureEnabled } from '../ai-feature-gate.mts';
import { DiffRenderer, type DiffMode } from './diff-renderer.mts';
import { DiffParser, type DiffFileSummary, type SplitRow } from './diff-parser.mts';
import { InspectorPanel } from './inspector-panel.mts';

interface CommitDetail {
  error?: string;
  diff?: string;
  message?: string;
  hash?: string;
  author_name?: string;
  date?: string;
}

export class DiffViewer {
  body: HTMLElement;
  app: GitTreeApp;
  mode: string;
  modeBeforeExpanded: string | null;
  inspectorExpanded: boolean;
  currentDiff: string | null;
  fileSummaries: Array<{ path: string; oldPath: string | null; status: string; additions: number; deletions: number }>;
  selectedFilePath: string | null;
  activeRepoPath: string | null;
  activeHash: string | null;
  wordLevel: boolean;
  renderer: DiffRenderer;
  panel: InspectorPanel;
  /** Increments per request so an older commit cannot overwrite a newer one. */
  detailRequest: number;

  constructor(bodyEl: HTMLElement, app: GitTreeApp, panel: InspectorPanel | null = null) {
    this.body = bodyEl;
    this.app = app;
    this.panel = panel ?? new InspectorPanel({
      panel: null,
      title: document.getElementById('detail-title')!,
      body: bodyEl
    });
    const savedMode = localStorage.getItem('gittree.diff.mode');
    this.mode = savedMode === 'unified' || savedMode === 'split' ? savedMode : 'unified';
    this.modeBeforeExpanded = null;
    this.inspectorExpanded = false;
    this.currentDiff = null;
    this.fileSummaries = [];
    this.selectedFilePath = null;
    this.activeRepoPath = null;
    this.activeHash = null;
    this.detailRequest = 0;
    this.renderer = new DiffRenderer({
      body: bodyEl,
      translate: t,
      createFileActions: path => this.createFileActions(path)
    });

    const savedPad = localStorage.getItem('gittree.diff.gutterPad');
    if (savedPad) document.documentElement.style.setProperty('--diff-gutter-pad', savedPad + 'px');

    this.wordLevel = localStorage.getItem('gittree.diff.wordLevel') !== '0';

    document.getElementById('btn-diff-unified')!.onclick = () => this.setMode('unified');
    document.getElementById('btn-diff-split')!.onclick = () => this.setMode('split');
    document.getElementById('btn-diff-word')!.onclick = () => {
      this.wordLevel = !this.wordLevel;
      localStorage.setItem('gittree.diff.wordLevel', this.wordLevel ? '1' : '0');
      this.syncModeButtons();
      if (this.currentDiff) this.render(this.currentDiff);
      this.app.pushInspectorPayload?.();
    };
    this.syncModeButtons();
  }

  setMode(mode: string, options: { persist?: boolean } = {}): void {
    if (!['unified', 'split'].includes(mode)) return;
    this.mode = mode;
    if (options.persist !== false) {
      localStorage.setItem('gittree.diff.mode', mode);
      if (this.inspectorExpanded) this.modeBeforeExpanded = null;
    }
    this.syncModeButtons();
    if (this.currentDiff) this.render(this.currentDiff);
    this.app.pushInspectorPayload?.();
  }

  syncModeButtons(): void {
    const unifiedButton = document.getElementById('btn-diff-unified')!;
    const splitButton = document.getElementById('btn-diff-split')!;
    const wordButton = document.getElementById('btn-diff-word')!;
    unifiedButton.classList.toggle('active', this.mode === 'unified');
    unifiedButton.setAttribute('aria-pressed', String(this.mode === 'unified'));
    splitButton.classList.toggle('active', this.mode === 'split');
    splitButton.setAttribute('aria-pressed', String(this.mode === 'split'));
    wordButton?.classList.toggle('active', this.wordLevel);
    wordButton?.setAttribute('aria-pressed', String(this.wordLevel));
  }

  setInspectorExpanded(expanded: boolean): void {
    const nextExpanded = Boolean(expanded);
    if (nextExpanded === this.inspectorExpanded) return;
    this.inspectorExpanded = nextExpanded;
    if (nextExpanded) {
      this.modeBeforeExpanded = this.mode;
      this.setMode('split', { persist: false });
    } else if (this.modeBeforeExpanded) {
      const previousMode = this.modeBeforeExpanded;
      this.modeBeforeExpanded = null;
      this.setMode(previousMode, { persist: false });
    }
  }

  /**
   * Forgets the commit when another view takes over the inspector, so layout
   * toggles and late responses can no longer render it over that content.
   */
  releaseCommit(): void {
    this.detailRequest += 1;
    this.renderer.reset();
    this.currentDiff = null;
    this.fileSummaries = [];
    this.selectedFilePath = null;
    this.activeRepoPath = null;
    this.activeHash = null;
    this.syncCommitMeta();
  }

  /** Loads and renders one commit; resolves false when a newer request won. */
  async showDiffForCommit(repoPath: string, hash: string): Promise<boolean> {
    const request = ++this.detailRequest;
    this.activeRepoPath = repoPath;
    this.activeHash = hash;
    const compactTitle = t('details.changesIn', { hash: hash.substring(0, 7) });
    this.panel.present('commit', { title: compactTitle });
    this.currentDiff = null;
    this.fileSummaries = [];
    this.selectedFilePath = null;
    this.syncCommitMeta({ hash });
    this.renderer.renderPlaceholder('ph-circle-notch', t('details.loading'));
    this.app.syncInspectorWorkspace?.({ push: false });
    try {
      const detail = await window.gitTree.getCommitDetail(repoPath, hash) as CommitDetail;
      if (request !== this.detailRequest) return false;
      if (detail?.error) {
        this.renderer.renderPlaceholder(null, detail.error);
        return true;
      }
      this.currentDiff = detail.diff ?? null;
      const subject = String(detail.message || '').split(/\r?\n/)[0].trim();
      this.panel.setTitle(subject || compactTitle, detail.message || compactTitle);
      this.render(detail.diff ?? '');
      this.fileSummaries = this.summaries(this.renderer.files);
      this.syncCommitMeta(detail, this.fileSummaries.length);
      return true;
    } catch (e) {
      if (request !== this.detailRequest) return false;
      this.renderer.renderPlaceholder(null, (e as Error).message);
      return true;
    }
  }

  syncCommitMeta(detail: Partial<CommitDetail> | null = null, fileCount: number | null = null): void {
    const meta = document.getElementById('detail-meta')!;
    if (!meta) return;
    const hash = detail?.hash || '';
    document.getElementById('detail-hash')!.textContent = hash ? hash.slice(0, 7) : '';
    document.getElementById('detail-author')!.textContent = detail?.author_name || '';
    document.getElementById('detail-date')!.textContent = detail?.date
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(detail.date))
      : '';
    const count = fileCount ?? (typeof detail?.diff === 'string'
      ? (detail.diff.match(/^diff --git /gm) || []).length
      : 0);
    document.getElementById('detail-files')!.textContent = count
      ? t('details.files', { count })
      : '';
    meta.classList.toggle('is-hidden', !hash);
  }

  render(diffText: string): void {
    this.renderer.render(diffText, {
      mode: this.mode as DiffMode,
      wordLevel: this.wordLevel,
      expanded: this.inspectorExpanded
    });
  }

  renderPlaceholder(icon: string | null, text: string): void {
    this.renderer.renderPlaceholder(icon, text);
  }

  parseSplitRows(diffText: string): SplitRow[] {
    return DiffParser.parseSplit(diffText);
  }

  extractPath(line: string): string | null {
    return this.renderer.extractPath(line);
  }

  createFileActions(path: string): HTMLElement[] {
    if (!this.activeRepoPath || !this.activeHash || !isAgentsFeatureEnabled()) return [];
    const blameButton = document.createElement('button');
    blameButton.type = 'button';
    blameButton.className = 'diff-file-blame';
    blameButton.title = t('details.aiBlame');
    blameButton.setAttribute('aria-label', t('details.aiBlame'));
    const icon = document.createElement('i');
    icon.className = 'ph ph-sparkle';
    icon.setAttribute('aria-hidden', 'true');
    blameButton.appendChild(icon);
    blameButton.onclick = event => {
      event.stopPropagation();
      this.openBlameDialog(path);
    };
    return [blameButton];
  }

  async openBlameDialog(filePath: string): Promise<unknown> {
    const repoPath = this.activeRepoPath;
    const hash = this.activeHash;
    if (!repoPath || !hash) return undefined;
    const overlay = document.getElementById('modal-overlay')!;
    const dialog = document.getElementById('modal-dialog')!;
    dialog.className = 'confirm-dialog ai-blame-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
      <div class="ai-explain-loading">
        <i class="ph ph-circle-notch" aria-hidden="true"></i>
        <span>${this.esc(t('details.aiExplaining'))}</span>
      </div>`;
    overlay.classList.remove('is-hidden');
    const language = await this.aiLanguage().catch(() => 'en');
    return new Promise(resolve => {
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
      Promise.allSettled([
        window.gitTree.getBlame(repoPath, filePath, hash),
        window.gitTree.explainLines(repoPath, { file: filePath, hash, language })
      ]).then(([blameResult, explainResult]) => {
        if (settled) return;
        const blameValue = blameResult.status === 'fulfilled'
          ? blameResult.value as { error?: string; rows?: Array<{ hash?: string; author?: string; summary?: string }> } | undefined
          : undefined;
        const explanation = explainResult.status === 'fulfilled'
          ? explainResult.value as { error?: string; summary?: string; body?: string } | null
          : null;
        const blame = blameResult.status === 'fulfilled' && !blameValue?.error
          ? (blameValue?.rows || []).slice(0, 30)
          : [];
        if (explanation?.error) {
          finish(null);
          this.app.showToast(explanation.error, 'error');
          return;
        }
        if (!explanation) {
          finish(null);
          this.app.showToast(t('common.error'), 'error');
          return;
        }
        const rows = blame.map(row => `
          <div class="ai-blame-row">
            <code>${this.esc(String(row.hash || '').slice(0, 7))}</code>
            <span class="ai-blame-author">${this.esc(row.author || '')}</span>
            <span class="ai-blame-summary">${this.esc(row.summary || '')}</span>
          </div>`).join('');
        dialog.innerHTML = `
          <div class="ai-explain-result">
            <span class="eyebrow">${this.esc(filePath)} · ${this.esc(hash.slice(0, 7))}</span>
            <h3>${this.esc(explanation.summary || '')}</h3>
            <div class="ai-explain-body">${this.esc(explanation.body || '')}</div>
            ${rows ? `<div class="ai-blame-list">${rows}</div>` : ''}
            <div class="confirm-actions">
              <button class="btn btn-primary" type="button" data-close>${this.esc(t('common.cancel'))}</button>
            </div>
          </div>`;
        dialog!.querySelector<HTMLElement>('[data-close]')!.onclick = () => finish(null);
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

  extractFileSummaries(diffText: string): DiffViewer['fileSummaries'] {
    return this.summaries(DiffParser.summarizeFiles(DiffParser.parseUnified(diffText || '')).files);
  }

  summaries(files: DiffFileSummary[]): DiffViewer['fileSummaries'] {
    return files.map(({ path, oldPath, status, additions, deletions }) => ({
      path, oldPath, status, additions, deletions
    }));
  }

  scrollToFile(path: string): boolean {
    if (!this.renderer.scrollToFile(path)) return false;
    this.selectedFilePath = path;
    this.app.components?.inspectorWorkspace?.setSelectedFile(path);
    return true;
  }

  esc(value: unknown): string { return HtmlEncoder.encode(value); }

  clear(): void {
    this.detailRequest += 1;
    this.currentDiff = null;
    this.fileSummaries = [];
    this.selectedFilePath = null;
    this.activeRepoPath = null;
    this.activeHash = null;
    this.renderer.renderPlaceholder('ph-cursor-click', t('details.placeholder'));
    this.panel.present('empty', { title: t('details.title'), tooltip: '' });
    this.syncCommitMeta();
    this.app.syncInspectorWorkspace?.();
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { DiffViewer: typeof DiffViewer }).DiffViewer = DiffViewer;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = DiffViewer;
}

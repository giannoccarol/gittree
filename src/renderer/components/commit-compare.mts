import type { GitTreeApp } from '../app.mts';

interface CompareFile {
  path: string;
  status: string;
  oldPath?: string;
}

interface CommitComparison {
  error?: string;
  files?: CompareFile[];
}

import type { NumberableHunk } from './diff-parser.mts';

interface CommitFileDiff {
  error?: string;
  binary?: boolean;
  hunks?: Array<NumberableHunk & { header: string }>;
}


export class CommitCompare {
  app: GitTreeApp;
  hashA: string | null;
  hashB: string | null;
  data: CommitComparison | null;
  selectedFile: string | null;
  container: HTMLElement | null;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.hashA = null;
    this.hashB = null;
    this.data = null;
    this.selectedFile = null;
    this.container = null;
  }

  async open(hashA: string, hashB: string): Promise<void> {
    this.hashA = hashA;
    this.hashB = hashB;
    this.selectedFile = null;
    const repo = this.app.state.repo;
    if (!repo) return;

    this.ensureContainer();
    this.showLoading();

    try {
      const comparison = await window.gitTree.compareCommits(repo.path, hashA, hashB) as CommitComparison;
      if (comparison?.error) throw new Error(comparison.error);
      this.data = comparison;
      this.render();
    } catch (e) {
      this.app.showToast('Error comparing commits: ' + (e as Error).message, 'error');
      this.hide();
    }
  }

  ensureContainer(): void {
    this.container = document.getElementById('merge-workspace-overlay')!;
  }

  showLoading(): void {
    this.container!.classList.remove('is-hidden');
    this.container!.innerHTML = `<div class="empty-state"><i class="ph ph-circle-notch"></i>${t('commitCompare.loading')}</div>`;
  }

  hide(): void {
    this.container!.classList.add('is-hidden');
    this.container!.innerHTML = '';
    this.data = null;
  }

  render(): void {
    if (!this.data) return;
    const files = this.data.files || [];

    this.container!.innerHTML = `
      <div class="commit-compare">
        <div class="commit-compare-header">
          <div class="commit-compare-direction">
            <span class="badge badge-head">${this.esc(this.hashA!.slice(0, 8))}</span>
            <i class="ph ph-arrow-right commit-compare-arrow"></i>
            <span class="badge badge-branch">${this.esc(this.hashB!.slice(0, 8))}</span>
          </div>
          <div class="commit-compare-stat">
            <span class="commit-compare-stat-value">${files.length}</span>
            <span class="commit-compare-stat-label">${t('commitCompare.filesChanged')}</span>
          </div>
          <button class="btn btn-small commit-compare-close" id="commit-compare-close">
            <i class="ph ph-x"></i>${t('commitCompare.close')}
          </button>
        </div>
        <div class="commit-compare-body">
          <div class="commit-compare-files">
            ${files.length ? files.map((f, i) => this.fileRow(f, i)).join('') : `<div class="diff-placeholder"><i class="ph ph-check-circle"></i>${t('commitCompare.noDiff')}</div>`}
          </div>
          <div class="commit-compare-diff" id="commit-compare-diff">
            <div class="diff-placeholder"><i class="ph ph-cursor-click"></i>${t('commitCompare.selectFile')}</div>
          </div>
        </div>
      </div>
    `;
    this.container!.classList.remove('is-hidden');

    document.getElementById('commit-compare-close')!.onclick = () => this.hide();
    this.container!.querySelectorAll<HTMLElement>('.commit-compare-file-item').forEach(item => {
      item.onclick = () => this.selectFile((item as HTMLElement).dataset.path ?? '', item as HTMLElement);
    });
  }

  fileRow(file: CompareFile, index: number): string {
    const statusClass = ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed' } as Record<string, string>)[file.status] || 'modified';
    const displayName = file.oldPath ? `${file.oldPath} \u203A ${file.path}` : file.path;
    return `
      <div class="commit-compare-file-item" data-path="${this.esc(file.path)}" data-index="${index}">
        <span class="commit-compare-file-status ${statusClass}">${this.esc(file.status)}</span>
        <span class="commit-compare-file-name" title="${this.esc(displayName)}">${this.esc(file.path.split('/').pop())}</span>
        <span class="commit-compare-file-path">${this.esc(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '')}</span>
      </div>
    `;
  }

  async selectFile(filePath: string, element?: HTMLElement): Promise<void> {
    this.container!.querySelectorAll('.commit-compare-file-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');
    this.selectedFile = filePath;

    const diffEl = document.getElementById('commit-compare-diff')!;
    diffEl.innerHTML = `<div class="diff-placeholder"><i class="ph ph-circle-notch"></i>${t('common.loading')}</div>`;

    try {
      const repo = this.app.state.repo;
      const diff = await window.gitTree.getCommitFileDiff(repo!.path, this.hashA, this.hashB, filePath) as CommitFileDiff;
      if (diff?.error) {
        diffEl.innerHTML = `<div class="diff-placeholder">${this.esc(diff.error)}</div>`;
        return;
      }
      this.renderDiff(diffEl, diff);
    } catch (e) {
      diffEl.innerHTML = `<div class="diff-placeholder">${this.esc((e as Error).message)}</div>`;
    }
  }

  renderDiff(container: HTMLElement, diff: CommitFileDiff): void {
    container.innerHTML = '';
    if (diff.binary) {
      container.innerHTML = `<div class="diff-placeholder"><i class="ph ph-file-lock"></i>${t('commitCompare.binaryFile')}</div>`;
      return;
    }
    if (!diff.hunks?.length) {
      container.innerHTML = `<div class="diff-placeholder"><i class="ph ph-check-circle"></i>${t('commitCompare.noDiff')}</div>`;
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'commit-compare-diff-content';
    const numberedHunks = diff.hunks.map(hunk => ({
      hunk,
      lines: DiffParser.numberHunk(hunk)
    }));
    const allLines = numberedHunks.flatMap(item => item.lines);
    wrapper.style.setProperty('--diff-gutter-digits', String(DiffParser.maxDigits(allLines)));

    numberedHunks.forEach(({ hunk, lines }) => {
      const section = document.createElement('section');
      section.className = 'commit-compare-hunk';
      const header = document.createElement('div');
      header.className = 'commit-compare-hunk-header';
      const code = document.createElement('code');
      code.textContent = hunk.header;
      header.appendChild(code);
      section.appendChild(header);

      lines.forEach(line => {
        const row = document.createElement('div');
        row.className = `diff-line ${line.kind}`;
        const oldNum = document.createElement('span');
        oldNum.className = 'diff-line-num is-old';
        oldNum.textContent = Number.isInteger(line.oldLine) ? String(line.oldLine) : '';
        const newNum = document.createElement('span');
        newNum.className = 'diff-line-num is-new';
        newNum.textContent = Number.isInteger(line.newLine) ? String(line.newLine) : '';
        const content = document.createElement('span');
        content.className = 'diff-line-content';
        content.textContent = line.content;
        row.append(oldNum, newNum, content);
        section.appendChild(row);
      });
      wrapper.appendChild(section);
    });
    container.appendChild(wrapper);
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { CommitCompare: typeof CommitCompare }).CommitCompare = CommitCompare;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = CommitCompare;
}

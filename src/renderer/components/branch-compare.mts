
import type { GitTreeApp } from '../app.mts';

interface CompareCommit {
  hash: string;
  message: string;
  author_name: string;
  date: string;
}

interface BranchCompareData {
  source: string;
  target: string;
  commitsCount: number;
  commits: CompareCommit[];
  diff: string;
}

export class BranchCompare {
  app: GitTreeApp;
  sourceBranch: string | null;
  targetBranch: string | null;
  data: BranchCompareData | null;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.sourceBranch = null;
    this.targetBranch = null;
    this.data = null;
  }

  async compare(source: string, target: string): Promise<void> {
    this.sourceBranch = source;
    this.targetBranch = target;
    const repo = this.app.state.repo;
    if (!repo) return;

    try {
      const comparison = await window.gitTree.compareBranches(repo.path, target, source) as {
        error?: string;
        commits?: CompareCommit[];
        diff?: string;
      };
      if (comparison?.error) throw new Error(comparison.error);

      this.data = {
        source, target,
        commitsCount: comparison.commits?.length || 0,
        commits: comparison.commits || [],
        diff: comparison.diff || ''
      };

      this.showCompareView();
    } catch (e) {
      this.app.showToast('Error comparing branches: ' + (e as Error).message, 'error');
    }
  }

  showCompareView(): void {
    if (!this.data) return;

    const mainView = document.getElementById('merge-workspace-overlay')!;
    mainView.innerHTML = `
      <div class="branch-compare">
        <div class="compare-header">
          <div class="compare-selector">
            <span class="badge badge-branch">${this.esc(this.data.source)}</span>
            <i class="ph ph-arrow-right compare-arrow"></i>
            <span class="badge badge-remote">${this.esc(this.data.target)}</span>
          </div>
          <button class="btn btn-small compare-back" id="compare-close">
            <i class="ph ph-arrow-left"></i>
            ${this.esc(t('compare.backToHistory'))}
          </button>
        </div>
        <div class="compare-summary">
          <div class="compare-stat">
            <div class="compare-stat-value">${this.data.commitsCount}</div>
            <div class="compare-stat-label">${this.esc(t('compare.commitsAhead'))}</div>
          </div>
        </div>
        <div class="compare-body">
          <div class="compare-commits-list">
            ${this.data.commits.map(c => `
              <div class="compare-commit-item" data-hash="${this.esc(c.hash)}">
                <span class="compare-commit-hash">${c.hash.substring(0,7)}</span>
                <span class="compare-commit-message">${this.esc(c.message.split('\n')[0])}</span>
                <span class="compare-commit-author">${this.esc(c.author_name)}</span>
                <span class="compare-commit-date">${this.fmtDate(c.date)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    mainView.classList.remove('is-hidden');
    document.getElementById('compare-close')!.onclick = () => {
      mainView.classList.add('is-hidden');
      mainView.innerHTML = '';
    };
    mainView.querySelectorAll<HTMLElement>('.compare-commit-item[data-hash]').forEach(item => {
      item.onclick = () => this.app.emit('commit:selected', (item as HTMLElement).dataset.hash);
    });
  }

  esc(value: unknown): string { return HtmlEncoder.encode(value); }
  fmtDate(d: unknown): string {
    if (!d) return '';
    const dt = new Date(d as string);
    return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async compareMatrix(branches: Array<{ name: string }>): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || branches.length < 2) return;

    const mainView = document.getElementById('merge-workspace-overlay')!;
    mainView.classList.remove('is-hidden');
    mainView.innerHTML = `<div class="empty-state"><i class="ph ph-circle-notch"></i>${t('common.loading')}</div>`;

    const names = branches.map(b => b.name);
    const matrix: Array<Array<{ error?: string; commits?: number } | null>> = [];

    try {
      for (let i = 0; i < names.length; i += 1) {
        matrix[i] = [];
        for (let j = 0; j < names.length; j += 1) {
          if (i === j) { matrix[i][j] = null; continue; }
          const comparison = await window.gitTree.compareBranches(repo.path, names[i], names[j]) as {
            error?: string;
            commits?: CompareCommit[];
          };
          matrix[i][j] = comparison?.error ? { error: comparison.error } : {
            commits: comparison.commits?.length || 0
          };
        }
      }

      mainView.innerHTML = `
        <div class="branch-compare">
          <div class="compare-header">
            <div class="compare-selector">
              <span class="compare-label">${this.esc(t('sidebar.batchCompare'))}</span>
              <span class="badge badge-branch">${names.length} branches</span>
            </div>
            <button class="btn btn-small compare-back" id="compare-matrix-close">
              <i class="ph ph-arrow-left"></i>
              ${this.esc(t('compare.back'))}
            </button>
          </div>
          <div class="compare-body">
            <div class="compare-matrix-wrap">
              <table class="compare-matrix">
                <thead>
                  <tr>
                    <th></th>
                    ${names.map(n => `<th>${this.esc(n)}</th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${names.map((rowName, i) => `
                    <tr>
                      <th>${this.esc(rowName)}</th>
                      ${names.map((_, j) => {
                        if (i === j) return '<td class="compare-matrix-self">\u2014</td>';
                        const cell = matrix[i][j];
                        if (cell?.error) return `<td class="compare-matrix-error">!</td>`;
                        return `<td class="compare-matrix-cell" data-row="${i}" data-col="${j}">${cell!.commits}</td>`;
                      }).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;

      document.getElementById('compare-matrix-close')!.onclick = () => {
        mainView.classList.add('is-hidden');
        mainView.innerHTML = '';
      };
      mainView.querySelectorAll<HTMLElement>('.compare-matrix-cell').forEach(cell => {
        cell.onclick = () => {
          const row = Number((cell as HTMLElement).dataset.row);
          const col = Number((cell as HTMLElement).dataset.col);
          mainView.classList.add('is-hidden');
          mainView.innerHTML = '';
          this.compare(names[col], names[row]);
        };
      });
    } catch (e) {
      this.app.showToast('Error comparing branches: ' + (e as Error).message, 'error');
      mainView.classList.add('is-hidden');
      mainView.innerHTML = '';
    }
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { BranchCompare: typeof BranchCompare }).BranchCompare = BranchCompare;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = BranchCompare;
}

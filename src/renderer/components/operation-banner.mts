import type { GitTreeApp } from '../app.mts';
import type { OperationStateInfo } from './conflict-resolver.mts';

export interface OperationBannerState {
  operation: OperationStateInfo | null;
}

export class OperationBanner {
  app: GitTreeApp;
  container: HTMLElement | null;
  state: OperationBannerState;
  onHide: (() => void) | null;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.container = null;
    this.state = { operation: null };
    this.onHide = null;
  }

  mount(): void {
    this.container = document.getElementById('operation-banner') as HTMLElement | null;
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'operation-banner';
      this.container.className = 'operation-banner is-hidden';
      const workspace = document.getElementById('workspace');
      const commandBar = document.querySelector('.workspace-command-bar');
      if (workspace && commandBar) {
        commandBar.after(this.container);
      } else if (workspace) {
        workspace.prepend(this.container);
      } else {
        document.getElementById('app')?.appendChild(this.container);
      }
    }
    this.update(this.state);
  }

  update(state: Partial<OperationBannerState>): void {
    this.state = { ...this.state, ...state };
    if (!this.container) this.mount();
    this.render();
  }

  setOperation(operation: OperationStateInfo | null): void {
    this.update({ operation });
  }



  render(): void {
    if (!this.container) return;
    const op = this.state.operation;
    if (!op || !op.type) {
      this.container.classList.add('is-hidden');
      this.container.innerHTML = '';
      return;
    }
    const conflicts = op.conflicts || [];
    const count = conflicts.length;
    const typeLabel = this.labelFor(op.type);
    const detail = count
      ? t('operationBanner.conflictsRemaining', { count } as unknown as Record<string, unknown>)
      : t('operationBanner.readyToContinue', { operation: typeLabel } as unknown as Record<string, unknown>);

    this.container.classList.remove('is-hidden');
    this.container.innerHTML = `
      <div class="operation-banner-card">
        <div class="operation-banner-icon">
          <i class="ph ph-warning-circle" aria-hidden="true"></i>
        </div>
        <div class="operation-banner-content">
          <div class="operation-banner-title">
            <span class="operation-banner-eyebrow">${this.esc(t('operationBanner.eyebrow'))}</span>
            <strong>${this.esc(typeLabel)}</strong>
            <span class="operation-banner-detail">${this.esc(detail)}</span>
          </div>
          ${count ? `<div class="operation-banner-files">${this.esc(conflicts.slice(0, 3).join(', '))}${count > 3 ? ` ${this.esc(t('operationBanner.andMore', { count: count - 3 }))}` : ''}</div>` : ''}
        </div>
        <div class="operation-banner-actions">
          <button class="btn btn-small btn-primary" id="operation-banner-resolve">
            <i class="ph ph-wrench" aria-hidden="true"></i><span>${this.esc(t('operationBanner.resolve'))}</span>
          </button>
          <button class="btn btn-small" id="operation-banner-refresh" title="${this.esc(t('operationBanner.refreshTitle'))}">
            <i class="ph ph-arrows-clockwise" aria-hidden="true"></i><span>${this.esc(t('operationBanner.refresh'))}</span>
          </button>
          <button class="btn btn-small" id="operation-banner-abort">
            <i class="ph ph-x-circle" aria-hidden="true"></i><span>${this.esc(t('operationBanner.abort'))}</span>
          </button>
          <button class="btn-icon operation-banner-close" id="operation-banner-close" aria-label="${this.esc(t('common.close'))}">
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    `;
    const resolveBtn = document.getElementById('operation-banner-resolve');
    if (resolveBtn) resolveBtn.onclick = () => {
      const conflict = this.app.components.conflict as unknown as { container?: HTMLElement; state?: unknown; resume?: () => void; open: (s: unknown) => Promise<void> };
      if (conflict.container && conflict.container.classList.contains('is-hidden') && conflict.state) {
        conflict.resume?.();
      } else {
        this.app.components.conflict.open(op as OperationStateInfo);
      }
    };
    const refreshBtn = document.getElementById('operation-banner-refresh');
    if (refreshBtn) refreshBtn.onclick = () => this.handleRefresh();
    const abortBtn = document.getElementById('operation-banner-abort');
    if (abortBtn) abortBtn.onclick = () => this.app.components.conflict.abort();
    const closeBtn = document.getElementById('operation-banner-close');
    if (closeBtn) closeBtn.onclick = () => this.dismiss();
  }

  async handleRefresh(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo) return;
    const btn = document.getElementById('operation-banner-refresh') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      const icon = btn.querySelector('i');
      if (icon) icon.className = 'ph ph-circle-notch';
    }
    try {
      const state = await window.gitTree.getOperationState(repo.path) as OperationStateInfo;
      if (state?.type) {
        this.setOperation(state);
        // If resolver is currently open, also refresh it
        const resolver = this.app.components.conflict as unknown as { container?: HTMLElement; state?: unknown; refreshFromDisk?: () => Promise<void> };
        if (resolver.container && !resolver.container.classList.contains('is-hidden') && resolver.refreshFromDisk) {
          await resolver.refreshFromDisk();
        } else {
          this.app.showToast(t('operationBanner.refreshed'), 'success');
        }
      } else {
        this.setOperation(null);
        this.app.emit('refresh');
        this.app.showToast(t('operationBanner.noOperation'), 'success');
      }
    } catch (e) {
      this.app.showToast((e as Error).message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'ph ph-arrows-clockwise';
      }
    }
  }

  dismiss(): void {
    this.container?.classList.add('is-hidden');
    if (this.onHide) this.onHide();
  }

  destroy(): void {
    this.container?.remove();
    this.container = null;
  }

  labelFor(type: string): string {
    const map: Record<string, string> = {
      merge: t('conflicts.operation', { operation: 'merge' } as unknown as Record<string, unknown>).replace(' in progress', '').replace(' in corso', '') || 'Merge',
      rebase: 'Rebase',
      'cherry-pick': 'Cherry-pick'
    };
    return map[type] || type;
  }

  esc(value: unknown): string {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { OperationBanner: typeof OperationBanner }).OperationBanner = OperationBanner;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = OperationBanner;
}

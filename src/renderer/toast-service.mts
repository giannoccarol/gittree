export type ToastKind = 'success' | 'warning' | 'error' | 'loading';

export interface ToastTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface ToastDependencies {
  container?: HTMLElement;
  translate?: (key: string) => string;
  encode?: (value: unknown) => string;
  timers?: ToastTimers;
}

const TOAST_ICONS: Record<ToastKind, string> = {
  loading: 'ph-circle-notch',
  success: 'ph-check-circle',
  warning: 'ph-warning',
  error: 'ph-x-circle'
};

const TOAST_DURATIONS: Record<ToastKind, number> = {
  loading: 2500,
  success: 2800,
  warning: 4200,
  error: 5200
};

export class ToastService {
  container: HTMLElement;
  translate: (key: string) => string;
  encode: (value: unknown) => string;
  timers: ToastTimers;
  private timer: ReturnType<typeof setTimeout> | null;
  private remaining: number;
  private startedAt: number;
  private handleMouseEnter: () => void;
  private handleMouseLeave: () => void;

  /**
   * Owns the #toast element lifecycle: show/dismiss/pause/resume with
   * hover-pause semantics. Dependencies are injected; no global reads.
   */
  constructor(dependencies: ToastDependencies = {}) {
    const {
      container,
      translate,
      encode,
      // Timers must keep `window` as receiver: detached, Electron's sandboxed
      // renderer throws "Illegal invocation" and every toast breaks.
      timers = {
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window)
      }
    } = dependencies ?? {};
    this.container = container as HTMLElement;
    this.translate = translate ?? ((key: string) => key);
    this.encode = encode ?? ((value: unknown) => String(value ?? ''));
    this.timers = timers;
    this.timer = null;
    this.remaining = 0;
    this.startedAt = 0;

    this.handleMouseEnter = () => this.pause();
    this.handleMouseLeave = () => this.resume();
  }

  mount(): void {
    this.container.addEventListener('mouseenter', this.handleMouseEnter);
    this.container.addEventListener('mouseleave', this.handleMouseLeave);
  }

  show(message: string, type: string = ''): void {
    const kind: ToastKind = (['success', 'warning', 'error'] as ToastKind[]).includes(type as ToastKind)
      ? type as ToastKind
      : 'loading';
    const duration = TOAST_DURATIONS[kind];

    if (this.timer) this.timers.clearTimeout(this.timer);
    this.container.className = `toast toast-${kind} show`;
    this.container.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    this.container!.innerHTML =
      `<span class="toast-badge" aria-hidden="true"><i class="ph ${TOAST_ICONS[kind]}"></i></span>` +
      `<span class="toast-message"></span>` +
      `<button type="button" class="toast-dismiss" aria-label="${this.encode(this.translate('common.close'))}"><i class="ph ph-x" aria-hidden="true"></i></button>` +
      `<span class="toast-progress" aria-hidden="true"></span>`;
    const messageElement = this.container!.querySelector('.toast-message');
    if (messageElement) messageElement.textContent = message;
    const progress = this.container!.querySelector('.toast-progress') as HTMLElement | null;
    if (progress) progress.style.animationDuration = `${duration}ms`;
    const dismissButton = this.container!.querySelector('.toast-dismiss') as HTMLElement | null;
    if (dismissButton) dismissButton.onclick = () => this.dismiss();

    this.remaining = duration;
    this.startedAt = Date.now();
    if (this.container.matches(':hover')) {
      this.container!.classList.add('paused');
    } else {
      this.timer = this.timers.setTimeout(() => this.dismiss(), duration);
    }
  }

  dismiss(): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.container!.classList.remove('show');
  }

  pause(): void {
    if (!this.container!.classList.contains('show') || this.container!.classList.contains('paused')) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.remaining = Math.max((this.remaining || 0) - (Date.now() - this.startedAt), 0);
    this.container!.classList.add('paused');
  }

  resume(): void {
    if (!this.container!.classList.contains('show') || !this.container!.classList.contains('paused')) return;
    this.container!.classList.remove('paused');
    this.startedAt = Date.now();
    this.timer = this.timers.setTimeout(() => this.dismiss(), Math.max(this.remaining, 800));
  }

  destroy(): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.container.removeEventListener('mouseenter', this.handleMouseEnter);
    this.container.removeEventListener('mouseleave', this.handleMouseLeave);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { ToastService: typeof ToastService }).ToastService = ToastService;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ToastService;
}

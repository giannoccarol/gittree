export interface ResizePanelConfig {
  handle: HTMLElement;
  panel: HTMLElement;
  storageKey: string;
  cssVariable: string;
  direction: number;
  min: number;
  max: number;
}

export interface ResizeDependencies {
  workspace: HTMLElement;
  panels: Record<string, ResizePanelConfig>;
  document: Document;
  storage: Storage;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
}

interface ActiveResize {
  name: string;
  config: ResizePanelConfig;
  startX: number;
  latestX: number;
  startWidth: number;
  paintedWidth: number | null;
  frame: number;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
}

export class WorkspaceResizeController {
  workspace: HTMLElement;
  panels: Record<string, ResizePanelConfig>;
  document: Document;
  storage: Storage;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
  bindings: Map<string, (event: PointerEvent) => void>;
  active: ActiveResize | null;

  constructor({
    workspace,
    panels,
    document: documentRef,
    storage,
    requestFrame,
    cancelFrame
  }: ResizeDependencies) {
    this.workspace = workspace;
    this.panels = panels;
    this.document = documentRef;
    this.storage = storage;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.bindings = new Map();
    this.active = null;
  }

  mount(): void {
    for (const [name, config] of Object.entries(this.panels)) {
      this.restore(config);
      const onPointerDown = (event: PointerEvent) => this.start(name, config, event);
      config.handle.addEventListener('pointerdown', onPointerDown);
      this.bindings.set(name, onPointerDown);
    }
  }

  restore(config: ResizePanelConfig): void {
    const savedWidth = Number(this.storage.getItem(config.storageKey));
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      this.workspace.style.setProperty(config.cssVariable, `${savedWidth}px`);
    }
  }

  start(name: string, config: ResizePanelConfig, event: PointerEvent): void {
    if (event.button != null && event.button !== 0) return;
    if (this.active) this.finish(this.active.latestX, false);
    event.preventDefault();

    const active: ActiveResize = {
      name,
      config,
      startX: event.clientX,
      latestX: event.clientX,
      startWidth: config.panel.getBoundingClientRect().width,
      paintedWidth: null,
      frame: 0,
      onMove: () => undefined,
      onUp: () => undefined,
      onCancel: () => undefined
    };
    active.onMove = moveEvent => this.move(active, moveEvent);
    active.onUp = upEvent => this.finishPointer(active, upEvent, true);
    active.onCancel = cancelEvent => this.finishPointer(active, cancelEvent, false);
    this.active = active;

    config.handle.classList.add('is-dragging');
    this.workspace.classList.add('is-resizing');
    this.document.body.style.cursor = 'col-resize';
    if (event.isTrusted) config.handle.setPointerCapture?.(event.pointerId);

    this.document.addEventListener('pointermove', active.onMove);
    this.document.addEventListener('pointerup', active.onUp);
    this.document.addEventListener('pointercancel', active.onCancel);
  }

  move(active: ActiveResize, event: PointerEvent): void {
    if (this.active !== active) return;
    active.latestX = event.clientX;
    if (!active.frame) {
      active.frame = this.requestFrame(() => {
        active.frame = 0;
        if (this.active === active) this.paint(active);
      });
    }
  }

  calculateWidth(active: Pick<ActiveResize, 'config' | 'startWidth' | 'startX'>, clientX: number): number {
    const { config, startWidth, startX } = active;
    const width = startWidth + ((clientX - startX) * config.direction);
    return Math.round(Math.min(config.max, Math.max(config.min, width)));
  }

  paint(active: ActiveResize): number {
    const width = this.calculateWidth(active, active.latestX);
    if (width === active.paintedWidth) return width;
    active.paintedWidth = width;
    this.workspace.style.setProperty(active.config.cssVariable, `${width}px`);
    return width;
  }

  finishPointer(active: ActiveResize, event: PointerEvent, persist: boolean): void {
    const clientX = Number.isFinite(event.clientX) ? event.clientX : active.latestX;
    this.finish(clientX, persist);
  }

  finish(clientX: number, persist: boolean): void {
    const active = this.active;
    if (!active) return;
    active.latestX = clientX;
    if (active.frame) {
      this.cancelFrame(active.frame);
      active.frame = 0;
    }
    const width = this.paint(active);
    if (persist) this.storage.setItem(active.config.storageKey, String(width));
    this.cleanup(active);
  }

  cleanup(active: ActiveResize): void {
    this.document.removeEventListener('pointermove', active.onMove);
    this.document.removeEventListener('pointerup', active.onUp);
    this.document.removeEventListener('pointercancel', active.onCancel);
    active.config.handle.classList.remove('is-dragging');
    this.workspace.classList.remove('is-resizing');
    this.document.body.style.cursor = '';
    if (this.active === active) this.active = null;
  }

  destroy(): void {
    if (this.active) {
      const active = this.active;
      if (active.frame) this.cancelFrame(active.frame);
      this.cleanup(active);
    }
    for (const [name, listener] of this.bindings) {
      this.panels[name].handle.removeEventListener('pointerdown', listener);
    }
    this.bindings.clear();
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { WorkspaceResizeController: typeof WorkspaceResizeController }).WorkspaceResizeController = WorkspaceResizeController;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = WorkspaceResizeController;
}

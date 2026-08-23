export interface PanelConfig {
  panel: HTMLElement;
  toggle: HTMLElement;
  openingAnimation?: string;
  closingAnimation?: string;
}

export interface PanelMotionDependencies {
  workspace: HTMLElement;
  panels: Record<string, PanelConfig>;
  document: Document;
  prefersReducedMotion?: () => boolean;
}

interface ActiveTransition {
  className: string;
  finish: (event?: AnimationEvent) => void;
}

export class WorkspacePanelMotion {
  workspace: HTMLElement;
  panels: Record<string, PanelConfig>;
  document: Document;
  prefersReducedMotion: () => boolean;
  active: Map<string, ActiveTransition>;

  constructor({ workspace, panels, document: documentRef, prefersReducedMotion = () => false }: PanelMotionDependencies) {
    this.workspace = workspace;
    this.panels = panels;
    this.document = documentRef;
    this.prefersReducedMotion = prefersReducedMotion;
    this.active = new Map();
  }

  transition(name: string, { opening, animate = true, applyState }: { opening: boolean; animate?: boolean; applyState: () => void }): void {
    const config = this.panels[name];
    if (!config) return;
    this.cancel(name);

    if (!opening && config.panel.contains(this.document.activeElement)) {
      config.toggle.focus({ preventScroll: true });
    }

    applyState();
    config.panel.inert = !opening;
    config.panel.setAttribute('aria-hidden', String(!opening));

    if (!animate || this.prefersReducedMotion()) {
      config.panel.dataset.motionState = 'idle';
      return;
    }

    const direction = opening ? 'opening' : 'closing';
    const className = `is-${name}-${direction}`;
    const animationName = config[`${direction}Animation` as keyof PanelConfig] as string | undefined;
    const finish = (event?: AnimationEvent) => {
      if (event && (
        event.target !== config.panel ||
        event.animationName !== animationName
      )) return;
      this.cleanup(name);
    };

    this.workspace.classList.add(className);
    config.panel.dataset.motionState = direction;
    config.panel.addEventListener('animationend', finish as EventListener);
    config.panel.addEventListener('animationcancel', finish as EventListener);
    this.active.set(name, { className, finish });
  }

  cancel(name: string): void {
    if (this.active.has(name)) this.cleanup(name);
  }

  cleanup(name: string): void {
    const active = this.active.get(name);
    const config = this.panels[name];
    if (!active || !config) return;
    config.panel.removeEventListener('animationend', active.finish as EventListener);
    config.panel.removeEventListener('animationcancel', active.finish as EventListener);
    this.workspace.classList.remove(active.className);
    config.panel.dataset.motionState = 'idle';
    this.active.delete(name);
  }

  destroy(): void {
    for (const name of [...this.active.keys()]) this.cleanup(name);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { WorkspacePanelMotion: typeof WorkspacePanelMotion }).WorkspacePanelMotion = WorkspacePanelMotion;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = WorkspacePanelMotion;
}

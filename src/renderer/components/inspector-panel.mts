/**
 * Owns the inspector's shared title and body. Commit details, working-tree
 * file diffs and pull-request details each present their content through it,
 * so the panel always knows what it is showing.
 */
export type InspectorContentKind = 'empty' | 'commit' | 'working-file' | 'pull-request';

export interface InspectorPresentation {
  title: string;
  /** Full text shown on hover when the title is truncated. */
  tooltip?: string;
}

export interface InspectorPanelDependencies {
  panel: HTMLElement | null;
  title: HTMLElement;
  body: HTMLElement;
  onKindChange?: ((next: InspectorContentKind, previous: InspectorContentKind) => void) | null;
}

export class InspectorPanel {
  panel: HTMLElement | null;
  title: HTMLElement;
  body: HTMLElement;
  kind: InspectorContentKind;
  onKindChange: ((next: InspectorContentKind, previous: InspectorContentKind) => void) | null;

  constructor({ panel, title, body, onKindChange = null }: InspectorPanelDependencies) {
    this.panel = panel;
    this.title = title;
    this.body = body;
    this.kind = 'empty';
    this.onKindChange = onKindChange;
  }

  /** Switches the panel to a content kind and returns the body to render into. */
  present(kind: InspectorContentKind, presentation: InspectorPresentation): HTMLElement {
    const previous = this.kind;
    this.kind = kind;
    if (this.panel) this.panel.dataset.inspectorKind = kind;
    this.setTitle(presentation.title, presentation.tooltip ?? presentation.title);
    if (previous !== kind) this.onKindChange?.(kind, previous);
    return this.body;
  }

  setTitle(text: string, tooltip = text): void {
    this.title.textContent = text;
    this.title.title = tooltip;
  }

  isShowing(kind: InspectorContentKind): boolean {
    return this.kind === kind;
  }
}

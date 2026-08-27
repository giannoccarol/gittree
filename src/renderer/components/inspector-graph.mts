interface GraphRowRef {
  type: string;
  shortName?: string;
}

interface GraphRowData {
  hash: string;
  subject?: string;
  lane: number;
  parents?: Array<{ lane: number }>;
  refs?: GraphRowRef[];
  before?: Array<string | null>;
  incoming?: boolean;
}

interface GraphSnapshot {
  rows?: GraphRowData[];
  revision?: number;
  selectedHash?: string | null;
  laneCount?: number;
}

type WindowGraphLayout = {
  createGraphSegments: (
    row: unknown,
    rowHeight: number
  ) => Array<{ lane: number; path: string }>;
};

export interface InspectorGraphDependencies {
  container: HTMLElement | null;
  translate: (key: string) => string;
  onSelect?: ((hash: string) => void) | null;
  onRequestMore?: (() => void) | null;
}

export class InspectorGraph {
  container: HTMLElement | null;
  translate: (key: string) => string;
  onSelect: ((hash: string) => void) | null;
  onRequestMore: (() => void) | null;
  rows: GraphRowData[];
  rowsByHash: Map<string, GraphRowData>;
  laneCount: number;
  selectedHash: string | null;
  revision: number;
  rowHeight: number;
  overscan: number;
  renderedRange: [number, number];
  raf: number;
  mounted: boolean;
  layer: HTMLElement;
  tooltip: HTMLElement;
  resizeObserver: ResizeObserver | null;
  tooltipHash: HTMLElement;
  tooltipBranchLabel: HTMLElement;
  tooltipBranch: HTMLElement;
  tooltipMessageLabel: HTMLElement;
  tooltipMessage: HTMLElement;
  handleScroll: () => void;
  handleClick: (event: MouseEvent) => void;
  handleKeydown: (event: KeyboardEvent) => void;
  handlePointerOver: (event: PointerEvent) => void;
  handlePointerOut: (event: PointerEvent) => void;
  handleFocusIn: (event: FocusEvent) => void;
  handleFocusOut: (event: FocusEvent) => void;

  constructor({ container, translate, onSelect = null, onRequestMore = null }: InspectorGraphDependencies) {
    this.container = container;
    this.translate = translate;
    this.onSelect = onSelect;
    this.onRequestMore = onRequestMore;
    this.rows = [];
    this.rowsByHash = new Map();
    this.laneCount = 1;
    this.selectedHash = null;
    this.revision = -1;
    this.rowHeight = 38;
    this.overscan = 12;
    this.renderedRange = [-1, -1];
    this.raf = 0;
    this.mounted = false;
    this.resizeObserver = null;

    this.layer = document.createElement('div');
    this.layer.className = 'inspector-graph-layer';
    this.tooltip = this.createTooltip();

    this.handleScroll = () => {
      this.hideTooltip();
      this.scheduleViewport();
    };
    this.handleClick = event => {
      const row = (event.target as HTMLElement).closest?.('.inspector-graph-row') as HTMLElement | null;
      if (row?.dataset.hash && this.onSelect) this.select(row.dataset.hash);
    };
    this.handleKeydown = event => {
      const row = (event.target as HTMLElement).closest?.('.inspector-graph-row') as HTMLElement | null;
      if (!row?.dataset.hash) return;
      if ((event.key === 'Enter' || event.key === ' ') && this.onSelect) {
        event.preventDefault();
        this.select(row.dataset.hash);
      } else if (event.key === 'Escape') {
        this.hideTooltip();
      }
    };
    this.handlePointerOver = event => {
      const row = (event.target as HTMLElement).closest?.('.inspector-graph-row') as HTMLElement | null;
      if (!row?.dataset.hash || row.contains(event.relatedTarget as Node)) return;
      this.showTooltip(row.dataset.hash, row);
    };
    this.handlePointerOut = event => {
      const row = (event.target as HTMLElement).closest?.('.inspector-graph-row') as HTMLElement | null;
      if (row && !row.contains(event.relatedTarget as Node)) this.hideTooltip();
    };
    this.handleFocusIn = event => {
      const row = (event.target as HTMLElement).closest?.('.inspector-graph-row') as HTMLElement | null;
      if (row?.dataset.hash) this.showTooltip(row.dataset.hash, row);
    };
    this.handleFocusOut = event => {
      const row = (event.target as HTMLElement).closest?.('.inspector-graph-row') as HTMLElement | null;
      if (row && !row.contains(event.relatedTarget as Node)) this.hideTooltip();
    };
  }

  mount(): void {
    if (this.mounted || !this.container) return;
    this.mounted = true;
    this.container.replaceChildren(this.layer);
    document.body.appendChild(this.tooltip);
    this.container.addEventListener('scroll', this.handleScroll, { passive: true });
    this.container.addEventListener('click', this.handleClick);
    this.container.addEventListener('keydown', this.handleKeydown);
    this.container.addEventListener('pointerover', this.handlePointerOver);
    this.container.addEventListener('pointerout', this.handlePointerOut);
    this.container.addEventListener('focusin', this.handleFocusIn);
    this.container.addEventListener('focusout', this.handleFocusOut);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.renderViewport(true));
      this.resizeObserver.observe(this.container);
    }
  }

  update(snapshot: GraphSnapshot = {}): void {
    this.refreshTranslations();
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const revision = Number.isInteger(snapshot.revision) ? (snapshot.revision as number) : 0;
    const firstHash = rows[0]?.hash || '';
    const lastHash = rows.at(-1)?.hash || '';
    const dataChanged = revision !== this.revision || rows.length !== this.rows.length ||
      firstHash !== this.rows[0]?.hash || lastHash !== this.rows.at(-1)?.hash;

    this.selectedHash = typeof snapshot.selectedHash === 'string'
      ? snapshot.selectedHash
      : null;
    this.laneCount = Math.max(1, Number(snapshot.laneCount) || 1);

    if (!dataChanged) {
      this.updateVisibleSelection();
      return;
    }

    this.revision = revision;
    this.rows = rows;
    this.rowsByHash = new Map(rows.map(row => [row.hash, row]));
    this.renderedRange = [-1, -1];
    this.layer.style.height = rows.length ? `${rows.length * this.rowHeight}px` : '100%';
    this.renderViewport(true);
  }

  select(hash: string): void {
    if (!this.rowsByHash.has(hash)) return;
    this.selectedHash = hash;
    this.updateVisibleSelection();
    this.onSelect?.(hash);
  }

  scheduleViewport(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderViewport();
      const available = Math.max(1, this.container!.scrollHeight - this.container!.clientHeight);
      if (this.container!.scrollTop / available >= 0.85) this.onRequestMore?.();
    });
  }

  renderViewport(force = false): void {
    if (!this.mounted) return;
    if (!this.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'inspector-side-empty';
      const icon = document.createElement('i');
      icon.className = 'ph ph-git-commit';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = this.translate('details.graphEmpty');
      empty.append(icon, label);
      this.layer.replaceChildren(empty);
      this.renderedRange = [0, 0];
      return;
    }

    const start = Math.max(
      0,
      Math.floor(this.container!.scrollTop / this.rowHeight) - this.overscan
    );
    const visibleCount = Math.ceil(
      Math.max(this.rowHeight, this.container!.clientHeight) / this.rowHeight
    );
    const end = Math.min(this.rows.length, start + visibleCount + (this.overscan * 2));
    if (!force && start === this.renderedRange[0] && end === this.renderedRange[1]) return;
    this.renderedRange = [start, end];

    const reusable = new Map<string, HTMLElement>();
    const spare: HTMLElement[] = [];
    if (!force) {
      for (const element of this.layer.children) {
        if (element.classList.contains('inspector-graph-row') && (element as HTMLElement).dataset.hash) {
          reusable.set((element as HTMLElement).dataset.hash ?? '', element as HTMLElement);
        }
      }
      const visibleHashes = new Set(this.rows.slice(start, end).map(row => row.hash));
      for (const [hash, element] of reusable) {
        if (!visibleHashes.has(hash)) spare.push(element);
      }
    }

    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const data = this.rows[index];
      const existing = reusable.get(data.hash);
      const row = existing || spare.pop() || this.createRow();
      if (
        !existing ||
        row.dataset.hash !== data.hash ||
        row.dataset.graphRevision !== String(this.revision)
      ) {
        this.updateRow(row, data, index);
      } else {
        this.updateRowPosition(row, data, index);
      }
      row.dataset.graphRevision = String(this.revision);
      fragment.appendChild(row);
    }
    this.layer.replaceChildren(fragment);
  }

  createRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inspector-graph-row';
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    return row;
  }

  updateRow(row: HTMLElement, data: GraphRowData, index: number): void {
    row.dataset.hash = data.hash;
    row.dataset.graphRevision = String(this.revision);
    row.replaceChildren(this.createGraphSvg(data));
    const branches = this.branchNames(data);
    row.setAttribute(
      'aria-label',
      `${branches.join(', ') || this.translate('details.graphNoBranch')}: ${data.subject}`
    );
    this.updateRowPosition(row, data, index);
  }

  updateRowPosition(row: HTMLElement, data: GraphRowData, index: number): void {
    const selected = data.hash === this.selectedHash;
    row.style.transform = `translate3d(0, ${index * this.rowHeight}px, 0)`;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
  }

  updateVisibleSelection(): void {
    for (const row of this.layer.querySelectorAll<HTMLElement>('.inspector-graph-row')) {
      const selected = row.dataset.hash === this.selectedHash;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
    }
  }

  createGraphSvg(row: GraphRowData): SVGElement {
    const namespace = 'http://www.w3.org/2000/svg';
    const width = Math.min(190, Math.max(48, this.laneCount * 18 + 20));
    const x = (lane: number): number => 12 + lane * 18;
    const midpoint = this.rowHeight / 2;
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('class', 'inspector-graph-svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${this.rowHeight}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.width = `${width}px`;

    for (const segment of (window as unknown as { GraphLayout: WindowGraphLayout }).GraphLayout.createGraphSegments(row, this.rowHeight)) {
      svg.appendChild(this.svgPath(segment.path, segment.lane));
    }

    const circle = document.createElementNS(namespace, 'circle');
    circle.setAttribute('cx', String(x(row.lane)));
    circle.setAttribute('cy', String(midpoint));
    circle.setAttribute('r', String((row.parents || []).length > 1 ? 5 : 4));
    circle.setAttribute(
      'class',
      `graph-lane-node graph-lane-${row.lane % 8}${(row.parents || []).length > 1 ? ' is-merge' : ''}`
    );
    svg.appendChild(circle);

    if ((row.refs || []).some(ref => ref.type === 'head')) {
      const head = document.createElementNS(namespace, 'circle');
      head.setAttribute('cx', String(x(row.lane)));
      head.setAttribute('cy', String(midpoint));
      head.setAttribute('r', '8');
      head.setAttribute('class', 'graph-head-indicator');
      svg.appendChild(head);
    }
    return svg;
  }

  svgPath(data: string, lane: number): SVGElement {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    path.setAttribute('class', `graph-lane-path graph-lane-${lane % 8}`);
    return path;
  }

  branchNames(row: GraphRowData): string[] {
    return [...new Set((row.refs || [])
      .filter(ref => ref && ['branch', 'remote'].includes(ref.type) && ref.shortName)
      .map(ref => String(ref.shortName)))];
  }

  createTooltip(): HTMLElement {
    const tooltip = document.createElement('div');
    tooltip.id = 'inspector-commit-tooltip';
    tooltip.className = 'inspector-commit-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');

    const top = document.createElement('div');
    top.className = 'inspector-tooltip-top';
    const icon = document.createElement('i');
    icon.className = 'ph ph-git-commit';
    icon.setAttribute('aria-hidden', 'true');
    this.tooltipHash = document.createElement('span');
    this.tooltipHash.className = 'inspector-tooltip-hash';
    top.append(icon, this.tooltipHash);

    this.tooltipBranchLabel = document.createElement('span');
    this.tooltipBranchLabel.className = 'inspector-tooltip-label';
    this.tooltipBranchLabel.textContent = this.translate('details.graphBranch');
    this.tooltipBranch = document.createElement('strong');
    this.tooltipBranch.className = 'inspector-tooltip-branch';

    this.tooltipMessageLabel = document.createElement('span');
    this.tooltipMessageLabel.className = 'inspector-tooltip-label';
    this.tooltipMessageLabel.textContent = this.translate('details.graphMessage');
    this.tooltipMessage = document.createElement('span');
    this.tooltipMessage.className = 'inspector-tooltip-message';
    tooltip.append(
      top,
      this.tooltipBranchLabel,
      this.tooltipBranch,
      this.tooltipMessageLabel,
      this.tooltipMessage
    );
    return tooltip;
  }

  refreshTranslations(): void {
    if (this.tooltipBranchLabel) {
      this.tooltipBranchLabel.textContent = this.translate('details.graphBranch');
    }
    if (this.tooltipMessageLabel) {
      this.tooltipMessageLabel.textContent = this.translate('details.graphMessage');
    }
  }

  showTooltip(hash: string, anchor: HTMLElement): void {
    const row = this.rowsByHash.get(hash);
    if (!row) return;
    const branches = this.branchNames(row);
    this.tooltipHash.textContent = hash.slice(0, 7);
    this.tooltipBranch.textContent = branches.join(', ') || this.translate('details.graphNoBranch');
    this.tooltipMessage.textContent = row.subject || hash;
    this.tooltip.classList.add('is-visible');
    this.tooltip.setAttribute('aria-hidden', 'false');
    anchor.setAttribute('aria-describedby', this.tooltip.id);

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const inset = 10;
    let left = anchorRect.right + inset;
    if (left + tooltipRect.width > window.innerWidth - inset) {
      left = Math.max(inset, anchorRect.left - tooltipRect.width - inset);
    }
    const top = Math.min(
      window.innerHeight - tooltipRect.height - inset,
      Math.max(inset, anchorRect.top + ((anchorRect.height - tooltipRect.height) / 2))
    );
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  hideTooltip(): void {
    this.tooltip.classList.remove('is-visible');
    this.tooltip.setAttribute('aria-hidden', 'true');
    for (const row of this.layer.querySelectorAll('[aria-describedby]')) {
      row.removeAttribute('aria-describedby');
    }
  }

  destroy(): void {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.container!.removeEventListener('scroll', this.handleScroll);
    this.container!.removeEventListener('click', this.handleClick);
    this.container!.removeEventListener('keydown', this.handleKeydown);
    this.container!.removeEventListener('pointerover', this.handlePointerOver);
    this.container!.removeEventListener('pointerout', this.handlePointerOut);
    this.container!.removeEventListener('focusin', this.handleFocusIn);
    this.container!.removeEventListener('focusout', this.handleFocusOut);
    this.tooltip.remove();
    this.container!.replaceChildren();
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { InspectorGraph: typeof InspectorGraph }).InspectorGraph = InspectorGraph;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = InspectorGraph;
}

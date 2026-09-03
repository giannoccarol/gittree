import type { GitTreeApp } from '../app.mts';
import type { LayoutState } from './graph-layout.mts';

interface GraphCommitData {
  hash: string;
  subject: string;
  authorName: string;
  authorEmail?: string;
  date: string;
  parents?: string[];
}

interface GraphRefEntry {
  commit: string;
  fullName: string;
  shortName: string;
  type: string;
}

type GraphLayoutRow = {
  commit: GraphCommitData;
  lane: number;
  incoming: boolean;
  before: Array<string | null>;
  parents: Array<{ hash: string; lane: number; kind: string }>;
};

type WindowGraphLayout = {
  layoutGraph: (
    commits: unknown,
    previousState?: LayoutState
  ) => { rows: GraphLayoutRow[]; laneCount: number; nextState: LayoutState };
  createGraphSegments: (
    row: unknown,
    rowHeight: number
  ) => Array<{ lane: number; path: string }>;
};

interface ColumnDefinition {
  default: number;
  min: number;
  max: number;
}

interface ViewportState {
  anchorHash: string | null;
  anchorOffset: number;
  scrollTop: number;
  selectedHash: string | null;
  selectedHashes: string[];
  selectionAnchor: string | null;
}


export class GraphView {
  container: HTMLElement;
  body: HTMLElement;
  app: GitTreeApp;
  repoPath: string | null;
  rows: GraphLayoutRow[];
  visibleRows: GraphLayoutRow[];
  hashes: Set<string>;
  refsByHash: Map<string, GraphRefEntry[]>;
  selectedHash: string | null;
  selectedHashes: Set<string>;
  selectionAnchor: string | null;
  searchTerm: string;
  filters: { query: string; author: string; ref: string };
  sortMode: string;
  historyStateStorageKey: string;
  offset: number;
  hasMore: boolean;
  loading: boolean;
  layoutState: LayoutState;
  laneCount: number;
  generation: number;
  dataRevision: number;
  rowHeight: number;
  overscan: number;
  raf: number;
  renderedRange: [number, number];
  renderedDataRevision: number;
  resizeObserver: ResizeObserver | null;
  columnStorageKey: string;
  columnDefinitions: Record<string, ColumnDefinition>;
  columnWidths: Record<string, number>;
  hasPersistedColumnWidths: boolean;
  columnResize: {
    column: string;
    handle: HTMLElement;
    startX: number;
    startWidth: number;
    delta: number;
  } | null;
  columnResizeRaf: number;
  formatLocalizedDate: (value: unknown, language: string) => string;
  layer: HTMLElement;
  columnHandles: HTMLElement[] | null;
  filterQuery: HTMLInputElement | null;
  filterAuthor: HTMLSelectElement | null;
  filterRef: HTMLSelectElement | null;
  sortSelect: HTMLSelectElement | null;
  filterClear: HTMLElement | null;

  constructor(container: HTMLElement, body: HTMLElement, app: GitTreeApp) {
    this.container = container;
    this.body = body;
    this.app = app;
    this.repoPath = null;
    this.rows = [];
    this.visibleRows = [];
    this.hashes = new Set();
    this.refsByHash = new Map();
    this.selectedHash = null;
    this.selectedHashes = new Set();
    this.selectionAnchor = null;
    this.searchTerm = '';
    this.filters = { query: '', author: '', ref: 'all' };
    this.sortMode = 'topology';
    this.historyStateStorageKey = 'gittree.history.view';
    this.offset = 0;
    this.hasMore = false;
    this.loading = false;
    this.layoutState = { lanes: [] };
    this.laneCount = 1;
    this.generation = 0;
    this.dataRevision = 0;
    this.rowHeight = 38;
    this.overscan = 20;
    this.raf = 0;
    this.renderedRange = [-1, -1];
    this.renderedDataRevision = -1;
    this.resizeObserver = null;
    this.columnStorageKey = 'gittree.history.columns';
    this.columnDefinitions = {
      graph: { default: 84, min: 64, max: 240 },
      message: { default: 420, min: 220, max: 900 },
      author: { default: 160, min: 110, max: 420 },
      date: { default: 136, min: 110, max: 260 },
      hash: { default: 90, min: 74, max: 180 }
    };
    const restoredColumns = this.restoreColumnWidths();
    this.columnWidths = restoredColumns.widths;
    this.hasPersistedColumnWidths = restoredColumns.persisted;
    this.columnResize = null;
    this.columnResizeRaf = 0;
    this.formatLocalizedDate = LocalizedDateFormatter.create();
    this.columnHandles = null;
    this.filterQuery = null;
    this.filterAuthor = null;
    this.filterRef = null;
    this.sortSelect = null;
    this.filterClear = null;

    this.layer = document.createElement('div');
    this.layer.className = 'graph-virtual-layer';
    this.body.appendChild(this.layer);
    this.applyColumnWidths();
    this.setupColumnResize();
    this.setupHistoryControls();
    this.container.addEventListener('scroll', () => this.scheduleViewport());
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        this.renderedRange = [-1, -1];
        this.scheduleViewport();
      });
      this.resizeObserver.observe(this.container);
    }
    this.container.addEventListener('click', event => {
      const row = (event.target as HTMLElement).closest('.graph-row') as HTMLElement | null;
      if (row?.dataset.hash) this.selectFromEvent(row.dataset.hash, event);
    });
    this.container.addEventListener('contextmenu', event => {
      const row = (event.target as HTMLElement).closest('.graph-row') as HTMLElement | null;
      if (!row?.dataset.hash) return;
      event.preventDefault();
      if (!this.selectedHashes.has(row.dataset.hash)) this.select(row.dataset.hash, false);
      this.app.components.commitContextMenu?.open(event, [...this.selectedHashes]);
    });
  }

  async load(repoPath: string, options: { preserveViewport?: boolean } = {}): Promise<void> {
    if (!this.body.contains(this.layer)) {
      this.body.replaceChildren(this.layer);
    }
    this.generation += 1;
    const generation = this.generation;
    const keepContent = this.repoPath === repoPath && this.rows.length > 0;
    const preserveViewport = keepContent && options.preserveViewport === true;
    const viewportState = preserveViewport ? this.captureViewportState() : null;
    this.repoPath = repoPath;
    this.restoreHistoryState();
    this.rows = [];
    this.visibleRows = [];
    this.hashes.clear();
    this.refsByHash.clear();
    this.selectedHashes.clear();
    this.selectedHash = null;
    this.selectionAnchor = null;
    this.offset = 0;
    this.hasMore = true;
    this.loading = false;
    this.layoutState = { lanes: [] };
    this.laneCount = 1;
    this.renderedRange = [-1, -1];
    this.renderedDataRevision = -1;
    this.dataRevision += 1;
    this.app.syncInspectorWorkspace?.();
    if (!keepContent) {
      this.layer.replaceChildren(this.emptyState('ph-circle-notch', t('history.loading')));
    }
    this.body.style.height = '100%';
    const loaded = await this.loadNextPage(generation, { render: false });
    if (!loaded || generation !== this.generation) return;
    if (preserveViewport) {
      await this.ensureAnchorLoaded(viewportState!.anchorHash, generation);
      if (generation !== this.generation) return;
      this.restoreViewportState(viewportState!);
    }
    this.renderViewport(!preserveViewport);
  }

  async ensureAnchorLoaded(anchorHash: string | null, generation = this.generation): Promise<void> {
    if (!anchorHash || generation !== this.generation) return;
    const maxPages = 200;
    let pagesLoaded = 0;
    while (
      generation === this.generation &&
      this.hasMore &&
      pagesLoaded < maxPages &&
      !graphAnchorIsLoaded(anchorHash, this.rows, this.visibleRows)
    ) {
      const loaded = await this.loadNextPage(generation, { render: false });
      if (!loaded) return;
      pagesLoaded += 1;
    }
  }

  async loadNextPage(generation = this.generation, options: { render?: boolean } = {}): Promise<boolean> {
    if (!this.repoPath || !this.hasMore || this.loading) return false;
    this.loading = true;
    try {
      const page = await window.gitTree.getGraphPage(this.repoPath, {
        offset: this.offset,
        limit: 500
      }) as {
        error?: string;
        refs?: GraphRefEntry[];
        commits?: GraphCommitData[];
        nextOffset?: number;
        hasMore?: boolean;
      };
      if (generation !== this.generation) return false;
      if (page?.error) throw new Error(page.error);

      for (const ref of page.refs || []) {
        if (!this.refsByHash.has(ref.commit)) this.refsByHash.set(ref.commit, []);
        const bucket = this.refsByHash.get(ref.commit);
        if (!bucket!.some(existing => existing.fullName === ref.fullName)) bucket!.push(ref);
      }

      const commits = (page.commits || []).filter(commit => {
        if (this.hashes.has(commit.hash)) return false;
        this.hashes.add(commit.hash);
        return true;
      });
      const layout = (window as unknown as { GraphLayout: WindowGraphLayout }).GraphLayout.layoutGraph(commits, this.layoutState);
      this.rows.push(...layout.rows);
      this.layoutState = layout.nextState;
      this.laneCount = Math.max(this.laneCount, Number(layout.laneCount) || 0);
      this.offset = page.nextOffset ?? 0;
      this.hasMore = Boolean(page.hasMore);
      this.applyFilter();
      this.updateAuthorOptions();
      this.updateGraphWidth();
      if (options.render !== false) this.renderViewport(true);
      this.dataRevision += 1;
      this.app.syncInspectorWorkspace?.();
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.body.style.height = '100%';
        this.layer.replaceChildren(this.emptyState('ph-warning-circle', (error as Error).message));
      }
      return false;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  captureViewportState(): ViewportState {
    const viewportTop = Math.max(0, this.container!.scrollTop - 36);
    const index = this.visibleRows.length
      ? Math.min(
        this.visibleRows.length - 1,
        Math.max(0, Math.floor(viewportTop / this.rowHeight))
      )
      : 0;
    return {
      anchorHash: this.visibleRows[index]?.commit.hash || null,
      anchorOffset: viewportTop - (index * this.rowHeight),
      scrollTop: this.container!.scrollTop,
      selectedHash: this.selectedHash,
      selectedHashes: [...this.selectedHashes],
      selectionAnchor: this.selectionAnchor
    };
  }

  restoreViewportState(state: ViewportState): void {
    if (!state) return;
    this.selectedHashes = new Set(
      state.selectedHashes.filter(hash => this.hashes.has(hash))
    );
    this.selectedHash = this.selectedHashes.has(String(state.selectedHash))
      ? state.selectedHash
      : null;
    this.selectionAnchor = state.selectionAnchor !== null && this.selectedHashes.has(state.selectionAnchor)
      ? state.selectionAnchor
      : null;
    const anchorIndex = state.anchorHash
      ? this.visibleRows.findIndex(row => row.commit.hash === state.anchorHash)
      : -1;
    this.container!.scrollTop = state.scrollTop <= 36
      ? state.scrollTop
      : anchorIndex >= 0
        ? Math.max(0, 36 + (anchorIndex * this.rowHeight) + state.anchorOffset)
        : state.scrollTop;
  }

  applyFilter(): void {
    const globalNeedle = this.searchTerm.trim().toLowerCase();
    const filterNeedle = this.filters.query.trim().toLowerCase();
    const rows = this.rows.filter(row => {
      const commit = row.commit;
      const searchable = `${commit.subject} ${commit.hash} ${commit.authorName} ${commit.authorEmail || ''}`
        .toLowerCase();
      if (globalNeedle && !searchable.includes(globalNeedle)) return false;
      if (filterNeedle && !searchable.includes(filterNeedle)) return false;
      if (
        this.filters.author &&
        (commit.authorEmail || commit.authorName) !== this.filters.author
      ) return false;
      const refs = this.refsByHash.get(commit.hash) || [];
      if (this.filters.ref === 'branches' && !refs.some(ref => ['branch', 'remote'].includes(ref.type))) {
        return false;
      }
      if (this.filters.ref === 'tags' && !refs.some(ref => ref.type === 'tag')) return false;
      if (this.filters.ref === 'head' && !refs.some(ref => ref.type === 'head')) return false;
      if (this.filters.ref === 'none' && refs.length) return false;
      return true;
    });
    this.visibleRows = this.sortRows(rows);
    const height = Math.max(this.visibleRows.length * this.rowHeight, this.container!.clientHeight - 36);
    this.body.style.height = `${height}px`;
    this.renderedRange = [-1, -1];
  }

  sortRows(rows: GraphLayoutRow[]): GraphLayoutRow[] {
    if (this.sortMode === 'topology') return rows;
    const sorted = [...rows];
    const compareText = (left: string, right: string): number => left.localeCompare(
      right,
      i18next.language,
      { sensitivity: 'base' }
    );
    sorted.sort((left, right) => {
      const a = left.commit;
      const b = right.commit;
      if (this.sortMode === 'date-desc') return Date.parse(b.date) - Date.parse(a.date);
      if (this.sortMode === 'date-asc') return Date.parse(a.date) - Date.parse(b.date);
      if (this.sortMode === 'author') return compareText(a.authorName, b.authorName);
      if (this.sortMode === 'subject') return compareText(a.subject, b.subject);
      return compareText(a.hash, b.hash);
    });
    return sorted;
  }

  scheduleViewport(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderViewport();
      if (this.loading) return;
      const available = Math.max(1, this.container!.scrollHeight - this.container!.clientHeight);
      if (this.container!.scrollTop / available >= 0.85) void this.loadNextPage();
    });
  }

  renderViewport(force = false): void {
    if (!this.visibleRows.length) {
      this.body.style.height = '100%';
      this.layer.replaceChildren(this.emptyState('ph-git-commit', t('history.empty')));
      this.renderedRange = [0, 0];
      return;
    }

    const viewportTop = Math.max(0, this.container!.scrollTop - 36);
    const start = Math.max(0, Math.floor(viewportTop / this.rowHeight) - this.overscan);
    const count = Math.ceil(this.container!.clientHeight / this.rowHeight) + this.overscan * 2;
    const end = Math.min(this.visibleRows.length, start + count);
    if (
      !force &&
      start === this.renderedRange[0] &&
      end === this.renderedRange[1] &&
      this.renderedDataRevision === this.dataRevision
    ) return;
    this.renderedRange = [start, end];
    this.renderedDataRevision = this.dataRevision;

    const reusableRows = new Map<string, HTMLElement>();
    const spareRows: HTMLElement[] = [];
    if (!force) {
      for (const element of this.layer.children) {
        if (element.classList.contains('graph-row') && (element as HTMLElement).dataset.hash) {
          reusableRows.set((element as HTMLElement).dataset.hash ?? '', element as HTMLElement);
        }
      }
      const visibleHashes = new Set(
        this.visibleRows.slice(start, end).map(row => row.commit.hash)
      );
      for (const [hash, element] of reusableRows) {
        if (!visibleHashes.has(hash)) spareRows.push(element);
      }
    }
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const layoutRow = this.visibleRows[index];
      const hash = layoutRow.commit.hash;
      const reusable = reusableRows.get(hash);
      const row = reusable || spareRows.pop();
      if (row) {
        this.updateRow(row, layoutRow, index);
        fragment.appendChild(row);
      } else {
        fragment.appendChild(this.createRow(layoutRow, index));
      }
    }
    this.layer.replaceChildren(fragment);
  }

  createRow(layoutRow: GraphLayoutRow, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'graph-row';

    const graph = document.createElement('div');
    graph.className = 'graph-cell';

    const message = document.createElement('div');
    message.className = 'graph-commit-message';
    const refs = document.createElement('div');
    refs.className = 'graph-refs';
    const subject = document.createElement('span');
    subject.className = 'truncate';
    message.append(refs, subject);

    const author = document.createElement('div');
    author.className = 'graph-commit-author';
    const date = document.createElement('div');
    date.className = 'graph-commit-date';
    const hash = document.createElement('div');
    hash.className = 'graph-commit-hash';
    row.append(graph, message, author, date, hash);
    this.updateRow(row, layoutRow, index);
    return row;
  }

  updateRow(row: HTMLElement, layoutRow: GraphLayoutRow, index: number): void {
    const commit = layoutRow.commit;
    const selected = this.selectedHashes.has(commit.hash);
    row.className = `graph-row${selected ? ' selected' : ''}`;
    row.dataset.hash = commit.hash;
    row.dataset.graphRevision = String(this.dataRevision);
    row.style.transform = `translateY(${index * this.rowHeight}px)`;
    row.setAttribute('aria-selected', String(selected));

    const [graph, message, author, date, hash] = row.children as unknown as [
      HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement
    ];
    graph.replaceChildren(
      this.sortMode === 'topology'
        ? this.createGraphSvg(layoutRow)
        : this.createSortMarker()
    );
    const [refs, subject] = message.children as unknown as [HTMLElement, HTMLElement];
    refs.replaceChildren(...(this.refsByHash.get(commit.hash) || []).map(ref => {
      const badge = document.createElement('span');
      badge.className = `badge badge-${ref.type}`;
      badge.textContent = ref.shortName;
      return badge;
    }));
    subject.textContent = commit.subject;
    author.textContent = commit.authorName;
    date.textContent = this.fmtDate(commit.date);
    date.title = date.textContent;
    hash.textContent = commit.hash.slice(0, 7);
  }

  createSortMarker(): HTMLElement {
    const marker = document.createElement('div');
    marker.className = 'graph-sort-marker';
    marker.innerHTML = '<i class="ph ph-git-commit" aria-hidden="true"></i>';
    return marker;
  }

  createGraphSvg(row: GraphLayoutRow): SVGElement {
    const namespace = 'http://www.w3.org/2000/svg';
    const width = Math.min(240, Math.max(64, this.laneCount * 18 + 20));
    const x = (lane: number): number => 12 + lane * 18;
    const midpoint = this.rowHeight / 2;
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('class', 'graph-lanes');
    svg.setAttribute('viewBox', `0 0 ${width} ${this.rowHeight}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.width = `${width}px`;

    for (const segment of (window as unknown as { GraphLayout: WindowGraphLayout }).GraphLayout.createGraphSegments(row, this.rowHeight)) {
      svg.appendChild(this.svgPath(segment.path, segment.lane));
    }

    const circle = document.createElementNS(namespace, 'circle');
    circle.setAttribute('cx', String(x(row.lane)));
    circle.setAttribute('cy', String(midpoint));
    circle.setAttribute('r', String(row.parents.length > 1 ? 5 : 4));
    circle.setAttribute('class', `graph-lane-node graph-lane-${row.lane % 8}${row.parents.length > 1 ? ' is-merge' : ''}`);
    svg.appendChild(circle);
    if ((this.refsByHash.get(row.commit.hash) || []).some(ref => ref.type === 'head')) {
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

  updateGraphWidth(): void {
    if (this.hasPersistedColumnWidths) return;
    const width = Math.min(240, Math.max(64, this.laneCount * 18 + 20));
    this.resizeColumn(
      'graph',
      Math.max(this.columnDefinitions.graph.default, width),
      false
    );
  }

  restoreColumnWidths(): { widths: Record<string, number>; persisted: boolean } {
    const defaults = Object.fromEntries(
      Object.entries(this.columnDefinitions).map(([column, definition]) => [
        column,
        definition.default
      ])
    );
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(this.columnStorageKey) ?? 'null');
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        return { widths: defaults, persisted: false };
      }
      let restored = false;
      for (const [column, definition] of Object.entries(this.columnDefinitions)) {
        if (column === undefined || !Number.isFinite((stored as Record<string, unknown>)[column])) continue;
        defaults[column] = this.clampColumnWidth((stored as Record<string, number>)[column], definition);
        restored = true;
      }
      return { widths: defaults, persisted: restored };
    } catch {
      return { widths: defaults, persisted: false };
    }
  }

  setupColumnResize(): void {
    this.columnHandles = [
      ...this.container!.querySelectorAll<HTMLElement>('.graph-column-resizer')
    ];
    for (const handle of this.columnHandles) {
      const column = handle.dataset.column ?? '';
      const definition = this.columnDefinitions[column];
      if (!definition) continue;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.startColumnResize(column, handle, event.clientX);
      });
      handle.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home') {
          this.resizeColumn(column, definition.default, true);
          return;
        }
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const step = event.shiftKey ? 24 : 8;
        this.resizeColumn(column, this.columnWidths[column] + direction * step, true);
      });
      handle.addEventListener('dblclick', () => {
        this.resizeColumn(column, definition.default, true);
      });
    }
    document.addEventListener('pointermove', event => this.previewColumnResize(event.clientX));
    document.addEventListener('pointerup', event => this.finishColumnResize(event.clientX));
    document.addEventListener('pointercancel', () => this.cancelColumnResize());
    i18next.on('languageChanged', () => this.updateColumnHandleLabels());
    this.updateColumnHandleLabels();
  }

  startColumnResize(column: string, handle: HTMLElement, clientX: number): void {
    this.cancelColumnResize();
    this.columnResize = {
      column,
      handle,
      startX: clientX,
      startWidth: this.columnWidths[column],
      delta: 0
    };
    handle.classList.add('is-resizing');
    document.documentElement.classList.add('is-resizing-history-columns');
  }

  previewColumnResize(clientX: number): void {
    if (!this.columnResize) return;
    const { column, startX, startWidth } = this.columnResize;
    const definition = this.columnDefinitions[column];
    const nextWidth = this.clampColumnWidth(startWidth + clientX - startX, definition);
    this.columnResize.delta = nextWidth - startWidth;
    if (this.columnResizeRaf) return;
    this.columnResizeRaf = requestAnimationFrame(() => {
      this.columnResizeRaf = 0;
      if (!this.columnResize) return;
      this.columnResize.handle.style.transform =
        `translate3d(${this.columnResize.delta}px, 0, 0)`;
    });
  }

  finishColumnResize(clientX: number): void {
    if (!this.columnResize) return;
    this.previewColumnResize(clientX);
    const { column, startWidth, delta } = this.columnResize;
    this.resizeColumn(column, startWidth + delta, true);
    this.cancelColumnResize();
  }

  cancelColumnResize(): void {
    if (this.columnResizeRaf) {
      cancelAnimationFrame(this.columnResizeRaf);
      this.columnResizeRaf = 0;
    }
    if (this.columnResize) {
      this.columnResize.handle.style.transform = '';
      this.columnResize.handle.classList.remove('is-resizing');
      this.columnResize = null;
    }
    document.documentElement.classList.remove('is-resizing-history-columns');
  }

  resizeColumn(column: string, width: number, persist = true): void {
    const definition = this.columnDefinitions[column];
    if (!definition) return;
    this.columnWidths[column] = this.clampColumnWidth(width, definition);
    this.applyColumnWidths();
    if (persist) this.persistColumnWidths();
  }

  setColumnWidths(widths?: Record<string, number>, persist = true): void {
    for (const [column, definition] of Object.entries(this.columnDefinitions)) {
      if (!Number.isFinite(widths?.[column])) continue;
      this.columnWidths[column] = this.clampColumnWidth(widths![column], definition);
    }
    this.applyColumnWidths();
    if (persist) this.persistColumnWidths();
  }

  applyColumnWidths(): void {
    for (const [column, width] of Object.entries(this.columnWidths)) {
      this.container.style.setProperty(`--graph-column-${column}`, `${width}px`);
    }
    this.updateColumnHandleLabels();
    this.renderedRange = [-1, -1];
    if (this.visibleRows.length) this.scheduleViewport();
  }

  persistColumnWidths(): void {
    try {
      localStorage.setItem(this.columnStorageKey, JSON.stringify(this.columnWidths));
      this.hasPersistedColumnWidths = true;
    } catch {
      // The layout remains usable when storage is unavailable.
    }
  }

  updateColumnHandleLabels(): void {
    if (!this.columnHandles) return;
    for (const handle of this.columnHandles) {
      const column = handle.dataset.column ?? '';
      const label = t(`history.${column}`);
      const definition = this.columnDefinitions[column];
      handle.setAttribute('aria-label', t('history.resizeColumn', { column: label }));
      handle.setAttribute('aria-valuemin', String(definition.min));
      handle.setAttribute('aria-valuemax', String(definition.max));
      handle.setAttribute('aria-valuenow', String(this.columnWidths[column]));
    }
  }

  setupHistoryControls(): void {
    this.filterQuery = document.getElementById('history-filter-query')! as HTMLInputElement | null;
    this.filterAuthor = document.getElementById('history-filter-author')! as HTMLSelectElement | null;
    this.filterRef = document.getElementById('history-filter-ref')! as HTMLSelectElement | null;
    this.sortSelect = document.getElementById('history-sort')! as HTMLSelectElement | null;
    this.filterClear = document.getElementById('history-filter-clear')!;
    this.filterQuery?.addEventListener('input', () => {
      this.filters.query = this.filterQuery!.value;
      this.commitHistoryState();
    });
    this.filterAuthor?.addEventListener('change', () => {
      this.filters.author = this.filterAuthor!.value;
      this.commitHistoryState();
    });
    this.filterRef?.addEventListener('change', () => {
      this.filters.ref = this.filterRef!.value;
      this.commitHistoryState();
    });
    this.sortSelect?.addEventListener('change', () => {
      this.sortMode = this.sortSelect!.value;
      this.commitHistoryState();
    });
    this.filterClear?.addEventListener('click', () => {
      this.filters = { query: '', author: '', ref: 'all' };
      this.syncHistoryControls();
      this.commitHistoryState();
      this.filterQuery?.focus();
    });
  }

  commitHistoryState(): void {
    this.persistHistoryState();
    this.container!.scrollTop = 0;
    this.applyFilter();
    this.renderViewport(true);
  }

  updateAuthorOptions(): void {
    if (!this.filterAuthor) return;
    const selected = this.filters.author;
    const authors = new Map<string, string>();
    for (const row of this.rows) {
      const email = row.commit.authorEmail || row.commit.authorName;
      if (!email || authors.has(email)) continue;
      authors.set(email, row.commit.authorName || email);
    }
    const first = document.createElement('option');
    first.value = '';
    first.textContent = t('history.allAuthors');
    const options = [...authors]
      .sort((left, right) => left[1].localeCompare(right[1], i18next.language))
      .map(([email, name]) => {
        const option = document.createElement('option');
        option.value = email;
        option.textContent = name;
        return option;
      });
    this.filterAuthor.replaceChildren(first, ...options);
    this.filterAuthor!.value = authors.has(selected) ? selected : '';
    if (selected && !authors.has(selected) && !this.hasMore) {
      this.filters.author = '';
      this.persistHistoryState();
    }
  }

  restoreHistoryState(): void {
    let stored: Record<string, { query?: unknown; author?: unknown; ref?: unknown; sort?: unknown }> = {};
    try {
      stored = JSON.parse(localStorage.getItem(this.historyStateStorageKey) ?? '{}');
    } catch { /* invalid stored history state is ignored */ }
    const state = stored[String(this.repoPath)] || {};
    this.filters = {
      query: typeof state.query === 'string' ? state.query : '',
      author: typeof state.author === 'string' ? state.author : '',
      ref: ['all', 'branches', 'tags', 'head', 'none'].includes(state.ref as string)
        ? state.ref as string
        : 'all'
    };
    this.sortMode = [
      'topology',
      'date-desc',
      'date-asc',
      'author',
      'subject',
      'hash'
    ].includes(state.sort as string) ? state.sort as string : 'topology';
    this.syncHistoryControls();
  }

  persistHistoryState(): void {
    if (!this.repoPath) return;
    try {
      const stored = JSON.parse(localStorage.getItem(this.historyStateStorageKey) ?? '{}');
      stored[this.repoPath] = { ...this.filters, sort: this.sortMode };
      localStorage.setItem(this.historyStateStorageKey, JSON.stringify(stored));
    } catch {
      // Filters remain available for this session when storage is unavailable.
    }
  }

  syncHistoryControls(): void {
    if (this.filterQuery) this.filterQuery!.value = this.filters.query;
    if (this.filterAuthor) this.filterAuthor!.value = this.filters.author;
    if (this.filterRef) this.filterRef!.value = this.filters.ref;
    if (this.sortSelect) this.sortSelect!.value = this.sortMode;
  }

  clampColumnWidth(width: number, definition: ColumnDefinition): number {
    return Math.round(Math.min(definition.max, Math.max(definition.min, width)));
  }

  select(hash: string, emit = true): void {
    this.selectedHash = hash;
    this.selectedHashes.clear();
    this.selectedHashes.add(hash);
    this.selectionAnchor = hash;
    this.updateVisibleSelection();
    this.app.syncInspectorWorkspace?.();
    if (emit) this.app.emit('commit:selected', hash);
  }

  selectFromEvent(hash: string, event: MouseEvent): void {
    const toggle = this.app.isPrimaryModifier(event);
    if (event.shiftKey && this.selectionAnchor) {
      const start = this.visibleRows.findIndex(row => row.commit.hash === this.selectionAnchor);
      const end = this.visibleRows.findIndex(row => row.commit.hash === hash);
      if (start !== -1 && end !== -1) {
        if (!toggle) this.selectedHashes.clear();
        const [from, to] = start < end ? [start, end] : [end, start];
        for (let index = from; index <= to; index += 1) {
          this.selectedHashes.add(this.visibleRows[index].commit.hash);
        }
      }
    } else if (toggle) {
      if (this.selectedHashes.has(hash)) this.selectedHashes.delete(hash);
      else this.selectedHashes.add(hash);
      this.selectionAnchor = hash;
    } else {
      this.selectedHashes.clear();
      this.selectedHashes.add(hash);
      this.selectionAnchor = hash;
    }
    if (this.selectedHashes.size === 0) {
      this.selectedHash = null;
      this.selectionAnchor = null;
    } else {
      this.selectedHash = hash;
    }
    this.updateVisibleSelection();
    this.app.syncInspectorWorkspace?.();
    if (this.selectedHash) this.app.emit('commit:selected', this.selectedHash);
  }

  getInspectorSnapshot(maxRows = 2000): Record<string, unknown> {
    const rows = this.rows.slice(0, Math.max(0, maxRows)).map(layoutRow => ({
      hash: layoutRow.commit.hash,
      subject: layoutRow.commit.subject || '',
      lane: layoutRow.lane,
      incoming: Boolean(layoutRow.incoming),
      before: [...(layoutRow.before || [])],
      parents: (layoutRow.parents || []).map(parent => ({
        hash: parent.hash,
        lane: parent.lane,
        kind: parent.kind
      })),
      refs: (this.refsByHash.get(layoutRow.commit.hash) || []).map(ref => ({
        shortName: ref.shortName,
        type: ref.type
      }))
    }));
    return {
      revision: this.dataRevision,
      laneCount: this.laneCount,
      hasMore: this.hasMore,
      selectedHash: this.selectedHash,
      rows
    };
  }

  updateVisibleSelection(): void {
    this.layer.querySelectorAll<HTMLElement>('.graph-row').forEach(row => {
      row.classList.toggle('selected', this.selectedHashes.has(row.dataset.hash ?? ''));
      row.setAttribute('aria-selected', String(this.selectedHashes.has(row.dataset.hash ?? '')));
    });
  }

  setSearch(term: string): void {
    this.searchTerm = term || '';
    this.applyFilter();
    this.renderViewport(true);
  }

  render(): void {
    this.applyFilter();
    this.renderViewport(true);
  }

  emptyState(icon: string, text: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'empty-state';
    element.innerHTML = `<i class="ph ${icon}"></i>`;
    element.append(document.createTextNode(text));
    return element;
  }

  fmtDate(value: unknown): string {
    return this.formatLocalizedDate(value, i18next.language);
  }
}

export function graphAnchorIsLoaded(
  anchorHash: string | null,
  rows: Array<{ commit: { hash: string } }>,
  visibleRows: Array<{ commit: { hash: string } }>
): boolean {
  if (!anchorHash) return true;
  return visibleRows.some(row => row.commit.hash === anchorHash) ||
    rows.some(row => row.commit.hash === anchorHash);
}

if (typeof window !== 'undefined') {
  (window as unknown as { GraphView: typeof GraphView }).GraphView = GraphView;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = { GraphView, graphAnchorIsLoaded };
}

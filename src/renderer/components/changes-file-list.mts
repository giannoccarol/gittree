type RequestFrame = (callback: () => void) => number;

export interface ChangesFileListOptions {
  rowHeight?: number;
  overscan?: number;
  document?: Document;
  requestFrame?: RequestFrame;
  observerFactory?: ((callback: () => void) => { observe: (target: Element) => void; disconnect: () => void }) | null;
}

export class ChangesFileList {
  container: HTMLElement;
  rowHeight: number;
  overscan: number;
  document: Document;
  requestFrame: RequestFrame;
  observerFactory: ChangesFileListOptions['observerFactory'];
  items: unknown[];
  renderRow: ((item: unknown, index: number) => HTMLElement | null) | null;
  emptyText: string;
  spacer: HTMLElement | null;
  observer: { observe: (target: Element) => void; disconnect: () => void } | null;
  frame: number;
  mounted: boolean;
  paintFrame: () => void;
  onScroll: () => void;
  onResize: () => void;

  constructor(container: HTMLElement, options: ChangesFileListOptions = {}) {
    this.container = container;
    this.rowHeight = options.rowHeight || 38;
    this.overscan = options.overscan ?? 8;
    this.document = options.document || document;
    this.requestFrame = options.requestFrame
      || (callback => requestAnimationFrame(callback));
    this.observerFactory = options.observerFactory || null;
    this.items = [];
    this.renderRow = null;
    this.emptyText = '';
    this.spacer = null;
    this.observer = null;
    this.frame = 0;
    this.mounted = false;

    this.paintFrame = () => {
      this.frame = 0;
      this.paint();
    };
    this.onScroll = () => {
      if (!this.frame) this.frame = this.requestFrame(this.paintFrame);
    };
    this.onResize = () => {
      if (!this.frame) this.frame = this.requestFrame(this.paintFrame);
    };
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    if (this.observerFactory) {
      this.observer = this.observerFactory(this.onResize);
      this.observer.observe(this.container);
    } else if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(this.container);
    }
  }

  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.container.removeEventListener('scroll', this.onScroll);
    this.mounted = false;
  }

  update(items: unknown[], renderRow: (item: unknown, index: number) => HTMLElement | null, emptyText = ''): void {
    this.items = items || [];
    this.renderRow = renderRow;
    this.emptyText = emptyText;
    const scrollTop = this.container!.scrollTop || 0;
    this.frame = 0;
    this.container.replaceChildren();
    this.spacer = null;
    if (!this.items.length) {
      const empty = this.document.createElement('div');
      empty.className = 'changes-empty';
      empty.textContent = emptyText;
      this.container.appendChild(empty);
      return;
    }
    const spacer = this.document.createElement('div');
    spacer.className = 'changes-file-spacer';
    spacer.style.height = `${this.items.length * this.rowHeight}px`;
    this.container.appendChild(spacer);
    this.spacer = spacer;
    this.container!.scrollTop = scrollTop;
    this.paint();
  }

  paint(): void {
    if (!this.spacer || !this.renderRow || !this.items.length) return;
    const visible = Math.ceil(this.container!.clientHeight / this.rowHeight);
    const start = Math.max(
      0,
      Math.floor(this.container!.scrollTop / this.rowHeight) - this.overscan
    );
    const end = Math.min(
      this.items.length,
      start + visible + this.overscan * 2
    );
    const fragment = this.document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const row = this.renderRow(this.items[index], index);
      if (!row) continue;
      row.style.top = `${index * this.rowHeight}px`;
      fragment.appendChild(row);
    }
    this.spacer.replaceChildren(fragment);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { ChangesFileList: typeof ChangesFileList }).ChangesFileList = ChangesFileList;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ChangesFileList;
}

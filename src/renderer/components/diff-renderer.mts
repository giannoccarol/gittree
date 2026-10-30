import { DiffParser, type SplitRow, type UnifiedRow } from './diff-parser.mts';
import { DiffLayout, type LayoutFile } from './diff-layout.mts';

export const VIRTUAL_DIFF_THRESHOLD = 1200;
export const VIRTUAL_DIFF_OVERSCAN_PX = 440;

type VirtualDiffRow = UnifiedRow | SplitRow;
type VirtualDiffFile = LayoutFile<VirtualDiffRow>;

export type DiffMode = 'unified' | 'split';

export interface DiffRenderOptions {
  mode: DiffMode;
  wordLevel: boolean;
  /** Taller rows for the maximized inspector and the detached window. */
  expanded?: boolean;
}

export interface DiffRendererDependencies {
  /** The scroll container that receives the rendered diff. */
  body: HTMLElement;
  translate: (key: string, options?: Record<string, unknown>) => string;
  /** Extra controls appended to a file header, for example an AI blame button. */
  createFileActions?: ((path: string) => HTMLElement[]) | null;
  prefersReducedMotion?: () => boolean;
}

/**
 * Renders a unified Git patch as a unified or side-by-side diff. Large patches
 * are virtualized. The renderer owns only the body element; loading, headers and
 * persistence belong to the caller.
 */
export class DiffRenderer {
  body: HTMLElement;
  translate: (key: string, options?: Record<string, unknown>) => string;
  createFileActions: ((path: string) => HTMLElement[]) | null;
  prefersReducedMotion: () => boolean;
  options: DiffRenderOptions;
  virtualLayer: HTMLElement | null;
  virtualFiles: VirtualDiffFile[];
  virtualMode: string | null;
  virtualScrollRaf: number;
  /** Scroll range covered by the rendered rows, including overscan. */
  virtualWindow: { top: number; bottom: number; viewportHeight: number } | null;
  fileTargetTimer: number;
  handleVirtualScroll: () => void;

  constructor({ body, translate, createFileActions = null, prefersReducedMotion }: DiffRendererDependencies) {
    this.body = body;
    this.translate = translate;
    this.createFileActions = createFileActions;
    this.prefersReducedMotion = prefersReducedMotion
      ?? (() => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
    this.options = { mode: 'unified', wordLevel: true, expanded: false };
    this.virtualLayer = null;
    this.virtualFiles = [];
    this.virtualMode = null;
    this.virtualScrollRaf = 0;
    this.virtualWindow = null;
    this.fileTargetTimer = 0;
    this.handleVirtualScroll = () => {
      if (this.virtualScrollRaf) return;
      this.virtualScrollRaf = requestAnimationFrame(() => {
        this.virtualScrollRaf = 0;
        this.renderVirtualViewport();
      });
    };
  }

  render(diffText: string, options: DiffRenderOptions): void {
    this.options = { ...options };
    this.clearFileTargetTimer();
    if (!diffText) {
      this.disableVirtualization();
      this.renderPlaceholder('ph-check-circle', this.translate('details.noChanges'));
      return;
    }
    if (this.options.mode === 'unified') this.renderUnified(diffText);
    else this.renderSplit(diffText);
  }

  renderPlaceholder(icon: string | null, text: string): void {
    this.clearFileTargetTimer();
    this.disableVirtualization();
    const placeholder = document.createElement('div');
    placeholder.className = 'diff-placeholder';
    if (icon) {
      const iconElement = document.createElement('i');
      iconElement.className = `ph ${icon}`;
      placeholder.appendChild(iconElement);
    }
    placeholder.appendChild(document.createTextNode(text));
    this.body.replaceChildren(placeholder);
  }

  appendHighlightedLine(contentEl: HTMLElement, text: string, counterpart: string | null): void {
    if (!this.options.wordLevel || !text || !counterpart || text === counterpart) {
      contentEl.textContent = text;
      return;
    }
    // The leading +/- markers always differ; compare the code after them.
    const markers = '+-';
    let prefix = markers.includes(text[0]) && markers.includes(counterpart[0]) ? 1 : 0;
    const max = Math.min(text.length, counterpart.length);
    while (prefix < max && text[prefix] === counterpart[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < text.length - prefix &&
      suffix < counterpart.length - prefix &&
      text[text.length - 1 - suffix] === counterpart[counterpart.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const midStart = prefix;
    const midEnd = text.length - suffix;
    if (midStart >= midEnd) {
      contentEl.textContent = text;
      return;
    }
    contentEl.append(document.createTextNode(text.slice(0, midStart)));
    const mark = document.createElement('span');
    mark.className = 'diff-word';
    mark.textContent = text.slice(midStart, midEnd);
    contentEl.append(mark, document.createTextNode(text.slice(midEnd)));
  }

  renderUnified(diffText: string): void {
    const lines = DiffParser.parseUnified(diffText);
    if (lines.length > VIRTUAL_DIFF_THRESHOLD) {
      this.renderVirtualized(lines, 'unified');
      return;
    }
    this.disableVirtualization();
    const frag = document.createDocumentFragment();
    this.body.style.setProperty('--diff-gutter-digits', String(DiffParser.maxDigits(lines)));
    let lastRemoval: string | null = null;
    let target: ParentNode = frag;
    let fileIndex = 0;

    lines.forEach(line => {
      if (line.kind === 'file') {
        const block = document.createElement('section');
        block.className = 'diff-file-block';
        block.style.setProperty('--file-index', String(fileIndex++));
        const hdr = this.createFileHeader(block, line.content);
        block.appendChild(hdr);
        frag.appendChild(block);
        target = block;
        return;
      }

      const el = document.createElement('div');
      el.className = `diff-line ${line.kind === 'no-newline' ? 'header' : line.kind}`;
      el.appendChild(this.lineNumber(line.oldLine, 'old'));
      el.appendChild(this.lineNumber(line.newLine, 'new'));

      const content = document.createElement('span');
      content.className = 'diff-line-content';
      if (line.kind === 'add') {
        this.appendHighlightedLine(content, line.content, lastRemoval);
        lastRemoval = null;
      } else {
        content.textContent = line.content;
        lastRemoval = line.kind === 'del' ? line.content : null;
      }
      el.appendChild(content);

      target.appendChild(el);
    });

    this.body.replaceChildren(frag);
  }

  renderSplit(diffText: string): void {
    const lineCount = String(diffText || '').split('\n').length;
    if (lineCount > VIRTUAL_DIFF_THRESHOLD) {
      this.renderVirtualized(DiffParser.parseUnified(diffText), 'split-unified');
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'diff-split';
    let columns: HTMLElement | null = null;
    let target: HTMLElement = wrapper;
    let fileIndex = 0;
    const ensureColumns = (): HTMLElement => {
      if (columns) return columns;
      columns = document.createElement('div');
      columns.className = 'diff-split-columns';
      target.appendChild(columns);
      return columns;
    };

    const parsedRows = DiffParser.parseSplit(diffText);
    this.disableVirtualization();
    this.body.style.setProperty('--diff-gutter-digits', String(DiffParser.maxDigits(parsedRows)));
    parsedRows.forEach(row => {
      if (row.type === 'full') {
        columns = null;
        if (row.kind === 'file') {
          const block = document.createElement('section');
          block.className = 'diff-file-block';
          block.style.setProperty('--file-index', String(fileIndex++));
          const header = this.createFileHeader(block, row.content);
          block.appendChild(header);
          wrapper.appendChild(block);
          target = block;
          return;
        }
        const el = document.createElement('div');
        el.className = `diff-line ${row.kind}`;
        el.append(
          this.lineNumber(null, 'old'),
          this.lineNumber(null, 'new')
        );
        const content = document.createElement('span');
        content.className = 'diff-line-content';
        content.textContent = row.content;
        el.appendChild(content);
        target.appendChild(el);
        return;
      }
      const columnTarget = ensureColumns();
      columnTarget.appendChild(this.splitLine(row.left, 'old', row.right?.content));
      columnTarget.appendChild(this.splitLine(row.right, 'new', row.left?.content));
    });

    this.body.replaceChildren(wrapper);
  }

  renderVirtualized(rows: UnifiedRow[] | SplitRow[], mode: string): void {
    this.disableVirtualization();
    const isUnified = mode === 'unified';
    const isSplit = mode === 'split' || mode === 'split-unified';
    const kindOf = (row: VirtualDiffRow): string => ('kind' in row ? String(row.kind) : '');
    const contentOf = (row: VirtualDiffRow): string => ('content' in row && typeof row.content === 'string' ? row.content : '');
    const isFullRow = (row: VirtualDiffRow): boolean => 'type' in row && (row as { type?: unknown }).type === 'full';
    const files = DiffLayout.groupRows<VirtualDiffRow>(rows, {
      isFile: row => isUnified || mode === 'split-unified'
        ? kindOf(row) === 'file'
        : isFullRow(row) && kindOf(row) === 'file',
      pathForFile: row => this.extractPath(contentOf(row)) || contentOf(row)
    });
    const rowHeight = this.options.expanded ? 24 : 22;
    const layout = DiffLayout.layoutFiles<VirtualDiffRow>(files, { rowHeight });
    this.virtualMode = mode;
    this.virtualFiles = layout.files;
    this.body.classList.add('diff-virtualized');
    this.body.classList.toggle('diff-split', isSplit);
    this.body.style.setProperty('--diff-gutter-digits', String(DiffParser.maxDigits(rows)));
    this.virtualLayer = document.createElement('div');
    this.virtualLayer.className = 'diff-virtual-layer';
    this.virtualLayer.style.height = `${layout.totalHeight}px`;
    this.body.replaceChildren(this.virtualLayer);
    this.body.addEventListener('scroll', this.handleVirtualScroll, { passive: true });
    this.renderVirtualViewport(true);
  }

  renderVirtualViewport(force = false): void {
    if (!this.virtualLayer || !this.virtualMode) return;
    const viewportHeight = this.body.clientHeight || 640;
    const scrollTop = this.body.scrollTop;
    // Rows are rebuilt only when the viewport gets within half the overscan of
    // the rendered edge, not on every scroll frame.
    const margin = VIRTUAL_DIFF_OVERSCAN_PX / 2;
    const rendered = this.virtualWindow;
    if (
      !force &&
      rendered &&
      rendered.viewportHeight === viewportHeight &&
      scrollTop - rendered.top >= margin &&
      rendered.bottom - (scrollTop + viewportHeight) >= margin
    ) return;
    const visible = DiffLayout.visibleFiles<VirtualDiffRow>(
      this.virtualFiles,
      scrollTop,
      viewportHeight,
      VIRTUAL_DIFF_OVERSCAN_PX
    );
    if (!force && !visible.length) return;
    this.virtualWindow = {
      top: scrollTop - VIRTUAL_DIFF_OVERSCAN_PX,
      bottom: scrollTop + viewportHeight + VIRTUAL_DIFF_OVERSCAN_PX,
      viewportHeight
    };

    const fragment = document.createDocumentFragment();
    for (const file of visible) {
      const block = document.createElement('section');
      block.className = 'diff-file-block is-virtual';
      block.style.top = `${file.top}px`;
      block.style.height = `${file.height}px`;
      if (file.path) block.dataset.filePath = file.path;
      if (file.header && 'content' in file.header) {
        block.appendChild(this.createFileHeader(block, file.header.content));
      }

      const rowsBeforeViewport = Math.ceil(VIRTUAL_DIFF_OVERSCAN_PX / file.rowHeight);
      const firstRow = Math.max(
        0,
        Math.floor((scrollTop - file.top - file.contentTop) / file.rowHeight)
          - rowsBeforeViewport
      );
      const lastRow = Math.min(
        file.rows.length,
        Math.ceil((scrollTop + viewportHeight - file.top - file.contentTop)
          / file.rowHeight) + rowsBeforeViewport
      );
      let previousRemoval: string | null = null;
      if (this.virtualMode === 'unified') {
        for (let index = 0; index < firstRow; index += 1) {
          const row = file.rows[index];
          if (!('kind' in row)) continue;
          if (row.kind === 'del') previousRemoval = row.content;
          else if (row.kind === 'add') previousRemoval = null;
        }
      }
      for (let index = firstRow; index < lastRow; index += 1) {
        const row = file.rows[index];
        let elements: HTMLElement[];
        let isSplitPair: boolean;
        if (this.virtualMode === 'unified') {
          if (!('kind' in row)) continue;
          elements = [this.createUnifiedLine(row, previousRemoval)];
          isSplitPair = false;
        } else {
          if (!('type' in row)) continue;
          elements = this.createSplitLineElements(row);
          isSplitPair = this.virtualMode === 'split'
            ? row.type === 'pair'
            : 'kind' in row && ['del', 'add', 'context'].includes(String(row.kind));
        }
        if (isSplitPair) {
          const columns = document.createElement('div');
          columns.className = 'diff-split-columns';
          columns.style.top = `${file.contentTop + index * file.rowHeight}px`;
          columns.style.left = '0';
          columns.style.right = '0';
          elements.forEach(element => columns.appendChild(element));
          block.appendChild(columns);
        } else {
          for (const element of elements) {
            element.style.top = `${file.contentTop + index * file.rowHeight}px`;
            element.style.left = '0';
            element.style.right = '0';
            block.appendChild(element);
          }
        }
        if (this.virtualMode === 'unified' && 'kind' in row) {
          if (row.kind === 'del') previousRemoval = row.content;
          else if (row.kind === 'add') previousRemoval = null;
        }
      }
      fragment.appendChild(block);
    }
    this.virtualLayer.replaceChildren(fragment);
  }

  createUnifiedLine(line: UnifiedRow, previousRemoval: string | null = null): HTMLElement {
    const element = document.createElement('div');
    element.className = `diff-line ${line.kind === 'no-newline' ? 'header' : line.kind}`;
    element.appendChild(this.lineNumber(line.oldLine, 'old'));
    element.appendChild(this.lineNumber(line.newLine, 'new'));
    const content = document.createElement('span');
    content.className = 'diff-line-content';
    if (line.kind === 'add') {
      this.appendHighlightedLine(content, line.content, previousRemoval);
    } else {
      content.textContent = line.content;
    }
    element.appendChild(content);
    return element;
  }

  createSplitLineElements(row: SplitRow): HTMLElement[] {
    if (row.type === 'pair') {
      return [
        this.splitLine(row.left, 'old', row.right?.content),
        this.splitLine(row.right, 'new', row.left?.content)
      ];
    }
    if (row.kind === 'del') {
      return [
        this.splitLine(row, 'old'),
        this.splitLine({ content: '', kind: 'empty', oldLine: null, newLine: null }, 'new')
      ];
    }
    if (row.kind === 'add') {
      return [
        this.splitLine({ content: '', kind: 'empty', oldLine: null, newLine: null }, 'old'),
        this.splitLine(row, 'new')
      ];
    }
    if (row.kind === 'context') {
      return [
        this.splitLine(row, 'old', row.content),
        this.splitLine(row, 'new', row.content)
      ];
    }
    const element = document.createElement('div');
    element.className = `diff-line ${row.kind}`;
    element.append(
      this.lineNumber(null, 'old'),
      this.lineNumber(null, 'new')
    );
    const content = document.createElement('span');
    content.className = 'diff-line-content';
    content.textContent = row.content;
    element.appendChild(content);
    return [element];
  }

  disableVirtualization(): void {
    if (this.virtualScrollRaf) {
      cancelAnimationFrame(this.virtualScrollRaf);
      this.virtualScrollRaf = 0;
    }
    if (this.virtualLayer) {
      this.body.removeEventListener('scroll', this.handleVirtualScroll);
    }
    this.body.classList.remove('diff-virtualized');
    this.body.classList.remove('diff-split');
    this.virtualLayer = null;
    this.virtualFiles = [];
    this.virtualMode = null;
    this.virtualWindow = null;
  }

  splitLine(line: UnifiedRow, side: string, counterpart?: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `diff-line ${line.kind}`;
    el.appendChild(this.lineNumber(side === 'old' ? line.oldLine : line.newLine, side));
    const content = document.createElement('span');
    content.className = 'diff-line-content';
    if ((line.kind === 'add' || line.kind === 'del') && counterpart) {
      this.appendHighlightedLine(content, line.content, counterpart);
    } else {
      content.textContent = line.content;
    }
    el.appendChild(content);
    return el;
  }

  lineNumber(value: number | null, side: string): HTMLElement {
    const number = document.createElement('span');
    number.className = `diff-line-num is-${side}`;
    number.textContent = Number.isInteger(value) ? String(value) : '';
    return number;
  }

  extractPath(line: string): string | null {
    const m = line.match(/diff --git a\/(.+) b\/(.+)/);
    return m ? m[2] : null;
  }

  createFileHeader(block: HTMLElement, content: string): HTMLElement {
    const path = this.extractPath(content) || content;
    block.dataset.filePath = path;
    const header = document.createElement('div');
    header.className = 'diff-file-header';
    const label = document.createElement('span');
    label.className = 'diff-file-path';
    label.textContent = path;
    header.appendChild(label);
    for (const action of this.createFileActions?.(path) || []) header.appendChild(action);
    return header;
  }

  /** Scrolls a file into view and briefly marks it; returns false when absent. */
  scrollToFile(path: string): boolean {
    if (this.virtualMode) {
      const file = this.virtualFiles.find(item => item.path === path);
      if (!file) return false;
      this.body.scrollTop = file.top;
      this.renderVirtualViewport(true);
    }
    const blocks = [...this.body.querySelectorAll<HTMLElement>('.diff-file-block')];
    const block = blocks.find(element => element.dataset.filePath === path);
    if (!block) return false;
    this.clearFileTargetTimer();
    block.scrollIntoView({
      behavior: this.virtualMode || this.prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start'
    });
    block.classList.add('is-file-target');
    this.fileTargetTimer = window.setTimeout(() => {
      block.classList.remove('is-file-target');
      this.fileTargetTimer = 0;
    }, 1000);
    return true;
  }

  clearFileTargetTimer(): void {
    if (!this.fileTargetTimer) return;
    window.clearTimeout(this.fileTargetTimer);
    this.fileTargetTimer = 0;
  }

  destroy(): void {
    this.clearFileTargetTimer();
    this.disableVirtualization();
  }
}

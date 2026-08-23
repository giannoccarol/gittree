import type { InspectorGraph } from './inspector-graph.mts';

interface InspectorFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

export interface InspectorWorkspaceDependencies {
  container: HTMLElement | null;
  graphContainer: HTMLElement | null;
  filesPanel: HTMLElement | null;
  fileList: HTMLElement | null;
  filesToggle: HTMLElement | null;
  diffContainer: HTMLElement | null;
  translate: (key: string, options?: Record<string, unknown>) => string;
  storage?: Storage | null;
  onGraphSelect?: ((hash: string) => void) | null;
  onGraphRequestMore?: (() => void) | null;
  onFileSelect?: ((path: string) => void) | null;
  onFilesOpenChange?: ((open: boolean) => void) | null;
}

export class InspectorWorkspace {
  container: HTMLElement | null;
  graphContainer: HTMLElement | null;
  filesPanel: HTMLElement | null;
  fileList: HTMLElement | null;
  filesToggle: HTMLElement | null;
  diffContainer: HTMLElement | null;
  translate: (key: string, options?: Record<string, unknown>) => string;
  storage: Storage | null;
  onGraphSelect: ((hash: string) => void) | null;
  onGraphRequestMore: (() => void) | null;
  onFileSelect: ((path: string) => void) | null;
  onFilesOpenChange: ((open: boolean) => void) | null;
  storageKey: string;
  files: InspectorFile[];
  selectedFile: string | null;
  fileSignature: string;
  filesOpen: boolean;
  mounted: boolean;
  fileCount: Element | null;
  graph: InspectorGraph | null;
  handleFilesToggle: () => void;
  handleFileClick: (event: MouseEvent) => void;

  constructor({
    container,
    graphContainer,
    filesPanel,
    fileList,
    filesToggle,
    diffContainer,
    translate,
    storage = null,
    onGraphSelect = null,
    onGraphRequestMore = null,
    onFileSelect = null,
    onFilesOpenChange = null
  }: InspectorWorkspaceDependencies) {
    this.container = container;
    this.graphContainer = graphContainer;
    this.filesPanel = filesPanel;
    this.fileList = fileList;
    this.filesToggle = filesToggle;
    this.diffContainer = diffContainer;
    this.translate = translate;
    this.storage = storage ?? null;
    this.onGraphSelect = onGraphSelect ?? null;
    this.onGraphRequestMore = onGraphRequestMore ?? null;
    this.onFileSelect = onFileSelect ?? null;
    this.onFilesOpenChange = onFilesOpenChange ?? null;
    this.storageKey = 'gittree.inspector.files.open';
    this.files = [];
    this.selectedFile = null;
    this.fileSignature = '';
    this.filesOpen = this.restoreFilesOpen();
    this.mounted = false;
    this.graph = null;

    this.fileCount = container?.querySelector('[data-inspector-file-count]') || null;
    this.handleFilesToggle = () => this.setFilesOpen(!this.filesOpen);
    this.handleFileClick = event => {
      const item = (event.target as HTMLElement).closest?.('.inspector-file-item') as HTMLElement | null;
      if (item?.dataset.path) this.selectFile(item.dataset.path);
    };
  }

  mount(): void {
    if (this.mounted || !this.container) return;
    this.mounted = true;
    const InspectorGraphCtor = (window as unknown as { InspectorGraph: typeof InspectorGraph }).InspectorGraph;
    this.graph = new InspectorGraphCtor({
      container: this.graphContainer,
      translate: this.translate,
      onSelect: this.onGraphSelect,
      onRequestMore: this.onGraphRequestMore
    });
    this.graph.mount();
    this.filesToggle?.addEventListener('click', this.handleFilesToggle);
    this.fileList?.addEventListener('click', this.handleFileClick);
    this.setFilesOpen(this.filesOpen, false, false);
    this.renderFiles();
  }

  update({
    graph = {},
    files = [],
    selectedFile = null,
    selectedHash = null
  }: {
    graph?: Record<string, unknown>;
    files?: InspectorFile[];
    selectedFile?: string | null;
    selectedHash?: string | null;
  } = {}, options: { syncFilesOpen?: boolean; filesOpen?: boolean } = {}): void {
    this.graph?.update({ ...graph, selectedHash: selectedHash || (graph as { selectedHash?: string }).selectedHash || null });
    this.selectedFile = typeof selectedFile === 'string' ? selectedFile : null;
    const nextFiles = Array.isArray(files) ? files : [];
    const nextSignature = nextFiles
      .map(file => `${file.path}:${file.status}:${file.additions}:${file.deletions}`)
      .join('|');
    this.files = nextFiles;
    if (nextSignature !== this.fileSignature) {
      this.fileSignature = nextSignature;
      this.renderFiles();
    } else {
      this.updateVisibleFileSelection();
    }
    if (options.syncFilesOpen && typeof options.filesOpen === 'boolean') {
      this.setFilesOpen(options.filesOpen, false, false);
    }
  }

  refreshTranslations(): void {
    this.graph?.refreshTranslations();
    this.setFilesOpen(this.filesOpen, false, false);
    this.renderFiles();
  }

  restoreFilesOpen(): boolean {
    try {
      return this.storage?.getItem(this.storageKey) !== '0';
    } catch {
      return true;
    }
  }

  setFilesOpen(open: boolean, persist = true, notify = true): void {
    this.filesOpen = Boolean(open);
    this.container?.classList.toggle('files-collapsed', !this.filesOpen);
    this.filesPanel?.classList.toggle('is-collapsed', !this.filesOpen);
    if (this.filesToggle) {
      const key = this.filesOpen ? 'details.filesClose' : 'details.filesOpen';
      this.filesToggle.setAttribute('aria-expanded', String(this.filesOpen));
      this.filesToggle.setAttribute('aria-label', this.translate(key));
      this.filesToggle.title = this.translate(key);
      const icon = this.filesToggle.querySelector('i');
      if (icon) icon.className = `ph ph-caret-${this.filesOpen ? 'right' : 'left'}`;
    }
    if (persist) {
      try {
        this.storage?.setItem(this.storageKey, this.filesOpen ? '1' : '0');
      } catch {
        // The panel remains usable when storage is unavailable.
      }
    }
    if (notify) this.onFilesOpenChange?.(this.filesOpen);
  }

  renderFiles(): void {
    if (!this.fileList) return;
    if (this.fileCount) {
      this.fileCount.textContent = this.translate('details.files', { count: this.files.length });
    }
    if (!this.files.length) {
      const empty = document.createElement('div');
      empty.className = 'inspector-side-empty';
      const icon = document.createElement('i');
      icon.className = 'ph ph-files';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = this.translate('details.fileListEmpty');
      empty.append(icon, label);
      this.fileList.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    this.files.forEach((file, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'inspector-file-item';
      item.dataset.path = file.path;
      item.style.setProperty('--file-index', String(index));
      item.title = file.path;
      item.setAttribute('role', 'option');

      const status = document.createElement('span');
      status.className = `inspector-file-status is-${String(file.status || 'M').toLowerCase()}`;
      const statusIcon = document.createElement('i');
      statusIcon.className = `ph ${this.statusIcon(String(file.status))}`;
      statusIcon.setAttribute('aria-hidden', 'true');
      status.title = this.translate(this.statusLabel(String(file.status)));
      status.appendChild(statusIcon);

      const path = document.createElement('span');
      path.className = 'inspector-file-path';
      path.textContent = file.path;

      const stats = document.createElement('span');
      stats.className = 'inspector-file-stats';
      if (file.additions) {
        const additions = document.createElement('span');
        additions.className = 'is-addition';
        additions.textContent = `+${file.additions}`;
        stats.appendChild(additions);
      }
      if (file.deletions) {
        const deletions = document.createElement('span');
        deletions.className = 'is-deletion';
        deletions.textContent = `−${file.deletions}`;
        stats.appendChild(deletions);
      }
      item.append(status, path, stats);
      fragment.appendChild(item);
    });
    this.fileList.replaceChildren(fragment);
    this.updateVisibleFileSelection();
  }

  statusIcon(status: string): string {
    if (status === 'A') return 'ph-plus';
    if (status === 'D') return 'ph-minus';
    if (status === 'R') return 'ph-arrows-left-right';
    return 'ph-pencil-simple';
  }

  statusLabel(status: string): string {
    if (status === 'A') return 'details.fileAdded';
    if (status === 'D') return 'details.fileDeleted';
    if (status === 'R') return 'details.fileRenamed';
    return 'details.fileModified';
  }

  selectFile(path: string): void {
    this.selectedFile = path;
    this.updateVisibleFileSelection();
    if (this.onFileSelect) this.onFileSelect(path);
    else this.scrollToFile(path);
  }

  setSelectedFile(path: string | null): void {
    this.selectedFile = typeof path === 'string' ? path : null;
    this.updateVisibleFileSelection();
  }

  updateVisibleFileSelection(): void {
    if (!this.fileList) return;
    for (const item of this.fileList.querySelectorAll<HTMLElement>('.inspector-file-item')) {
      const selected = item.dataset.path === this.selectedFile;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', String(selected));
    }
  }

  scrollToFile(path: string): boolean {
    const blocks = [...(this.diffContainer?.querySelectorAll<HTMLElement>('.diff-file-block') || [])];
    const block = blocks.find(element => element.dataset.filePath === path);
    if (!block) return false;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    block.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    block.classList.add('is-file-target');
    window.setTimeout(() => block.classList.remove('is-file-target'), 1000);
    return true;
  }

  destroy(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.graph?.destroy();
    this.filesToggle?.removeEventListener('click', this.handleFilesToggle);
    this.fileList?.removeEventListener('click', this.handleFileClick);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { InspectorWorkspace: typeof InspectorWorkspace }).InspectorWorkspace = InspectorWorkspace;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = InspectorWorkspace;
}

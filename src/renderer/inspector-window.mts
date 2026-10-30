import { InspectorWorkspace } from './components/inspector-workspace.mts';
import { DiffRenderer, type DiffMode } from './components/diff-renderer.mts';

type InspectorKind = 'empty' | 'commit' | 'working-file' | 'pull-request';

interface InspectorPayload {
  kind?: InspectorKind;
  title?: string;
  meta?: string;
  theme?: string;
  tone?: string;
  mode?: string;
  eyebrow?: string;
  wordLevel?: boolean;
  diffText?: string;
  files?: Array<{ path: string; status?: string; additions?: number; deletions?: number }>;
  selectedFile?: string | null;
  filesOpen?: boolean;
}

const bridge = window.gitTree;
const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const body = byId('inspector-body');
const title = byId('inspector-title');
const meta = byId('inspector-meta');
const eyebrow = byId('inspector-eyebrow');
const diffControls = byId('inspector-diff-controls');
const unifiedButton = byId('inspector-mode-unified');
const splitButton = byId('inspector-mode-split');
const wordButton = byId('inspector-word');

const fallbackStrings: Record<string, string> = {
  'details.noChanges': 'No changes',
  'details.placeholder': 'Select a commit to inspect its changes.',
  'details.popoutUnavailable': 'This content is shown in the main window only.',
  'details.fileListEmpty': 'No changed files',
  'details.filesOpen': 'Show changed files',
  'details.filesClose': 'Hide changed files',
  'details.fileAdded': 'Added file',
  'details.fileDeleted': 'Deleted file',
  'details.fileModified': 'Modified file',
  'details.fileRenamed': 'Renamed file'
};

function translate(key: string, options: Record<string, unknown> = {}): string {
  if (window.i18next?.isInitialized) return window.t(key, options);
  if (key === 'details.files') {
    const count = Number(options.count) || 0;
    return `${count} ${count === 1 ? 'file' : 'files'}`;
  }
  return fallbackStrings[key] || key;
}

const renderer = new DiffRenderer({ body, translate });

const inspectorWorkspace = new InspectorWorkspace({
  container: byId('inspector-workspace'),
  graphContainer: null,
  filesPanel: byId('inspector-files-panel'),
  fileList: byId('inspector-file-list'),
  filesToggle: byId('btn-toggle-inspector-files'),
  diffContainer: body,
  translate,
  storage: localStorage,
  onFileSelect: path => {
    if (renderer.scrollToFile(path)) inspectorWorkspace.setSelectedFile(path);
  }
});
inspectorWorkspace.mount();

// The window follows layout changes made in the main window and keeps its own
// choice when the user changes it here.
const view: { mode: DiffMode; wordLevel: boolean; received: boolean } = {
  mode: 'unified',
  wordLevel: true,
  received: false
};
let lastPayload: InspectorPayload | null = null;
let renderedSource: { kind: InspectorKind; diffText: string } | null = null;

function syncControls(): void {
  unifiedButton.classList.toggle('active', view.mode === 'unified');
  unifiedButton.setAttribute('aria-pressed', String(view.mode === 'unified'));
  splitButton.classList.toggle('active', view.mode === 'split');
  splitButton.setAttribute('aria-pressed', String(view.mode === 'split'));
  wordButton.classList.toggle('active', view.wordLevel);
  wordButton.setAttribute('aria-pressed', String(view.wordLevel));
}

function renderBody(payload: InspectorPayload, force = false): void {
  const kind = payload.kind || 'empty';
  const diffText = payload.diffText || '';
  if (!force && renderedSource?.kind === kind && renderedSource.diffText === diffText) return;
  renderedSource = { kind, diffText };
  diffControls.classList.toggle('is-hidden', !diffText);
  if (kind === 'pull-request') {
    renderer.renderPlaceholder('ph-arrow-square-left', translate('details.popoutUnavailable'));
  } else if (kind === 'empty') {
    renderer.renderPlaceholder('ph-cursor-click', translate('details.placeholder'));
  } else {
    renderer.render(diffText, { mode: view.mode, wordLevel: view.wordLevel, expanded: true });
  }
}

function renderPayload(payload: InspectorPayload): void {
  const previous = lastPayload;
  lastPayload = payload;
  if (payload.theme) document.documentElement.dataset.theme = payload.theme;
  if (payload.tone) document.documentElement.dataset.tone = payload.tone;
  document.title = payload.title || 'Inspector';
  title.textContent = payload.title || 'Inspector';
  title.title = title.textContent;
  meta.textContent = payload.meta || '';
  meta.classList.toggle('is-hidden', !payload.meta);
  eyebrow.textContent = payload.eyebrow || 'Inspector';

  let layoutChanged = false;
  const mode: DiffMode = payload.mode === 'split' ? 'split' : 'unified';
  if (!view.received || mode !== (previous?.mode === 'split' ? 'split' : 'unified')) {
    layoutChanged = layoutChanged || view.mode !== mode;
    view.mode = mode;
  }
  const wordLevel = payload.wordLevel !== false;
  if (!view.received || wordLevel !== (previous?.wordLevel !== false)) {
    layoutChanged = layoutChanged || view.wordLevel !== wordLevel;
    view.wordLevel = wordLevel;
  }
  syncControls();
  renderBody(payload, layoutChanged);

  inspectorWorkspace.update({
    files: payload.files,
    selectedFile: payload.selectedFile
  }, {
    syncFilesOpen: !view.received,
    filesOpen: payload.filesOpen
  });
  view.received = true;
}

function setLocalLayout(next: Partial<Pick<typeof view, 'mode' | 'wordLevel'>>): void {
  Object.assign(view, next);
  syncControls();
  if (lastPayload) renderBody(lastPayload, true);
}

unifiedButton.addEventListener('click', () => setLocalLayout({ mode: 'unified' }));
splitButton.addEventListener('click', () => setLocalLayout({ mode: 'split' }));
wordButton.addEventListener('click', () => setLocalLayout({ wordLevel: !view.wordLevel }));
syncControls();

bridge.onInspectorRender(payload => renderPayload(payload as InspectorPayload));

window.I18n?.init()
  .then(() => {
    window.I18n!.translateDOM();
    inspectorWorkspace.refreshTranslations();
    if (lastPayload) {
      renderedSource = null;
      renderPayload(lastPayload);
    }
  })
  .catch(() => {
    // English fallbacks keep the detached inspector usable.
  });

export {};

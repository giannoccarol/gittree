import { InspectorWorkspace } from './components/inspector-workspace.mts';

interface InspectorPayload {
  title?: string;
  meta?: string;
  theme?: string;
  tone?: string;
  mode?: string;
  modeLabel?: string;
  eyebrow?: string;
  wordLevel?: boolean;
  html?: string;
  diffText?: string;
  graph?: Record<string, unknown>;
  files?: Array<{ path: string; status?: string; additions?: number; deletions?: number }>;
  selectedFile?: string | null;
  filesOpen?: boolean;
}

const bridge = window.gitTree;
const body = document.getElementById('inspector-body')! as HTMLElement;
const title = document.getElementById('inspector-title')! as HTMLElement;
const meta = document.getElementById('inspector-meta')! as HTMLElement;
const eyebrow = document.getElementById('inspector-eyebrow')! as HTMLElement;
const mode = document.getElementById('inspector-mode')! as HTMLElement;
const word = document.getElementById('inspector-word')! as HTMLElement;

const fallbackStrings: Record<string, string> = {
  'details.graphBranch': 'Branch',
  'details.graphMessage': 'Commit message',
  'details.graphNoBranch': 'No branch reference',
  'details.graphEmpty': 'No commits loaded',
  'details.noChanges': 'No content',
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

const inspectorWorkspace = new InspectorWorkspace({
  container: document.getElementById('inspector-workspace')!,
  graphContainer: document.getElementById('inspector-graph-view')!,
  filesPanel: document.getElementById('inspector-files-panel')!,
  fileList: document.getElementById('inspector-file-list')!,
  filesToggle: document.getElementById('btn-toggle-inspector-files')!,
  diffContainer: body,
  translate,
  storage: localStorage
});
inspectorWorkspace.mount();

let receivedPayload = false;
let lastPayload: InspectorPayload | null = null;

function renderEmptyContent(): void {
  const placeholder = document.createElement('div');
  placeholder.className = 'diff-placeholder';
  const label = document.createElement('span');
  label.textContent = translate('details.noChanges');
  placeholder.appendChild(label);
  body.replaceChildren(placeholder);
}

function renderPayload(payload: InspectorPayload): void {
  lastPayload = payload;
  if (payload.theme) document.documentElement.dataset.theme = payload.theme;
  if (payload.tone) document.documentElement.dataset.tone = payload.tone;
  document.title = payload.title || 'Inspector';
  title.textContent = payload.title || 'Inspector';
  title.title = title.textContent;
  meta.textContent = payload.meta || '';
  meta.classList.toggle('is-hidden', !payload.meta);
  eyebrow.textContent = payload.eyebrow || 'Inspector';
  mode.textContent = payload.modeLabel || (payload.mode === 'split' ? 'Split' : 'Unified');
  word.classList.toggle('is-hidden', !payload.wordLevel);

  if (payload.html) {
    body.innerHTML = payload.html;
  } else if (payload.diffText) {
    const pre = document.createElement('pre');
    pre.className = 'diff-raw';
    pre.textContent = payload.diffText;
    body.replaceChildren(pre);
  } else {
    renderEmptyContent();
  }

  inspectorWorkspace.update({
    graph: payload.graph,
    selectedHash: (payload.graph as { selectedHash?: string | null } | undefined)?.selectedHash ?? null,
    files: payload.files,
    selectedFile: payload.selectedFile
  }, {
    syncFilesOpen: !receivedPayload,
    filesOpen: payload.filesOpen
  });
  receivedPayload = true;
}

bridge.onInspectorRender(payload => renderPayload(payload as InspectorPayload));

window.I18n?.init()
  .then(() => {
    window.I18n!.translateDOM();
    inspectorWorkspace.refreshTranslations();
    if (lastPayload) renderPayload(lastPayload);
  })
  .catch(() => {
    // English fallbacks keep the detached inspector usable.
  });

export {};

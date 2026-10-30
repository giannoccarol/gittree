function boundedString(value: unknown, maxLength: number, fallback = ''): string {
  return typeof value === 'string' && value.length <= maxLength ? value : fallback;
}

function boundedInteger(value: unknown, maximum: number, fallback = 0): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum ? value as number : fallback;
}

function sanitizeFilesPayload(files: unknown) {
  return (Array.isArray(files) ? files : []).slice(0, 5000)
    .map((raw): Record<string, unknown> => {
      const file = raw as { path?: unknown; oldPath?: unknown; status?: unknown; additions?: unknown; deletions?: unknown };
      return {
        path: boundedString(file.path, 4000),
        oldPath: boundedString(file.oldPath, 4000) || null,
        status: ['A', 'D', 'M', 'R'].includes(String(file.status)) ? String(file.status) : 'M',
        additions: boundedInteger(file.additions, 10_000_000),
        deletions: boundedInteger(file.deletions, 10_000_000)
      };
    })
    .filter(file => file.path);
}

interface InspectorPayloadSource {
  kind?: unknown;
  title?: unknown;
  meta?: unknown;
  theme?: unknown;
  tone?: unknown;
  mode?: unknown;
  eyebrow?: unknown;
  wordLevel?: unknown;
  files?: unknown;
  selectedFile?: unknown;
  filesOpen?: unknown;
  diffText?: unknown;
}

const INSPECTOR_KINDS = ['empty', 'commit', 'working-file', 'pull-request'];

function sanitizeInspectorPayload(payload: unknown) {
  // Payloads cross the IPC seam untyped; every field is re-validated below.
  // The detached window renders the diff text itself: no markup is accepted.
  const source = (typeof payload === 'object' && payload !== null
    ? payload
    : null) as InspectorPayloadSource | null;
  const theme = typeof source?.theme === 'string' ? source.theme : '';
  return {
    kind: INSPECTOR_KINDS.includes(String(source?.kind)) ? String(source?.kind) : 'empty',
    title: typeof source?.title === 'string' && source.title.length <= 200
      ? source.title
      : 'Inspector',
    meta: typeof source?.meta === 'string' && source.meta.length <= 400
      ? source.meta
      : '',
    theme: ['light', 'dark'].includes(theme) ? theme : 'light',
    tone: typeof source?.tone === 'string' && /^[a-z]{1,32}$/.test(source.tone)
      ? source.tone
      : '',
    mode: source?.mode === 'split' ? 'split' : 'unified',
    eyebrow: typeof source?.eyebrow === 'string' && source.eyebrow.length <= 80
      ? source.eyebrow
      : 'Inspector',
    wordLevel: source?.wordLevel === true,
    files: sanitizeFilesPayload(source?.files),
    selectedFile: boundedString(source?.selectedFile, 4000) || null,
    filesOpen: source?.filesOpen !== false,
    diffText: typeof source?.diffText === 'string' && source.diffText.length <= 10_000_000
      ? source.diffText
      : ''
  };
}

interface BrowserWindowLike {
  isDestroyed(): boolean;
  focus(): void;
  loadFile(path: string): Promise<void>;
  destroy(): void;
  on(event: string, listener: () => void): unknown;
  webContents: { send(channel: string, payload: unknown): void; once(event: string, listener: () => void): unknown };
}

export interface InspectorWindowControllerOptions {
  BrowserWindow: new (options: Record<string, unknown>) => BrowserWindowLike;
  getMainWindow: () => BrowserWindowLike | null;
  lockDownWindow: (window: BrowserWindowLike) => void;
  iconPath: () => string;
  preloadPath: string;
  htmlPath: string;
  sendToRenderer: (channel: string, payload?: unknown) => void;
}

export function createInspectorWindowController({
  BrowserWindow,
  getMainWindow,
  lockDownWindow,
  iconPath,
  preloadPath,
  htmlPath,
  sendToRenderer
}: InspectorWindowControllerOptions) {
  let inspectorWindow: BrowserWindowLike | null = null;

  function open(payload: unknown) {
    const safePayload = sanitizeInspectorPayload(payload);
    if (inspectorWindow && !inspectorWindow.isDestroyed()) {
      inspectorWindow.focus();
      inspectorWindow.webContents.send('inspector:render', safePayload);
      return { success: true };
    }
    inspectorWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 620,
      minHeight: 440,
      parent: getMainWindow(),
      title: safePayload.title,
      icon: iconPath(),
      backgroundColor: '#f7f9fc',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    lockDownWindow(inspectorWindow);
    inspectorWindow.loadFile(htmlPath);
    inspectorWindow.webContents.once('did-finish-load', () => {
      inspectorWindow!.webContents.send('inspector:render', safePayload);
    });
    inspectorWindow.on('closed', () => {
      inspectorWindow = null;
      sendToRenderer('inspector:closed');
    });
    return { success: true };
  }

  function update(payload: unknown) {
    if (!inspectorWindow || inspectorWindow.isDestroyed()) return { success: false };
    inspectorWindow.webContents.send('inspector:render', sanitizeInspectorPayload(payload));
    return { success: true };
  }

  function destroy() {
    if (inspectorWindow && !inspectorWindow.isDestroyed()) inspectorWindow.destroy();
    inspectorWindow = null;
  }

  return { open, update, destroy };
}

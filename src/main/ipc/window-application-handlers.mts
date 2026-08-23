import { spawn } from 'node:child_process';

function launchTerminal(repoPath: string, platform: string) {
  const launch = (command: string, args: string[]) => {
    const child = spawn(command, args, {
      cwd: repoPath,
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => {});
    child.unref();
  };
  if (platform === 'win32') {
    launch('cmd.exe', ['/d', '/c', 'start', 'cmd.exe', '/d', '/k']);
  } else if (platform === 'darwin') {
    launch('open', ['-a', 'Terminal', repoPath]);
  } else {
    launch('sh', [
      '-c',
      'x-terminal-emulator --working-directory "$1" || ' +
        'gnome-terminal --working-directory "$1" || ' +
        'konsole --workdir "$1" || ' +
        'xterm -e \'cd "$1" && exec "$SHELL"\' gittree-term "$1"',
      'gittree-terminal',
      repoPath
    ]);
  }
  return { ok: true };
}

interface BrowserWindowLike {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
}

interface UpdateServiceLike {
  getState(): unknown;
  check(manual: boolean): Promise<unknown>;
  download(): Promise<unknown>;
  install(): Promise<unknown>;
}

interface WindowApplicationDependencies {
  registerHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  registerManagedRepoHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  getMainWindow: () => BrowserWindowLike | null;
  getWindowState: () => unknown;
  getUpdateService?: () => UpdateServiceLike | null | undefined;
  getAppVersion: () => string;
  isPackaged: boolean;
  setTheme: (theme: string, background: string) => void;
  openExternal: (url: string) => void;
  openPath: (repoPath: string) => Promise<string | undefined> | string | undefined;
  platform: string;
  getGitVersion: () => unknown;
  exportDiagnostics: () => Promise<unknown> | unknown;
  showOpenDialog?: (window: unknown, options: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths?: string[] }>;
  authorizeDirectory?: (directoryPath: unknown) => unknown;
  openInspector: (payload: unknown) => unknown;
  updateInspector: (payload: unknown) => unknown;
}

function registerWindowHandlers({ registerHandler, getMainWindow, getWindowState }: Pick<WindowApplicationDependencies, 'registerHandler' | 'getMainWindow' | 'getWindowState'>) {
  registerHandler('window:minimize', () => getMainWindow()?.minimize());
  registerHandler('window:toggle-maximize', () => {
    const window = getMainWindow();
    if (!window) return getWindowState();
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return getWindowState();
  });
  registerHandler('window:get-state', () => getWindowState());
  registerHandler('window:close', () => getMainWindow()?.close());
}

function registerUpdateHandlers({ registerHandler, getUpdateService, getAppVersion, isPackaged }: WindowApplicationDependencies) {
  registerHandler('update:get-state', () => (
    getUpdateService?.()?.getState() || {
      status: isPackaged ? 'idle' : 'disabled',
      currentVersion: getAppVersion()
    }
  ));
  registerHandler('update:check', () => (
    getUpdateService?.()?.check?.(true) || { success: false, error: 'Updater is not ready' }
  ));
  registerHandler('update:download', () => (
    getUpdateService?.()?.download?.() || { success: false, error: 'Updater is not ready' }
  ));
  registerHandler('update:install', () => (
    getUpdateService?.()?.install?.() || { success: false, error: 'Updater is not ready' }
  ));
}

export function registerWindowApplicationHandlers(dependencies: WindowApplicationDependencies) {
  const {
    registerHandler,
    registerManagedRepoHandler,
    getMainWindow,
    setTheme,
    openExternal,
    openPath,
    platform,
    getAppVersion,
    getGitVersion,
    exportDiagnostics,
    showOpenDialog,
    authorizeDirectory = (directoryPath: unknown) => directoryPath,
    openInspector,
    updateInspector
  } = dependencies;
  registerWindowHandlers(dependencies);
  registerUpdateHandlers(dependencies);
  registerHandler('app:set-theme', (theme: string, background: string) => setTheme(theme, background));
  registerHandler('app:open-external', (url: string) => openExternal(url));
  registerManagedRepoHandler('app:open-explorer', async (repoPath: string) => {
    const error = await openPath(repoPath);
    return error ? { error } : { ok: true };
  });
  registerManagedRepoHandler('app:open-terminal', (repoPath: string) => (
    launchTerminal(repoPath, platform)
  ));
  registerHandler('app:version', () => getAppVersion());
  registerHandler('app:git-version', () => getGitVersion());
  registerHandler('app:export-diagnostics', () => exportDiagnostics());
  registerHandler('window:open-inspector', (payload: unknown) => openInspector(payload));
  registerHandler('window:update-inspector', (payload: unknown) => updateInspector(payload));
  registerHandler('dialog:select-directory', async () => {
    const result = await showOpenDialog!(getMainWindow(), { properties: ['openDirectory'] });
    return !result.canceled && result.filePaths!.length
      ? authorizeDirectory(result.filePaths![0])
      : null;
  });
}

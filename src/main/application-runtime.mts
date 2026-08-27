import { shouldHandoverToSecondInstance } from './single-instance.mts';

interface RuntimeHost {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  requestSingleInstanceLock(additionalData?: { version: string }): boolean;
  quit(): void;
  whenReady(): Promise<void>;
}

interface RuntimeWindow {
  webContents: {
    once(event: string, listener: () => void): unknown;
    removeListener?(event: string, listener: () => void): unknown;
    send(channel: string, payload: unknown): void;
  };
}

export function findDeepLink(argv: unknown): string | undefined {
  const candidates = Array.isArray(argv) ? argv : [];
  return candidates.find((argument): argument is string =>
    typeof argument === 'string' && argument.startsWith('gittree://')
  );
}

export interface ApplicationRuntimeOptions {
  host: RuntimeHost;
  initialize: () => Promise<void>;
  createWindow: () => void;
  getMainWindow: () => RuntimeWindow | null;
  getWindowCount: () => number;
  focusMainWindow: () => void;
  handleDeepLink: (url: string) => void;
  argv?: string[];
  platform?: string;
  appVersion?: string;
  onHandoverRelaunch?: () => void;
  teardown?: () => void | Promise<void>;
}

export function createApplicationRuntime({
  host,
  initialize,
  createWindow,
  getMainWindow,
  getWindowCount,
  focusMainWindow,
  handleDeepLink,
  argv,
  platform,
  appVersion = '',
  onHandoverRelaunch,
  teardown = () => {}
}: ApplicationRuntimeOptions) {
  const pendingDeepLinks: string[] = [];
  const hostListeners: Array<[string, (...args: unknown[]) => void]> = [];
  let rendererReady = false;
  let rendererReadiness: { webContents: RuntimeWindow['webContents']; listener: () => void } | null = null;
  let started = false;

  const listen = (event: string, listener: (...args: unknown[]) => void) => {
    host.on(event, listener);
    hostListeners.push([event, listener]);
  };

  const dispatchDeepLink = (url: string | undefined) => {
    if (!url) return;
    if (!rendererReady) pendingDeepLinks.push(url);
    else handleDeepLink(url);
  };

  const attachRendererReadiness = () => {
    const window = getMainWindow();
    if (!window) return;
    if (rendererReadiness) {
      rendererReadiness.webContents.removeListener?.(
        'did-finish-load',
        rendererReadiness.listener
      );
    }
    rendererReady = false;
    const listener = () => {
      rendererReady = true;
      rendererReadiness = null;
      for (const url of pendingDeepLinks.splice(0)) handleDeepLink(url);
    };
    rendererReadiness = { webContents: window.webContents, listener };
    window.webContents.once('did-finish-load', listener);
  };

  let handingOverToNewVersion = false;

  const start = async () => {
    if (started) return true;
    const lockData = appVersion ? { version: appVersion } : undefined;
    if (!host.requestSingleInstanceLock(lockData)) {
      host.quit();
      return false;
    }
    started = true;
    listen('second-instance', (...args: unknown[]) => {
      if (handingOverToNewVersion) return;
      const secondArgv = args[1];
      const additionalData = args.length >= 4 ? args[3] : args[2];
      if (appVersion && shouldHandoverToSecondInstance(appVersion, additionalData)) {
        handingOverToNewVersion = true;
        onHandoverRelaunch?.();
        return;
      }
      focusMainWindow();
      dispatchDeepLink(findDeepLink(secondArgv));
    });
    listen('open-url', (...args: unknown[]) => {
      const event = args[0] as { preventDefault(): void };
      event.preventDefault();
      dispatchDeepLink(String(args[1] ?? ''));
    });
    listen('window-all-closed', () => {
      if (platform !== 'darwin') host.quit();
    });
    try {
      await host.whenReady();
      await initialize();
      createWindow();
      attachRendererReadiness();
      dispatchDeepLink(findDeepLink(argv));
      listen('activate', () => {
        if (getWindowCount() === 0) {
          createWindow();
          attachRendererReadiness();
        }
      });
      return true;
    } catch (error) {
      await stop();
      throw error;
    }
  };

  const stop = async () => {
    if (!started) return;
    started = false;
    if (rendererReadiness) {
      rendererReadiness.webContents.removeListener?.(
        'did-finish-load',
        rendererReadiness.listener
      );
      rendererReadiness = null;
    }
    for (const [event, listener] of hostListeners.splice(0)) {
      host.removeListener?.(event, listener);
    }
    pendingDeepLinks.splice(0);
    rendererReady = false;
    await teardown();
  };

  return { start, stop };
}

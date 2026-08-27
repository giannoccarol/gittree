import * as electron from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { UpdateInfo } from 'builder-util-runtime';

// electron-updater is CommonJS: resolve it through require so the real
// `autoUpdater` binding is available from this ESM module.
const require = createRequire(import.meta.url);

export const RELEASE_URL = 'https://github.com/giannoccarol/gittree/releases/latest';

interface DownloadProgress {
  percent: number;
  transferred?: number;
  total?: number;
}

export interface UpdateState {
  status: string;
  currentVersion: string;
  availableVersion: string | null;
  progress: number;
  error: string | null;
  packageType: string;
  autoInstall: boolean;
}

interface UpdateWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

interface ElectronAppLike {
  isPackaged: boolean;
  getVersion(): string;
}

interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export function readPackageType(
  platform: string = process.platform,
  resourcesPath: string = process.resourcesPath
): string {
  if (platform !== 'linux') return '';
  if (process.env.APPIMAGE) return 'appimage';
  if (process.execPath.toLowerCase().endsWith('.appimage')) return 'appimage';
  try {
    return fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim().toLowerCase();
  } catch {
    return 'native';
  }
}

export function supportsAutoInstall(platform: string, packageType: string): boolean {
  if (platform === 'win32' || platform === 'darwin') return true;
  return packageType === 'appimage';
}

export class UpdateService {
  window: UpdateWindow | null;
  notify: (channel: string, payload: unknown) => void;
  app: ElectronAppLike;
  autoUpdater: AutoUpdaterLike;
  platform: string;
  timers: {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    setImmediate: typeof setImmediate;
    clearTimeout: typeof clearTimeout;
    clearInterval: typeof clearInterval;
  };
  openExternal: (url: string) => Promise<void>;
  initialized: boolean;
  startupTimer: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setInterval> | null;
  updaterListeners: Array<[string, (...args: never[]) => void]>;
  packageType: string;
  autoInstall: boolean;
  state: UpdateState;

  constructor(
    window: UpdateWindow | null,
    dependencies: {
      notify?: (channel: string, payload: unknown) => void;
      app?: ElectronAppLike;
      autoUpdater?: AutoUpdaterLike;
      platform?: string;
      openExternal?: (url: string) => Promise<void>;
      setTimeout?: typeof setTimeout;
      setInterval?: typeof setInterval;
      setImmediate?: typeof setImmediate;
      clearTimeout?: typeof clearTimeout;
      clearInterval?: typeof clearInterval;
    } = {}
  ) {
    this.window = window;
    this.notify = dependencies.notify || ((channel: string, payload: unknown) => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
    });
    this.app = dependencies.app || (electron as unknown as { app: ElectronAppLike }).app;
    this.autoUpdater = dependencies.autoUpdater
      || (require('electron-updater') as { autoUpdater: AutoUpdaterLike }).autoUpdater;
    this.platform = dependencies.platform || process.platform;
    this.openExternal = dependencies.openExternal
      || (url => (electron as unknown as { shell: { openExternal(url: string): Promise<void> } }).shell.openExternal(url));
    this.timers = {
      setTimeout: dependencies.setTimeout || setTimeout,
      setInterval: dependencies.setInterval || setInterval,
      setImmediate: dependencies.setImmediate || setImmediate,
      clearTimeout: dependencies.clearTimeout || clearTimeout,
      clearInterval: dependencies.clearInterval || clearInterval
    };
    this.initialized = false;
    this.startupTimer = null;
    this.timer = null;
    this.updaterListeners = [];
    this.packageType = readPackageType(this.platform);
    this.autoInstall = supportsAutoInstall(this.platform, this.packageType);
    this.state = {
      status: this.app.isPackaged ? 'idle' : 'disabled',
      currentVersion: this.app.getVersion(),
      availableVersion: null,
      progress: 0,
      error: null,
      packageType: this.packageType,
      autoInstall: this.autoInstall
    };
  }

  setWindow(window: UpdateWindow | null): void {
    this.window = window;
    this.broadcast();
  }

  initialize(): void {
    if (this.initialized) {
      this.broadcast();
      return;
    }
    this.initialized = true;
    if (!this.app.isPackaged) {
      this.broadcast();
      return;
    }

    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = this.autoInstall;
    this.autoUpdater.allowDowngrade = false;
    this.autoUpdater.allowPrerelease = this.app.getVersion().includes('-');

    this.listenToUpdater('checking-for-update', () => this.setState({
      status: 'checking',
      error: null
    }));
    this.listenToUpdater('update-available', (info: UpdateInfo) => this.setState({
      status: 'available',
      availableVersion: info.version,
      progress: 0,
      error: null
    }));
    this.listenToUpdater('update-not-available', () => this.setState({
      status: 'idle',
      availableVersion: null,
      progress: 0,
      error: null
    }));
    this.listenToUpdater('download-progress', (progress: DownloadProgress) => this.setState({
      status: 'downloading',
      progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
      error: null
    }));
    this.listenToUpdater('update-downloaded', (info: UpdateInfo) => this.setState({
      status: 'downloaded',
      availableVersion: info.version,
      progress: 100,
      error: null
    }));
    this.listenToUpdater('error', (error: unknown) => this.setState({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    }));

    this.startupTimer = this.timers.setTimeout(() => this.check(false), 15000);
    this.startupTimer.unref?.();
    this.timer = this.timers.setInterval(() => this.check(false), 6 * 60 * 60 * 1000);
    this.timer.unref?.();
    this.broadcast();
  }

  listenToUpdater(event: string, listener: (...args: never[]) => void): void {
    this.autoUpdater.on(event, listener as (...args: unknown[]) => void);
    this.updaterListeners.push([event, listener]);
  }

  destroy(): void {
    if (this.startupTimer) this.timers.clearTimeout(this.startupTimer);
    if (this.timer) this.timers.clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
    for (const [event, listener] of this.updaterListeners.splice(0)) {
      this.autoUpdater.removeListener?.(event, listener as (...args: unknown[]) => void);
    }
    this.window = null;
    this.initialized = false;
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async check(manual = true): Promise<{ success: boolean; skipped?: boolean; error?: string; state: UpdateState }> {
    if (!this.app.isPackaged) {
      return { success: false, skipped: true, state: this.getState() };
    }
    if (['downloading', 'downloaded'].includes(this.state.status)) {
      return { success: false, skipped: true, state: this.getState() };
    }
    try {
      await this.autoUpdater.checkForUpdates();
      return { success: true, state: this.getState() };
    } catch (error) {
      this.setState({
        status: manual ? 'error' : 'idle',
        error: manual ? (error as Error).message : null
      });
      return { success: false, error: (error as Error).message, state: this.getState() };
    }
  }

  async download(): Promise<{ success: boolean; error?: string; state: UpdateState }> {
    if (this.state.status !== 'available') {
      return { success: false, error: 'No update is ready to download', state: this.getState() };
    }
    try {
      await this.autoUpdater.downloadUpdate();
      return { success: true, state: this.getState() };
    } catch (error) {
      this.setState({ status: 'error', error: (error as Error).message });
      return { success: false, error: (error as Error).message, state: this.getState() };
    }
  }

  install(): { success: boolean; error?: string; manual?: boolean } {
    if (this.state.status !== 'downloaded') {
      return { success: false, error: 'No downloaded update is ready to install' };
    }
    if (!this.autoInstall) {
      this.openExternal(RELEASE_URL).catch(() => {});
      return { success: true, manual: true };
    }
    this.timers.setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return { success: true };
  }

  setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.broadcast();
  }

  broadcast(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.notify('update:state', this.getState());
  }
}

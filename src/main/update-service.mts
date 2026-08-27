import * as electron from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { UpdateInfo } from 'builder-util-runtime';

// electron-updater is CommonJS: resolve it through require so the real
// `autoUpdater` binding is available from this ESM module.
const require = createRequire(import.meta.url);

export const RELEASE_URL = 'https://github.com/giannoccarol/gittree/releases/latest';
export const DEFAULT_UPDATER_CACHE_DIR_NAMES = ['gittree-updater', 'GitTree-updater'];

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
  cachedInstall: boolean;
  pendingPackagePath: string | null;
}

interface UpdateWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

interface ElectronAppLike {
  isPackaged: boolean;
  getVersion(): string;
  quit(): void;
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

type SpawnProcess = (
  command: string,
  args: string[],
  options: { stdio: 'ignore' }
) => {
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
};

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

export function supportsCachedPackageInstall(platform: string, packageType: string): boolean {
  if (platform !== 'linux' || packageType === 'appimage') return false;
  return ['pacman', 'deb', 'rpm', 'native'].includes(packageType);
}

export function resolveLinuxCacheHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  if (xdgCache) return xdgCache;
  return path.join(os.homedir(), '.cache');
}

export function listPendingPackageDirs(cacheHome: string, dirNames: string[]): string[] {
  return dirNames.map(name => path.join(cacheHome, name, 'pending'));
}

export function inferPackageTypeFromPath(packagePath: string): 'pacman' | 'deb' | 'rpm' | null {
  const lower = packagePath.toLowerCase();
  if (lower.endsWith('.pacman')) return 'pacman';
  if (lower.endsWith('.deb')) return 'deb';
  if (lower.endsWith('.rpm')) return 'rpm';
  return null;
}

export function parseVersionFromPackageName(filename: string): string | null {
  const match = String(filename || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function compareVersions(left: string, right: string): number {
  const normalize = (value: string) => String(value || '').split(/[.-]/).map(part => parseInt(part, 10) || 0);
  const a = normalize(left);
  const b = normalize(right);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function pendingPackageNeedsInstall(packagePath: string, currentVersion: string): boolean {
  const pendingVersion = parseVersionFromPackageName(path.basename(packagePath));
  if (!pendingVersion || !currentVersion) return true;
  return compareVersions(pendingVersion, currentVersion) > 0;
}

export function clearPendingPackages(
  pendingDirs: string | string[],
  deps: {
    readdirSync?: typeof fs.readdirSync;
    existsSync?: typeof fs.existsSync;
    unlinkSync?: typeof fs.unlinkSync;
  } = {}
): void {
  const readdirSync = deps.readdirSync ?? fs.readdirSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync;
  const dirs = Array.isArray(pendingDirs) ? pendingDirs : [pendingDirs];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!inferPackageTypeFromPath(name) && name !== 'update-info.json') continue;
        try { unlinkSync(path.join(dir, name)); } catch {}
      }
    } catch {}
  }
}

export function findPendingPackage(
  pendingDirs: string | string[],
  deps: {
    readdirSync?: typeof fs.readdirSync;
    existsSync?: typeof fs.existsSync;
  } = {}
): string | null {
  const readdirSync = deps.readdirSync ?? fs.readdirSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const dirs = Array.isArray(pendingDirs) ? pendingDirs : [pendingDirs];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        const inferred = inferPackageTypeFromPath(name);
        if (inferred) return path.join(dir, name);
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function resolvePackageTypeForInstall(
  configuredType: string,
  packagePath: string | null
): 'pacman' | 'deb' | 'rpm' | null {
  if (packagePath) {
    const inferred = inferPackageTypeFromPath(packagePath);
    if (inferred) return inferred;
  }
  if (configuredType === 'pacman' || configuredType === 'deb' || configuredType === 'rpm') {
    return configuredType;
  }
  return null;
}

export function buildCachedInstallCommand(
  packageType: 'pacman' | 'deb' | 'rpm',
  packagePath: string
): string[] {
  switch (packageType) {
    case 'pacman':
      return ['pkexec', 'pacman', '-U', '--noconfirm', packagePath];
    case 'deb':
      return ['pkexec', 'dpkg', '-i', packagePath];
    case 'rpm':
      return ['pkexec', 'rpm', '-Uvh', packagePath];
    default:
      return [];
  }
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
  spawnProcess: SpawnProcess;
  cacheHome: string;
  updaterCacheDirNames: string[];
  initialized: boolean;
  startupTimer: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setInterval> | null;
  updaterListeners: Array<[string, (...args: never[]) => void]>;
  packageType: string;
  autoInstall: boolean;
  cachedInstall: boolean;
  pendingPackagePath: string | null;
  state: UpdateState;

  constructor(
    window: UpdateWindow | null,
    dependencies: {
      notify?: (channel: string, payload: unknown) => void;
      app?: ElectronAppLike;
      autoUpdater?: AutoUpdaterLike;
      platform?: string;
      openExternal?: (url: string) => Promise<void>;
      spawnProcess?: SpawnProcess;
      cacheHome?: string;
      updaterCacheDirNames?: string[];
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
    this.spawnProcess = dependencies.spawnProcess || spawn;
    this.cacheHome = dependencies.cacheHome
      ?? (this.platform === 'linux' ? resolveLinuxCacheHome() : '');
    this.updaterCacheDirNames = dependencies.updaterCacheDirNames || DEFAULT_UPDATER_CACHE_DIR_NAMES;
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
    this.cachedInstall = supportsCachedPackageInstall(this.platform, this.packageType);
    this.pendingPackagePath = null;
    this.state = {
      status: this.app.isPackaged ? 'idle' : 'disabled',
      currentVersion: this.app.getVersion(),
      availableVersion: null,
      progress: 0,
      error: null,
      packageType: this.packageType,
      autoInstall: this.autoInstall,
      cachedInstall: this.cachedInstall,
      pendingPackagePath: null
    };
  }

  setWindow(window: UpdateWindow | null): void {
    this.window = window;
    this.broadcast();
  }

  initialize(): void {
    if (this.initialized) {
      this.syncPendingState();
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

    this.syncPendingState();
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

  findCachedPendingPackage(): string | null {
    if (!this.cachedInstall || this.platform !== 'linux') return null;
    const pending = findPendingPackage(listPendingPackageDirs(this.cacheHome, this.updaterCacheDirNames));
    if (!pending) return null;
    if (!pendingPackageNeedsInstall(pending, this.app.getVersion())) return null;
    return pending;
  }

  reconcilePendingState(): void {
    if (!this.cachedInstall || this.platform !== 'linux') return;
    const pendingDirs = listPendingPackageDirs(this.cacheHome, this.updaterCacheDirNames);
    const rawPending = findPendingPackage(pendingDirs);
    if (rawPending && !pendingPackageNeedsInstall(rawPending, this.app.getVersion())) {
      clearPendingPackages(pendingDirs);
      this.pendingPackagePath = null;
      if (['available', 'downloaded', 'downloading'].includes(this.state.status)) {
        this.setState({
          status: 'idle',
          availableVersion: null,
          progress: 0,
          error: null,
          pendingPackagePath: null
        });
      }
      return;
    }

    const pending = rawPending && pendingPackageNeedsInstall(rawPending, this.app.getVersion())
      ? rawPending
      : null;
    this.pendingPackagePath = pending;
    if (!pending) return;
    if (['downloading', 'checking', 'available'].includes(this.state.status)) return;
    if (this.state.status !== 'downloaded') {
      this.setState({
        status: 'downloaded',
        availableVersion: parseVersionFromPackageName(path.basename(pending)) || this.state.availableVersion,
        progress: 100,
        error: null,
        pendingPackagePath: pending
      });
      return;
    }
    if (this.state.pendingPackagePath !== pending) {
      this.setState({ pendingPackagePath: pending });
    }
  }

  syncPendingState(): void {
    this.reconcilePendingState();
  }

  getState(): UpdateState {
    this.syncPendingState();
    return {
      ...this.state,
      pendingPackagePath: this.pendingPackagePath
    };
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

  async download(): Promise<{ success: boolean; error?: string; manual?: boolean; state: UpdateState }> {
    if (this.state.status !== 'available') {
      return { success: false, error: 'No update is ready to download', state: this.getState() };
    }
    if (!this.cachedInstall && !this.autoInstall) {
      await this.openExternal(RELEASE_URL);
      return { success: true, manual: true, state: this.getState() };
    }
    try {
      await this.autoUpdater.downloadUpdate();
      return { success: true, state: this.getState() };
    } catch (error) {
      this.setState({ status: 'error', error: (error as Error).message });
      return { success: false, error: (error as Error).message, state: this.getState() };
    }
  }

  async install(): Promise<{ success: boolean; error?: string; manual?: boolean; state?: UpdateState }> {
    this.syncPendingState();

    if (this.cachedInstall) {
      const pending = this.pendingPackagePath ?? this.findCachedPendingPackage();
      if (!pending) {
        if (this.state.status === 'downloaded') {
          await this.openExternal(RELEASE_URL);
          return { success: true, manual: true, state: this.getState() };
        }
        return {
          success: false,
          error: 'No downloaded update is ready to install',
          state: this.getState()
        };
      }
      const packageType = resolvePackageTypeForInstall(this.packageType, pending);
      if (!packageType) {
        return { success: false, error: 'Unsupported package format', state: this.getState() };
      }
      const command = buildCachedInstallCommand(packageType, pending);
      try {
        const exitCode = await this.runInstallCommand(command);
        if (exitCode === 0) {
          clearPendingPackages(listPendingPackageDirs(this.cacheHome, this.updaterCacheDirNames));
          this.pendingPackagePath = null;
          this.setState({
            status: 'idle',
            availableVersion: null,
            progress: 0,
            error: null,
            pendingPackagePath: null
          });
          this.app.quit();
          return { success: true, restartRequired: true, state: this.getState() };
        }
        return {
          success: false,
          error: `Package install exited with code ${exitCode}`,
          state: this.getState()
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          state: this.getState()
        };
      }
    }

    if (this.state.status !== 'downloaded') {
      return { success: false, error: 'No downloaded update is ready to install', state: this.getState() };
    }
    if (!this.autoInstall) {
      await this.openExternal(RELEASE_URL);
      return { success: true, manual: true, state: this.getState() };
    }
    this.timers.setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return { success: true, state: this.getState() };
  }

  runInstallCommand(command: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command[0], command.slice(1), { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', code => resolve(typeof code === 'number' ? code : 1));
    });
  }

  setState(patch: Partial<UpdateState>): void {
    if (Object.prototype.hasOwnProperty.call(patch, 'pendingPackagePath')) {
      this.pendingPackagePath = patch.pendingPackagePath ?? null;
    }
    this.state = {
      ...this.state,
      ...patch,
      pendingPackagePath: this.pendingPackagePath
    };
    this.broadcast();
  }

  broadcast(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.notify('update:state', this.getState());
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { UpdateService: typeof UpdateService }).UpdateService = UpdateService;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && module.exports) {
  Object.assign(UpdateService, {
    readPackageType,
    supportsAutoInstall,
    supportsCachedPackageInstall,
    resolveLinuxCacheHome,
    listPendingPackageDirs,
    findPendingPackage,
    inferPackageTypeFromPath,
    parseVersionFromPackageName,
    compareVersions,
    pendingPackageNeedsInstall,
    clearPendingPackages,
    resolvePackageTypeForInstall,
    buildCachedInstallCommand,
    DEFAULT_UPDATER_CACHE_DIR_NAMES
  });
  module.exports = UpdateService;
}

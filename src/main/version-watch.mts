import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StaleInstallPayload {
  runningVersion: string;
  installedVersion: string;
  reason: 'version' | 'mtime';
}

interface ElectronAppLike {
  isPackaged: boolean;
  relaunch(options?: { execPath?: string; args?: string[] }): void;
  exit(exitCode: number): void;
  quit(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function readInstalledPackageVersion(
  resourcesPath: string,
  readFile: typeof fs.readFileSync = fs.readFileSync
): string | null {
  try {
    const raw = readFile(path.join(resourcesPath, 'app.asar', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

export function isRunningStale(runningVersion: string, installedVersion: string | null): boolean {
  if (!runningVersion || !installedVersion) return false;
  return runningVersion !== installedVersion;
}

export function snapshotBinaryMtime(
  execPath: string,
  statSync: typeof fs.statSync = fs.statSync
): number | null {
  try {
    return statSync(execPath).mtimeMs;
  } catch {
    return null;
  }
}

export function binaryChangedSince(
  baselineMtime: number | null,
  execPath: string,
  statSync: typeof fs.statSync = fs.statSync
): boolean {
  if (baselineMtime == null) return false;
  try {
    return statSync(execPath).mtimeMs !== baselineMtime;
  } catch {
    return false;
  }
}

export function detectStaleInstall(options: {
  runningVersion: string;
  resourcesPath: string;
  execPath: string;
  baselineMtime: number | null;
  readFile?: typeof fs.readFileSync;
  statSync?: typeof fs.statSync;
}): StaleInstallPayload | null {
  const {
    runningVersion,
    resourcesPath,
    execPath,
    baselineMtime,
    readFile = fs.readFileSync,
    statSync = fs.statSync
  } = options;
  const installedVersion = readInstalledPackageVersion(resourcesPath, readFile);
  const staleByVersion = isRunningStale(runningVersion, installedVersion);
  const staleByMtime = binaryChangedSince(baselineMtime, execPath, statSync);
  if (!staleByVersion && !staleByMtime) return null;
  return {
    runningVersion,
    installedVersion: installedVersion || runningVersion,
    reason: staleByVersion ? 'version' : 'mtime'
  };
}

export function startStaleInstallWatch(deps: {
  app: ElectronAppLike;
  notify: (payload: StaleInstallPayload) => void;
  runningVersion: string;
  resourcesPath?: string;
  execPath?: string;
  intervalMs?: number;
  readFile?: typeof fs.readFileSync;
  statSync?: typeof fs.statSync;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): () => void {
  const {
    app,
    notify,
    runningVersion,
    resourcesPath = process.resourcesPath,
    execPath = process.execPath,
    intervalMs = 45_000,
    readFile = fs.readFileSync,
    statSync = fs.statSync,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = deps;

  if (!app.isPackaged) return () => {};

  let baselineMtime = snapshotBinaryMtime(execPath, statSync);
  let notified = false;

  const tick = () => {
    if (notified) return;
    const payload = detectStaleInstall({
      runningVersion,
      resourcesPath,
      execPath,
      baselineMtime,
      readFile,
      statSync
    });
    if (!payload) return;
    notified = true;
    notify(payload);
  };

  const timer = setIntervalFn(tick, intervalMs);
  timer.unref?.();
  app.on('browser-window-focus', (_event, window) => {
    if (window && typeof window === 'object' && 'isDestroyed' in window) {
      const browserWindow = window as { isDestroyed(): boolean };
      if (!browserWindow.isDestroyed()) tick();
    }
  });

  return () => clearIntervalFn(timer);
}

export function performHandoverRelaunch(deps: {
  app: ElectronAppLike;
  execPath?: string;
  args?: string[];
  exitTimeoutMs?: number;
  onBeforeQuit?: () => void;
  setTimeoutFn?: typeof setTimeout;
}): void {
  const {
    app,
    execPath = process.execPath,
    args = process.argv.slice(1),
    exitTimeoutMs = 3000,
    onBeforeQuit,
    setTimeoutFn = setTimeout
  } = deps;

  try {
    app.relaunch({ execPath, args });
  } catch (error) {
    console.warn('[single-instance] relaunch failed:', (error as Error).message);
  }
  setTimeoutFn(() => {
    try { app.exit(0); } catch { /* best effort */ }
  }, exitTimeoutMs);
  try { onBeforeQuit?.(); } catch { /* best effort */ }
  app.quit();
}

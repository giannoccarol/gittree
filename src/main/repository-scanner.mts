import * as fs from 'node:fs';
import * as path from 'node:path';

export const IGNORED_DIRECTORIES = new Set<string>([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'bower_components',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
  'vendor'
]);

function isCanceled(signal: { aborted?: boolean } | null | undefined): boolean {
  return Boolean(signal && signal.aborted);
}

async function hasGitMarker(directoryPath: string): Promise<boolean> {
  const markerPath = path.join(directoryPath, '.git');
  try {
    const marker = await fs.promises.lstat(markerPath);
    if (marker.isDirectory()) return true;
    if (!marker.isFile()) return false;
    const value = await fs.promises.readFile(markerPath, 'utf8');
    return /^\s*gitdir\s*:/i.test(value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (error && (code === 'ENOENT' || code === 'ENOTDIR')) return false;
    throw error;
  }
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { scannedDirectories: number; repository?: { path: string; name: string; relativePath: string } }) => void;
  maxDirectories?: number;
  maxRepositories?: number;
}

export interface ScanResult {
  repositories: Array<{ path: string; name: string; relativePath: string }>;
  scannedDirectories: number;
  skipped: number;
  canceled: boolean;
  limitReached: boolean;
}

export async function scanRepositories(rootPath: unknown, options: ScanOptions = {}): Promise<ScanResult> {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new TypeError('The workspace root must be a directory.');
  }

  let rootStats: fs.Stats;
  try {
    rootStats = await fs.promises.stat(rootPath);
  } catch {
    throw new Error('The workspace root must be an existing directory.');
  }
  if (!rootStats.isDirectory()) {
    throw new Error('The workspace root must be a directory.');
  }

  const root = await fs.promises.realpath(rootPath);
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const maximumDirectories = Number.isInteger(options.maxDirectories)
    ? Math.max(1, options.maxDirectories as number)
    : 250000;
  const maximumRepositories = Number.isInteger(options.maxRepositories)
    ? Math.max(1, options.maxRepositories as number)
    : 10000;
  const queue: string[] = [root];
  const repositories: Array<{ path: string; name: string; relativePath: string }> = [];
  const knownPaths = new Set<string>();
  let scannedDirectories = 0;
  let skipped = 0;
  let limitReached = false;

  while (queue.length && !isCanceled(signal)) {
    if (scannedDirectories >= maximumDirectories || repositories.length >= maximumRepositories) {
      limitReached = true;
      break;
    }

    const directoryPath = queue.shift()!;
    scannedDirectories += 1;

    try {
      const repository = await hasGitMarker(directoryPath);
      if (repository) {
        const resolvedPath = await fs.promises.realpath(directoryPath);
        const key = pathKey(resolvedPath);
        if (!knownPaths.has(key)) {
          knownPaths.add(key);
          const item = {
            path: resolvedPath,
            name: path.basename(resolvedPath),
            relativePath: path.relative(root, resolvedPath) || '.'
          };
          repositories.push(item);
          onProgress({ scannedDirectories, repository: item });
        } else {
          onProgress({ scannedDirectories });
        }
        continue;
      }

      const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (isCanceled(signal)) break;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) {
          skipped += 1;
          continue;
        }
        queue.push(path.join(directoryPath, entry.name));
      }
      onProgress({ scannedDirectories });
    } catch {
      skipped += 1;
      onProgress({ scannedDirectories });
    }
  }

  return {
    repositories,
    scannedDirectories,
    skipped,
    canceled: isCanceled(signal),
    limitReached
  };
}

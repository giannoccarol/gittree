import type { RepositoryWorkspace } from '../repository-workspace.mts';
import type { Logger } from '../logger.mts';
import type { ScanResult } from '../repository-scanner.mts';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function validateCloneUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  const url = value.trim();
  if (url.startsWith('-')) return null;
  const supported = /^https:\/\//i.test(url) || /^ssh:\/\//i.test(url) ||
    /^git\+ssh:\/\//i.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(url);
  const hasControlCharacters = [...url].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  return supported && !hasControlCharacters ? url : null;
}

async function cloneRepository(url: string, parentDirectory: string, repositoryWorkspace: RepositoryWorkspace): Promise<{ path: string; name: string } | { error: string }> {
  const remoteUrl = validateCloneUrl(url);
  if (!remoteUrl) {
    return { error: 'Only remote repository URLs are supported (https, ssh or git@host:path)' };
  }
  if (typeof parentDirectory !== 'string' || !path.isAbsolute(parentDirectory)) {
    return { error: 'Invalid destination folder' };
  }
  let destinationRoot;
  try {
    destinationRoot = repositoryWorkspace.consumeAuthorizedDirectory(parentDirectory);
  } catch (error) {
    return { error: error.message };
  }
  let stat;
  try {
    stat = await fs.promises.stat(destinationRoot);
  } catch {
    return { error: 'Destination folder does not exist' };
  }
  if (!stat.isDirectory()) return { error: 'Destination is not a folder' };
  const rawName = remoteUrl.split('/').filter(Boolean).pop() || '';
  const name = rawName.replace(/\.git(\/)?$/, '').replace(/[<>:"/\\|?*]/g, '-');
  if (!name || name === '.' || name === '..') {
    return { error: 'Could not determine repository name from URL' };
  }
  const targetPath = path.join(destinationRoot, name);
  try {
    await fs.promises.access(targetPath);
    return { error: `Destination already exists: ${targetPath}` };
  } catch {
    // Destination is available.
  }
  await execFileAsync('git', ['clone', remoteUrl, targetPath], {
    cwd: destinationRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  return repositoryWorkspace.addTrustedRepository(targetPath) || { path: targetPath, name };
}

interface RepositoryHandlerDependencies {
  registerHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  scanRepositories: (rootPath: unknown, options?: Record<string, unknown>) => Promise<ScanResult>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  repositoryWorkspace: RepositoryWorkspace;
}

export function registerScanHandlers({
  registerHandler,
  scanRepositories,
  sendToRenderer,
  repositoryWorkspace
}: RepositoryHandlerDependencies) {
  const scans = new Map();
  registerHandler('repo:scan-start', rootPath => {
    const authorizedRoot = repositoryWorkspace.beginScan(rootPath);
    const scanId = crypto.randomUUID();
    const controller = new AbortController();
    scans.set(scanId, controller);
    let lastProgressAt = 0;
    scanRepositories(authorizedRoot, {
      signal: controller.signal,
      onProgress(progress: { scannedDirectories: number; repository?: { path: string; name: string; relativePath: string } }) {
        const now = Date.now();
        if (progress.repository || now - lastProgressAt >= 50) {
          lastProgressAt = now;
          sendToRenderer('repo:scan-progress', { scanId, ...progress });
        }
      }
    }).then(result => {
      repositoryWorkspace.authorizeScanResults(authorizedRoot, result.repositories);
      sendToRenderer('repo:scan-complete', { scanId, ...result });
    }).catch(error => {
      repositoryWorkspace.authorizeScanResults(authorizedRoot, []);
      sendToRenderer('repo:scan-complete', {
        scanId,
        repositories: [],
        scannedDirectories: 0,
        skipped: 0,
        canceled: controller.signal.aborted,
        error: error.message
      });
    }).finally(() => scans.delete(scanId));
    return { scanId };
  });
  registerHandler('repo:scan-cancel', scanId => {
    const controller = scans.get(scanId);
    if (!controller) return { success: false };
    controller.abort();
    return { success: true };
  });
}

async function addRepositories(
  repoPaths: unknown,
  createGitService: (repoPath: string) => unknown,
  repositoryWorkspace: RepositoryWorkspace
): Promise<{ added: unknown[]; existing?: unknown[]; failed: Array<{ path: string; error: string }>; activeRepo?: unknown; error?: string }> {
  if (!Array.isArray(repoPaths) || repoPaths.length > 10000) {
    return { added: [] as unknown[], existing: [] as unknown[], failed: [] as Array<{ path: string; error: string }>, activeRepo: null as unknown, error: 'Invalid repository list' };
  }
  const valid: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const repoPath of repoPaths) {
    if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) {
      failed.push({ path: String(repoPath || ''), error: 'Invalid repository path' });
      continue;
    }
    if (!repositoryWorkspace.canAdd(repoPath)) {
      failed.push({ path: repoPath, error: 'Repository path was not authorized' });
      continue;
    }
    try {
      const git = createGitService(repoPath) as { git: { checkIsRepo: () => Promise<void>; raw: (args: string[]) => Promise<string> } };
      await git.git.checkIsRepo();
      const inside = (await git.git.raw(['rev-parse', '--is-inside-work-tree'])).trim();
      if (inside !== 'true') throw new Error('Bare repositories are not supported');
      valid.push(repoPath);
    } catch (error) {
      failed.push({ path: repoPath, error: error.message || 'Not a valid Git repository' });
    }
  }
  const result = repositoryWorkspace.addAuthorizedRepositories(valid);
  return { ...result, failed: [...failed, ...result.failed] };
}

interface RepositoryHandlersBundle {
  registerHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  repositoryWorkspace: RepositoryWorkspace;
  isWorkingTreeRepository: (repoPath: unknown) => Promise<boolean> | boolean;
  createGitService: (repoPath: string) => unknown;
  scanRepositories: (rootPath: unknown, options?: Record<string, unknown>) => Promise<ScanResult>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  logger?: Pick<Logger, 'info'>;
}

export function registerRepositoryHandlers(dependencies: RepositoryHandlersBundle) {
  const {
    registerHandler,
    repositoryWorkspace,
    isWorkingTreeRepository,
    createGitService,
    scanRepositories,
    sendToRenderer,
    logger
  } = dependencies;
  registerHandler('git:is-repo', repoPath => (
    repositoryWorkspace.canInspect(repoPath) && isWorkingTreeRepository(repoPath)
  ));
  registerHandler('git:clone', (url: string, directory: string) => (
    cloneRepository(url, directory, repositoryWorkspace)
  ));
  registerHandler('repo:list', () => repositoryWorkspace.list());
  registerHandler('repo:add', async repoPath => {
    if (!repositoryWorkspace.canAdd(repoPath)) {
      return { error: 'Repository path was not authorized' };
    }
    if (!await isWorkingTreeRepository(repoPath)) {
      return { error: 'Not a valid Git repository' };
    }
    const repository = repositoryWorkspace.addAuthorizedRepository(repoPath);
    logger?.info('Repository added', { path: repoPath });
    return repository;
  });
  registerScanHandlers({
    registerHandler,
    scanRepositories,
    sendToRenderer,
    repositoryWorkspace
  });
  registerHandler('repo:add-many', repoPaths => (
    addRepositories(repoPaths, createGitService, repositoryWorkspace)
  ));
  registerHandler('repo:remove', repoPath => {
    repositoryWorkspace.remove(repoPath);
    logger?.info('Repository removed', { path: repoPath });
    return repositoryWorkspace.active();
  });
  registerHandler('repo:set-active', index => repositoryWorkspace.setActive(Number(index)));
  registerHandler('repo:active', () => repositoryWorkspace.active());
}

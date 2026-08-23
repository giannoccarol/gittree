import * as path from 'node:path';
import { GitService } from './git-service.mts';

export async function isWorkingTreeRepository(
  repoPath: unknown,
  createGitService: (value: string) => GitService = value => new GitService(value)
): Promise<boolean> {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return false;
  try {
    const git = createGitService(repoPath);
    const isRepository = await git.git.checkIsRepo();
    if (!isRepository) return false;
    const insideWorkTree = (await git.git.revparse(['--is-inside-work-tree'])).trim();
    if (insideWorkTree !== 'true') return false;
    const prefix = (await git.git.revparse(['--show-prefix'])).trim();
    return prefix === '';
  } catch {
    return false;
  }
}

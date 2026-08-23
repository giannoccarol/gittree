import type { GitService } from '../git-service.mts';

interface GitHandlerDependencies {
  registerManagedRepoHandler: (channel: string, implementation: (...args: never[]) => unknown) => void;
  getGitService: (repoPath: unknown) => GitService;
  consumeAuthorizedDirectory?: (directoryPath: unknown) => unknown;
  authorizeCreatedRepository?: (repoPath: unknown) => unknown;
  assertWorktreeRemovable?: (payload: unknown) => boolean;
  sendToRenderer?: (channel: string, payload: unknown) => void;
}

async function runWithConflictState(git: GitService, operation: () => Promise<unknown>) {
  try {
    return await operation();
  } catch (error) {
    let conflictState;
    try {
      conflictState = await git.getOperationState();
    } catch {
      conflictState = null;
    }
    return { error: error.message || String(error), conflictState };
  }
}

export function registerGitHandlers({
  registerManagedRepoHandler,
  getGitService,
  consumeAuthorizedDirectory = directoryPath => directoryPath,
  authorizeCreatedRepository = repoPath => repoPath,
  assertWorktreeRemovable = () => true,
  sendToRenderer = () => {}
}: GitHandlerDependencies) {
  const forwards = [
    ['git:log', 'getLog'],
    ['git:graph-page', 'getGraphPage'],
    ['git:diff', 'getDiff'],
    ['git:commit-detail', 'getCommitDetail'],
    ['git:blame', 'getBlame'],
    ['git:branches', 'getBranches'],
    ['git:branch-metadata', 'getBranchMetadata'],
    ['git:branch-compare', 'getBranchComparison'],
    ['git:compare-commits', 'compareCommits'],
    ['git:commit-file-diff', 'getCommitFileDiff'],
    ['git:status', 'getStatus'],
    ['git:working-tree', 'getWorkingTree'],
    ['git:staged-diff', 'getStagedDiff'],
    ['git:unstaged-diff', 'getUnstagedDiff'],
    ['git:working-diff', 'getWorkingDiff'],
    ['git:stage-paths', 'stagePaths'],
    ['git:unstage-paths', 'unstagePaths'],
    ['git:discard-paths', 'discardPaths'],
    ['git:stage-hunks', 'stageHunks'],
    ['git:unstage-hunks', 'unstageHunks'],
    ['git:identity-get', 'getIdentity'],
    ['git:identity-set', 'setIdentity'],
    ['git:commit-action-preview', 'previewCommitAction'],
    ['git:stash-list', 'getStashList'],
    ['git:remotes', 'getRemotes'],
    ['git:reflog', 'getReflog'],
    ['git:worktrees', 'getWorktrees'],
    ['git:submodules', 'getSubmodules'],
    ['git:file-tree', 'getFileTree'],
    ['git:tags', 'getTags'],
    ['git:tags-at-commit', 'getTagsAtCommit'],
    ['git:operation-state', 'getOperationState'],
    ['git:merge-preview', 'previewMerge'],
    ['git:conflict-parse', 'parseConflictBlocks'],
    ['git:conflict-read', 'readConflict'],
    ['git:branch-track', 'trackBranch'],
    ['git:branch-fetch', 'fetchBranch'],
    ['git:branch-delete-remote', 'deleteRemoteBranch'],
    ['git:delete-branch', 'deleteBranch'],
    ['git:stash', 'stash'],
    ['git:stash-pop', 'stashPop'],
    ['git:stash-apply', 'stashApply'],
    ['git:stash-drop', 'stashDrop'],
    ['git:worktree-lock', 'lockWorktree'],
    ['git:worktree-unlock', 'unlockWorktree'],
    ['git:submodules-init', 'initSubmodules'],
    ['git:submodules-update', 'updateSubmodules'],
    ['git:remote-add', 'addRemote'],
    ['git:remote-rename', 'renameRemote'],
    ['git:remote-set-url', 'setRemoteUrl'],
    ['git:remote-remove', 'removeRemote'],
    ['git:restore-file-from-commit', 'restoreFileFromCommit'],
    ['git:conflict-resolve', 'resolveConflict'],
    ['git:operation-continue', 'continueOperation'],
    ['git:operation-abort', 'abortOperation'],
    ['git:operation-skip', 'skipOperation']
  ];

  type GitMethod = keyof GitService;

  for (const [channel, method] of forwards as Array<[string, GitMethod]>) {
    registerManagedRepoHandler(channel, (repoPath: string, ...args: unknown[]) => {
      const service = getGitService(repoPath) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return service[method](...args);
    });
  }

  registerManagedRepoHandler('git:worktree-create', async (repoPath: string, directory: string, branch?: string) => {
    const result = await getGitService(repoPath).createWorktree(
      String(consumeAuthorizedDirectory(directory)),
      branch
    );
    authorizeCreatedRepository(String(result.path));
    return result;
  });

  registerManagedRepoHandler('git:worktree-create-managed', async (repoPath: string, directory: string, options?: Record<string, unknown>) => {
    const result = await getGitService(repoPath).createManagedWorktree({
      ...((options ?? {}) as Record<string, unknown>),
      directory: String(consumeAuthorizedDirectory(directory))
    });
    authorizeCreatedRepository(String(result.path));
    return result;
  });

  registerManagedRepoHandler('git:worktree-remove', async (repoPath: string, directory: string) => {
    assertWorktreeRemovable(directory);
    return getGitService(repoPath).removeWorktree(directory);
  });

  const registerLogged = (
    channel: string,
    method: GitMethod,
    message: (result: unknown, ...args: unknown[]) => string
  ) => {
    registerManagedRepoHandler(channel, async (repoPath: string, ...args: unknown[]) => {
      const result = await (getGitService(repoPath)[method] as (...a: unknown[]) => Promise<unknown>)(...args);
      sendToRenderer('operation:log', message(result, ...args));
      return result;
    });
  };

  registerLogged('git:checkout', 'checkoutBranch', (_result, branch) => (
    `Checked out ${branch}`
  ));
  registerLogged('git:checkout-tracking', 'checkoutTrackingBranch', result => (
    `Checked out ${(result as { branch?: string }).branch ?? ''}`
  ));
  registerLogged('git:branch-rename', 'renameBranch', (_result, branch, newName) => (
    `Renamed ${branch} to ${newName}`
  ));
  registerLogged('git:create-branch', 'createBranch', (_result, name) => (
    `Created branch ${name}`
  ));
  registerLogged('git:push', 'push', (_result, remote) => `Pushed to ${remote}`);
  registerLogged('git:pull', 'pull', (_result, remote) => `Pulled from ${remote}`);
  registerLogged('git:fetch', 'fetch', (_result, remote) => `Fetched from ${remote}`);
  registerLogged('git:commit', 'commitChanges', result => (
    `Created commit ${String((result as { hash?: string }).hash).slice(0, 8)}`
  ));
  registerLogged('git:create-tag', 'createTag', result => `Created tag ${(result as { name?: string }).name}`);
  registerLogged('git:delete-tag', 'deleteTag', result => `Deleted tag ${(result as { name?: string }).name}`);
  registerLogged('git:tags-push', 'pushTags', (_result, remote) => (
    `Pushed tags to ${remote}`
  ));
  registerLogged('git:remote-tag-delete', 'deleteRemoteTag', (_result, remote, name) => (
    `Deleted remote tag ${name} from ${remote}`
  ));

  registerManagedRepoHandler('git:batch-delete-branches', async (
    repoPath: unknown,
    branches: string[],
    force: boolean
  ) => {
    if (!Array.isArray(branches) || branches.length > 500) {
      return { error: 'Invalid branch list' };
    }
    const result = await getGitService(repoPath).deleteBranches(branches, force);
    const deleted = result.results.filter(item => item.success).length;
    sendToRenderer('operation:log', `Deleted ${deleted} branch(es)`);
    return result;
  });

  const registerConflictOperation = (
    channel: string,
    method: GitMethod,
    logMessage: (result: unknown, ...args: unknown[]) => string
  ) => {
    registerManagedRepoHandler(channel, async (repoPath: string, ...args: unknown[]) => {
      const git = getGitService(repoPath);
      return runWithConflictState(git, async () => {
        const result = await (git[method] as (...a: unknown[]) => Promise<unknown>)(...args);
        sendToRenderer('operation:log', logMessage(result, ...args));
        return result;
      });
    });
  };

  registerConflictOperation('git:branch-rebase', 'rebaseOnto', (_result, branch) => (
    `Rebased onto ${branch}`
  ));
  registerConflictOperation('git:merge', 'merge', (_result, branch) => (
    `Merged ${branch}`
  ));
  registerConflictOperation('git:rebase-onto-commit', 'rebaseOntoCommit', (_result, hash) => (
    `Rebased onto ${String(hash).slice(0, 8)}`
  ));
  registerConflictOperation('git:cherry-pick', 'cherryPickCommits', result => (
    `Cherry-picked ${(result as { commits?: unknown[] }).commits?.length ?? 0} commit(s)`
  ));
}

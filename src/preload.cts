import { contextBridge, ipcRenderer } from 'electron';
import type { GitTreeBridge } from './shared/bridge.mts';

const bridge = {
  platform: process.platform,

  minimizeWindow: (): Promise<unknown> =>
    ipcRenderer.invoke('window:minimize'),

  toggleMaximizeWindow: (): Promise<unknown> =>
    ipcRenderer.invoke('window:toggle-maximize'),

  getWindowState: (): Promise<unknown> =>
    ipcRenderer.invoke('window:get-state'),

  onWindowState: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },

  closeWindow: (): Promise<unknown> =>
    ipcRenderer.invoke('window:close'),

  setTheme: (theme: unknown, background: unknown): Promise<unknown> =>
    ipcRenderer.invoke('app:set-theme', theme, background),

  getUpdateState: (): Promise<unknown> =>
    ipcRenderer.invoke('update:get-state'),

  checkForUpdates: (): Promise<unknown> =>
    ipcRenderer.invoke('update:check'),

  downloadUpdate: (): Promise<unknown> =>
    ipcRenderer.invoke('update:download'),

  installUpdate: (): Promise<unknown> =>
    ipcRenderer.invoke('update:install'),

  onUpdateState: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },

  onStaleInstall: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('app:stale-install', listener);
    return () => ipcRenderer.removeListener('app:stale-install', listener);
  },

  getLog: (repoPath: unknown, maxCount: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:log', repoPath, maxCount, branch),

  getGraphPage: (repoPath: unknown, options: unknown = {}): Promise<unknown> => {
    const typedOptions = options as { offset?: unknown; limit?: unknown };
    return ipcRenderer.invoke('git:graph-page', repoPath, (typedOptions.offset as number) || 0, (typedOptions.limit as number) || 500);
  },

  getDiff: (repoPath: unknown, commitHash: unknown, file: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:diff', repoPath, commitHash, file),

  getCommitDetail: (repoPath: unknown, hash: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:commit-detail', repoPath, hash),

  getBranches: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branches', repoPath),

  getBranchMetadata: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-metadata', repoPath),

  compareBranches: (repoPath: unknown, baseBranch: unknown, compareBranch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-compare', repoPath, baseBranch, compareBranch),

  compareCommits: (repoPath: unknown, hashA: unknown, hashB: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:compare-commits', repoPath, hashA, hashB),

  getCommitFileDiff: (repoPath: unknown, hashA: unknown, hashB: unknown, filePath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:commit-file-diff', repoPath, hashA, hashB, filePath),

  checkoutBranch: (repoPath: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:checkout', repoPath, branch),

  checkoutTrackingBranch: (repoPath: unknown, remoteRef: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:checkout-tracking', repoPath, remoteRef),

  createBranch: (repoPath: unknown, name: unknown, startPoint: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:create-branch', repoPath, name, startPoint),

  merge: (repoPath: unknown, branch: unknown, strategy: unknown = 'ff'): Promise<unknown> =>
    ipcRenderer.invoke('git:merge', repoPath, branch, strategy),

  renameBranch: (repoPath: unknown, branch: unknown, newName: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-rename', repoPath, branch, newName),

  rebaseBranch: (repoPath: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-rebase', repoPath, branch),

  trackBranch: (repoPath: unknown, branch: unknown, remoteRef: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-track', repoPath, branch, remoteRef),

  fetchBranch: (repoPath: unknown, remote: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-fetch', repoPath, remote, branch),

  deleteRemoteBranch: (repoPath: unknown, remote: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:branch-delete-remote', repoPath, remote, branch),

  deleteBranch: (repoPath: unknown, branch: unknown, force: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:delete-branch', repoPath, branch, force),

  batchDeleteBranches: (repoPath: unknown, branches: unknown, force: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:batch-delete-branches', repoPath, branches, force),

  push: (repoPath: unknown, remote: unknown, branch: unknown, setUpstream: unknown = false): Promise<unknown> =>
    ipcRenderer.invoke('git:push', repoPath, remote, branch, setUpstream),

  pull: (repoPath: unknown, remote: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:pull', repoPath, remote, branch),

  fetch: (repoPath: unknown, remote: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:fetch', repoPath, remote),

  getStatus: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:status', repoPath),

  getWorkingTree: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:working-tree', repoPath),

  getWorkingDiff: (repoPath: unknown, filePath: unknown, staged: unknown = false): Promise<unknown> =>
    ipcRenderer.invoke('git:working-diff', repoPath, filePath, staged),

  stagePaths: (repoPath: unknown, snapshotId: unknown, paths: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stage-paths', repoPath, snapshotId, paths),

  unstagePaths: (repoPath: unknown, snapshotId: unknown, paths: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:unstage-paths', repoPath, snapshotId, paths),

  discardPaths: (repoPath: unknown, snapshotId: unknown, paths: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:discard-paths', repoPath, snapshotId, paths),

  stageHunks: (repoPath: unknown, snapshotId: unknown, filePath: unknown, hunkIds: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stage-hunks', repoPath, snapshotId, filePath, hunkIds),

  unstageHunks: (repoPath: unknown, snapshotId: unknown, filePath: unknown, hunkIds: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:unstage-hunks', repoPath, snapshotId, filePath, hunkIds),

  getIdentity: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:identity-get', repoPath),

  setIdentity: (repoPath: unknown, identity: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:identity-set', repoPath, identity),

  commitChanges: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:commit', repoPath, options),

  previewCommitAction: (repoPath: unknown, action: unknown, hashes: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:commit-action-preview', repoPath, action, hashes),

  rebaseOntoCommit: (repoPath: unknown, hash: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:rebase-onto-commit', repoPath, hash),

  cherryPick: (repoPath: unknown, hashes: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:cherry-pick', repoPath, hashes),

  getStashList: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stash-list', repoPath),

  stash: (repoPath: unknown, message: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stash', repoPath, message),

  stashPop: (repoPath: unknown, index: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stash-pop', repoPath, index),

  stashApply: (repoPath: unknown, index: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stash-apply', repoPath, index),

  stashDrop: (repoPath: unknown, index: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:stash-drop', repoPath, index),

  getRemotes: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:remotes', repoPath),

  getReflog: (repoPath: unknown, maxCount: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:reflog', repoPath, maxCount),

  getWorktrees: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:worktrees', repoPath),

  createWorktree: (repoPath: unknown, directory: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:worktree-create', repoPath, directory, branch),

  createManagedWorktree: (repoPath: unknown, directory: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:worktree-create-managed', repoPath, directory, options),

  openWorktree: (repoPath: unknown, worktreePath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:worktree-open', repoPath, worktreePath),

  lockWorktree: (repoPath: unknown, directory: unknown, reason: unknown = ''): Promise<unknown> =>
    ipcRenderer.invoke('git:worktree-lock', repoPath, directory, reason),

  unlockWorktree: (repoPath: unknown, directory: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:worktree-unlock', repoPath, directory),

  removeWorktree: (repoPath: unknown, directory: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:worktree-remove', repoPath, directory),

  getAgentSettings: (): Promise<unknown> =>
    ipcRenderer.invoke('agent:settings'),

  chooseAgentWorktreeRoot: (): Promise<unknown> =>
    ipcRenderer.invoke('agent:root-select'),

  setAgentConcurrency: (value: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:concurrency-set', value),

  setAgentSessionsEnabled: (enabled: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:enabled-set', enabled),

  detectAgentAdapters: (): Promise<unknown> =>
    ipcRenderer.invoke('agent:adapters-detect'),

  setEnabledAgentAdapters: (adapterIds: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:adapters-set', adapterIds),

  getAiSettings: (): Promise<unknown> =>
    ipcRenderer.invoke('ai:settings-get'),

  setAiSettings: (settings: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:settings-set', settings),

  setAiKey: (key: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:key-set', key),

  clearAiKey: (): Promise<unknown> =>
    ipcRenderer.invoke('ai:key-clear'),

  testAiConnection: (): Promise<unknown> =>
    ipcRenderer.invoke('ai:test-connection'),

  generateCommitMessage: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:commit-message', repoPath, options),

  explainChanges: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:explain-changes', repoPath, options),

  explainConflict: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:explain-conflict', repoPath, options),

  explainCommit: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:explain-commit', repoPath, options),

  searchHistory: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:history-search', repoPath, options),

  explainLines: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:explain-lines', repoPath, options),

  generatePrDescription: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ai:pr-description', repoPath, options),

  getStagedDiff: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:staged-diff', repoPath),

  getBlame: (repoPath: unknown, filePath: unknown, hash: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:blame', repoPath, filePath, hash),

  getUnstagedDiff: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:unstaged-diff', repoPath),

  listAgentTasks: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:tasks', repoPath),

  createAgentTask: (repoPath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:task-create', repoPath, options),

  createAgentTaskForWorktree: (repoPath: unknown, worktreePath: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:task-create-worktree', repoPath, worktreePath, options),

  stopAgentTask: (taskId: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:task-stop', taskId),

  resumeAgentTask: (taskId: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:task-resume', taskId),

  archiveAgentTask: (taskId: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:task-archive', taskId),

  writeAgentTerminal: (taskId: unknown, data: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:terminal-write', taskId, data),

  resizeAgentTerminal: (taskId: unknown, cols: unknown, rows: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:terminal-resize', taskId, cols, rows),

  acknowledgeAgentAttention: (taskId: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agent:attention-ack', taskId),

  onAgentTaskChanged: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, task: unknown): void => callback(task);
    ipcRenderer.on('agent:task-changed', listener);
    return () => ipcRenderer.removeListener('agent:task-changed', listener);
  },

  onAgentTerminalData: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('agent:terminal-data', listener);
    return () => ipcRenderer.removeListener('agent:terminal-data', listener);
  },

  onAgentAttention: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('agent:attention', listener);
    return () => ipcRenderer.removeListener('agent:attention', listener);
  },

  onAgentQueueChanged: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('agent:queue-changed', listener);
    return () => ipcRenderer.removeListener('agent:queue-changed', listener);
  },

  getSubmodules: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:submodules', repoPath),

  initSubmodules: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:submodules-init', repoPath),

  updateSubmodules: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:submodules-update', repoPath),

  addRemote: (repoPath: unknown, name: unknown, url: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:remote-add', repoPath, name, url),

  renameRemote: (repoPath: unknown, name: unknown, newName: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:remote-rename', repoPath, name, newName),

  setRemoteUrl: (repoPath: unknown, name: unknown, url: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:remote-set-url', repoPath, name, url),

  removeRemote: (repoPath: unknown, name: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:remote-remove', repoPath, name),

  getFileTree: (repoPath: unknown, commitHash: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:file-tree', repoPath, commitHash),

  restoreFileFromCommit: (repoPath: unknown, commitHash: unknown, filePath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:restore-file-from-commit', repoPath, commitHash, filePath),

  getTags: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:tags', repoPath),

  createTag: (repoPath: unknown, name: unknown, commitHash: unknown, message: unknown = ''): Promise<unknown> =>
    ipcRenderer.invoke('git:create-tag', repoPath, name, commitHash, message),

  deleteTag: (repoPath: unknown, name: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:delete-tag', repoPath, name),

  pushTags: (repoPath: unknown, remote: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:tags-push', repoPath, remote),

  deleteRemoteTag: (repoPath: unknown, remote: unknown, name: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:remote-tag-delete', repoPath, remote, name),

  getTagsAtCommit: (repoPath: unknown, commitHash: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:tags-at-commit', repoPath, commitHash),

  getOperationState: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:operation-state', repoPath),

  previewMerge: (repoPath: unknown, branch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:merge-preview', repoPath, branch),

  parseConflictBlocks: (repoPath: unknown, content: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:conflict-parse', repoPath, content),

  readConflict: (repoPath: unknown, filePath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:conflict-read', repoPath, filePath),

  resolveConflict: (repoPath: unknown, filePath: unknown, resolution: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:conflict-resolve', repoPath, filePath, resolution),

  continueOperation: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:operation-continue', repoPath),

  abortOperation: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:operation-abort', repoPath),

  skipOperation: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:operation-skip', repoPath),

  openPullRequest: (repoPath: unknown, remoteName: unknown, sourceBranch: unknown, targetBranch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('app:open-pull-request', repoPath, remoteName, sourceBranch, targetBranch),

  getProviderStatus: (provider: unknown): Promise<unknown> =>
    ipcRenderer.invoke('auth:provider-status', provider),

  loginProvider: (provider: unknown): Promise<unknown> =>
    ipcRenderer.invoke('auth:provider-login', provider),

  cancelProviderLogin: (provider: unknown): Promise<unknown> =>
    ipcRenderer.invoke('auth:provider-cancel', provider),

  logoutProvider: (provider: unknown): Promise<unknown> =>
    ipcRenderer.invoke('auth:provider-logout', provider),

  resetHostingVault: (): Promise<unknown> =>
    ipcRenderer.invoke('auth:vault-reset'),

  setPat: (provider: unknown, token: unknown, repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('auth:set-pat', provider, token, repoPath),

  onProviderState: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state);
    ipcRenderer.on('auth:provider-state', listener);
    return () => ipcRenderer.removeListener('auth:provider-state', listener);
  },

  getPullRequests: (repoPath: unknown, provider: unknown, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hosting:pull-requests', repoPath, provider, options),

  createPullRequest: (repoPath: unknown, provider: unknown, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hosting:pull-request-create', repoPath, provider, input),

  getPullRequestDetail: (repoPath: unknown, provider: unknown, id: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hosting:pull-request-detail', repoPath, provider, id),

  getPullRequestDiff: (repoPath: unknown, provider: unknown, id: unknown, page: unknown = 1): Promise<unknown> =>
    ipcRenderer.invoke('hosting:pull-request-diff', repoPath, provider, id, page),

  saveReviewDraft: (repoPath: unknown, provider: unknown, id: unknown, draft: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hosting:review-draft-save', repoPath, provider, id, draft),

  submitReview: (repoPath: unknown, provider: unknown, id: unknown, draft: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hosting:review-submit', repoPath, provider, id, draft),

  resolveReviewThread: (repoPath: unknown, provider: unknown, id: unknown, thread: unknown, resolved: unknown): Promise<unknown> =>
    ipcRenderer.invoke(
      'hosting:thread-resolve',
      repoPath,
      provider,
      id,
      thread,
      resolved
    ),

  checkoutPullRequestSource: (repoPath: unknown, provider: unknown, pullRequest: unknown, confirmed: unknown = false): Promise<unknown> =>
    ipcRenderer.invoke(
      'hosting:checkout-source',
      repoPath,
      provider,
      pullRequest,
      confirmed
    ),

  openReviewInBrowser: (repoPath: unknown, provider: unknown, id: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hosting:open-review-browser', repoPath, provider, id),

  selectDirectory: (): Promise<unknown> =>
    ipcRenderer.invoke('dialog:select-directory'),

  getRepos: (): Promise<unknown> =>
    ipcRenderer.invoke('repo:list'),

  addRepo: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('repo:add', repoPath),

  addRepos: (repoPaths: unknown): Promise<unknown> =>
    ipcRenderer.invoke('repo:add-many', repoPaths),

  startRepositoryScan: (rootPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('repo:scan-start', rootPath),

  cancelRepositoryScan: (scanId: unknown): Promise<unknown> =>
    ipcRenderer.invoke('repo:scan-cancel', scanId),

  onRepositoryScanProgress: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, progress: unknown): void => callback(progress);
    ipcRenderer.on('repo:scan-progress', listener);
    return () => ipcRenderer.removeListener('repo:scan-progress', listener);
  },

  onRepositoryScanComplete: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, result: unknown): void => callback(result);
    ipcRenderer.on('repo:scan-complete', listener);
    return () => ipcRenderer.removeListener('repo:scan-complete', listener);
  },

  removeRepo: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('repo:remove', repoPath),

  setActiveRepo: (index: unknown): Promise<unknown> =>
    ipcRenderer.invoke('repo:set-active', index),

  getActiveRepo: (): Promise<unknown> =>
    ipcRenderer.invoke('repo:active'),

  checkIsGitRepo: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:is-repo', repoPath),

  cloneRepository: (url: unknown, parentDirectory: unknown): Promise<unknown> =>
    ipcRenderer.invoke('git:clone', url, parentDirectory),

  onOperationLog: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, message: unknown): void => callback(message);
    ipcRenderer.on('operation:log', listener);
    return () => ipcRenderer.removeListener('operation:log', listener);
  },

  openExternal: (url: unknown): Promise<unknown> =>
    ipcRenderer.invoke('app:open-external', url),

  openTerminal: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('app:open-terminal', repoPath),

  openExplorer: (repoPath: unknown): Promise<unknown> =>
    ipcRenderer.invoke('app:open-explorer', repoPath),

  getAppVersion: (): Promise<unknown> =>
    ipcRenderer.invoke('app:version'),

  getGitVersion: (): Promise<unknown> =>
    ipcRenderer.invoke('app:git-version'),

  exportDiagnostics: (): Promise<unknown> =>
    ipcRenderer.invoke('app:export-diagnostics'),

  openInspectorWindow: (payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke('window:open-inspector', payload),

  updateInspectorWindow: (payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke('window:update-inspector', payload),

  onInspectorClosed: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (): void => callback(undefined as unknown);
    ipcRenderer.on('inspector:closed', listener);
    return () => ipcRenderer.removeListener('inspector:closed', listener);
  },

  onDeepLinkOpen: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, repo: unknown): void => callback(repo);
    ipcRenderer.on('deep-link:open-repo', listener);
    return () => ipcRenderer.removeListener('deep-link:open-repo', listener);
  },

  onInspectorRender: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('inspector:render', listener);
    return () => ipcRenderer.removeListener('inspector:render', listener);
  }
} satisfies GitTreeBridge;

contextBridge.exposeInMainWorld('gitTree', bridge);

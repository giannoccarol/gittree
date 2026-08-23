/**
 * Single source of truth for IPC channel names and result envelopes (ADR-0008, D6).
 * The runtime shape of the `{ error }` envelope is frozen; these types describe it
 * without changing it. Channel literals are cross-checked by test/ipc-parity.test.js.
 */

/** Successful invoke results carry the raw payload; failures carry the error envelope. */
export interface IpcErrorEnvelope {
  error: string;
}

/** Conflict-operation channels extend the envelope with the detected operation state. */
export interface IpcConflictErrorEnvelope extends IpcErrorEnvelope {
  conflictState: unknown;
}

export type IpcResult<T> = T | IpcErrorEnvelope;

export function isIpcError(value: unknown): value is IpcErrorEnvelope {
  return typeof value === 'object' && value !== null && 'error' in value
    && typeof (value as { error: unknown }).error === 'string';
}

export const AGENT_CHANNELS = {
  AdaptersDetect: "agent:adapters-detect",
  AdaptersSet: "agent:adapters-set",
  AttentionAck: "agent:attention-ack",
  ConcurrencySet: "agent:concurrency-set",
  EnabledSet: "agent:enabled-set",
  RootSelect: "agent:root-select",
  Settings: "agent:settings",
  TaskArchive: "agent:task-archive",
  TaskCreate: "agent:task-create",
  TaskCreateWorktree: "agent:task-create-worktree",
  TaskResume: "agent:task-resume",
  TaskStop: "agent:task-stop",
  Tasks: "agent:tasks",
  TerminalResize: "agent:terminal-resize",
  TerminalWrite: "agent:terminal-write",
  WorktreeOpen: "agent:worktree-open",
} as const;

export const AI_CHANNELS = {
  CommitMessage: "ai:commit-message",
  ExplainChanges: "ai:explain-changes",
  ExplainCommit: "ai:explain-commit",
  ExplainConflict: "ai:explain-conflict",
  ExplainLines: "ai:explain-lines",
  HistorySearch: "ai:history-search",
  KeyClear: "ai:key-clear",
  KeySet: "ai:key-set",
  PrDescription: "ai:pr-description",
  SettingsGet: "ai:settings-get",
  SettingsSet: "ai:settings-set",
  TestConnection: "ai:test-connection",
} as const;

export const APP_CHANNELS = {
  ExportDiagnostics: "app:export-diagnostics",
  GitVersion: "app:git-version",
  OpenExplorer: "app:open-explorer",
  OpenExternal: "app:open-external",
  OpenPullRequest: "app:open-pull-request",
  OpenTerminal: "app:open-terminal",
  SetTheme: "app:set-theme",
  Version: "app:version",
} as const;

export const AUTH_CHANNELS = {
  ProviderCancel: "auth:provider-cancel",
  ProviderLogin: "auth:provider-login",
  ProviderLogout: "auth:provider-logout",
  ProviderStatus: "auth:provider-status",
  SetPat: "auth:set-pat",
  VaultReset: "auth:vault-reset",
} as const;

export const DIALOG_CHANNELS = {
  SelectDirectory: "dialog:select-directory",
} as const;

export const GIT_CHANNELS = {
  BatchDeleteBranches: "git:batch-delete-branches",
  Blame: "git:blame",
  BranchCompare: "git:branch-compare",
  BranchDeleteRemote: "git:branch-delete-remote",
  BranchFetch: "git:branch-fetch",
  BranchMetadata: "git:branch-metadata",
  BranchRebase: "git:branch-rebase",
  BranchRename: "git:branch-rename",
  BranchTrack: "git:branch-track",
  Branches: "git:branches",
  Checkout: "git:checkout",
  CheckoutTracking: "git:checkout-tracking",
  CherryPick: "git:cherry-pick",
  Clone: "git:clone",
  Commit: "git:commit",
  CommitActionPreview: "git:commit-action-preview",
  CommitDetail: "git:commit-detail",
  CommitFileDiff: "git:commit-file-diff",
  CompareCommits: "git:compare-commits",
  ConflictParse: "git:conflict-parse",
  ConflictRead: "git:conflict-read",
  ConflictResolve: "git:conflict-resolve",
  CreateBranch: "git:create-branch",
  CreateTag: "git:create-tag",
  DeleteBranch: "git:delete-branch",
  DeleteTag: "git:delete-tag",
  Diff: "git:diff",
  DiscardPaths: "git:discard-paths",
  Fetch: "git:fetch",
  FileTree: "git:file-tree",
  GraphPage: "git:graph-page",
  IdentityGet: "git:identity-get",
  IdentitySet: "git:identity-set",
  IsRepo: "git:is-repo",
  Log: "git:log",
  Merge: "git:merge",
  MergePreview: "git:merge-preview",
  OperationAbort: "git:operation-abort",
  OperationContinue: "git:operation-continue",
  OperationSkip: "git:operation-skip",
  OperationState: "git:operation-state",
  Pull: "git:pull",
  Push: "git:push",
  RebaseOntoCommit: "git:rebase-onto-commit",
  Reflog: "git:reflog",
  RemoteAdd: "git:remote-add",
  RemoteRemove: "git:remote-remove",
  RemoteRename: "git:remote-rename",
  RemoteSetUrl: "git:remote-set-url",
  RemoteTagDelete: "git:remote-tag-delete",
  Remotes: "git:remotes",
  RestoreFileFromCommit: "git:restore-file-from-commit",
  StageHunks: "git:stage-hunks",
  StagePaths: "git:stage-paths",
  StagedDiff: "git:staged-diff",
  Stash: "git:stash",
  StashApply: "git:stash-apply",
  StashDrop: "git:stash-drop",
  StashList: "git:stash-list",
  StashPop: "git:stash-pop",
  Status: "git:status",
  Submodules: "git:submodules",
  SubmodulesInit: "git:submodules-init",
  SubmodulesUpdate: "git:submodules-update",
  Tags: "git:tags",
  TagsAtCommit: "git:tags-at-commit",
  TagsPush: "git:tags-push",
  UnstageHunks: "git:unstage-hunks",
  UnstagePaths: "git:unstage-paths",
  UnstagedDiff: "git:unstaged-diff",
  WorkingDiff: "git:working-diff",
  WorkingTree: "git:working-tree",
  WorktreeCreate: "git:worktree-create",
  WorktreeCreateManaged: "git:worktree-create-managed",
  WorktreeLock: "git:worktree-lock",
  WorktreeRemove: "git:worktree-remove",
  WorktreeUnlock: "git:worktree-unlock",
  Worktrees: "git:worktrees",
} as const;

export const HOSTING_CHANNELS = {
  CheckoutSource: "hosting:checkout-source",
  OpenReviewBrowser: "hosting:open-review-browser",
  PullRequestCreate: "hosting:pull-request-create",
  PullRequestDetail: "hosting:pull-request-detail",
  PullRequestDiff: "hosting:pull-request-diff",
  PullRequests: "hosting:pull-requests",
  ReviewDraftSave: "hosting:review-draft-save",
  ReviewSubmit: "hosting:review-submit",
  ThreadResolve: "hosting:thread-resolve",
} as const;

export const REPO_CHANNELS = {
  Active: "repo:active",
  Add: "repo:add",
  AddMany: "repo:add-many",
  List: "repo:list",
  Remove: "repo:remove",
  ScanCancel: "repo:scan-cancel",
  ScanStart: "repo:scan-start",
  SetActive: "repo:set-active",
} as const;

export const UPDATE_CHANNELS = {
  Check: "update:check",
  Download: "update:download",
  GetState: "update:get-state",
  Install: "update:install",
} as const;

export const WINDOW_CHANNELS = {
  Close: "window:close",
  GetState: "window:get-state",
  Minimize: "window:minimize",
  OpenInspector: "window:open-inspector",
  ToggleMaximize: "window:toggle-maximize",
  UpdateInspector: "window:update-inspector",
} as const;

export const IPC_CHANNELS = {
  agent: AGENT_CHANNELS,
  ai: AI_CHANNELS,
  app: APP_CHANNELS,
  auth: AUTH_CHANNELS,
  dialog: DIALOG_CHANNELS,
  git: GIT_CHANNELS,
  hosting: HOSTING_CHANNELS,
  repo: REPO_CHANNELS,
  update: UPDATE_CHANNELS,
  window: WINDOW_CHANNELS,
} as const;

export type IpcChannel =
  | "agent:adapters-detect"
  | "agent:adapters-set"
  | "agent:attention-ack"
  | "agent:concurrency-set"
  | "agent:enabled-set"
  | "agent:root-select"
  | "agent:settings"
  | "agent:task-archive"
  | "agent:task-create"
  | "agent:task-create-worktree"
  | "agent:task-resume"
  | "agent:task-stop"
  | "agent:tasks"
  | "agent:terminal-resize"
  | "agent:terminal-write"
  | "agent:worktree-open"
  | "ai:commit-message"
  | "ai:explain-changes"
  | "ai:explain-commit"
  | "ai:explain-conflict"
  | "ai:explain-lines"
  | "ai:history-search"
  | "ai:key-clear"
  | "ai:key-set"
  | "ai:pr-description"
  | "ai:settings-get"
  | "ai:settings-set"
  | "ai:test-connection"
  | "app:export-diagnostics"
  | "app:git-version"
  | "app:open-explorer"
  | "app:open-external"
  | "app:open-pull-request"
  | "app:open-terminal"
  | "app:set-theme"
  | "app:version"
  | "auth:provider-cancel"
  | "auth:provider-login"
  | "auth:provider-logout"
  | "auth:provider-status"
  | "auth:set-pat"
  | "auth:vault-reset"
  | "dialog:select-directory"
  | "git:batch-delete-branches"
  | "git:blame"
  | "git:branch-compare"
  | "git:branch-delete-remote"
  | "git:branch-fetch"
  | "git:branch-metadata"
  | "git:branch-rebase"
  | "git:branch-rename"
  | "git:branch-track"
  | "git:branches"
  | "git:checkout"
  | "git:checkout-tracking"
  | "git:cherry-pick"
  | "git:clone"
  | "git:commit"
  | "git:commit-action-preview"
  | "git:commit-detail"
  | "git:commit-file-diff"
  | "git:compare-commits"
  | "git:conflict-parse"
  | "git:conflict-read"
  | "git:conflict-resolve"
  | "git:create-branch"
  | "git:create-tag"
  | "git:delete-branch"
  | "git:delete-tag"
  | "git:diff"
  | "git:discard-paths"
  | "git:fetch"
  | "git:file-tree"
  | "git:graph-page"
  | "git:identity-get"
  | "git:identity-set"
  | "git:is-repo"
  | "git:log"
  | "git:merge"
  | "git:merge-preview"
  | "git:operation-abort"
  | "git:operation-continue"
  | "git:operation-skip"
  | "git:operation-state"
  | "git:pull"
  | "git:push"
  | "git:rebase-onto-commit"
  | "git:reflog"
  | "git:remote-add"
  | "git:remote-remove"
  | "git:remote-rename"
  | "git:remote-set-url"
  | "git:remote-tag-delete"
  | "git:remotes"
  | "git:restore-file-from-commit"
  | "git:stage-hunks"
  | "git:stage-paths"
  | "git:staged-diff"
  | "git:stash"
  | "git:stash-apply"
  | "git:stash-drop"
  | "git:stash-list"
  | "git:stash-pop"
  | "git:status"
  | "git:submodules"
  | "git:submodules-init"
  | "git:submodules-update"
  | "git:tags"
  | "git:tags-at-commit"
  | "git:tags-push"
  | "git:unstage-hunks"
  | "git:unstage-paths"
  | "git:unstaged-diff"
  | "git:working-diff"
  | "git:working-tree"
  | "git:worktree-create"
  | "git:worktree-create-managed"
  | "git:worktree-lock"
  | "git:worktree-remove"
  | "git:worktree-unlock"
  | "git:worktrees"
  | "hosting:checkout-source"
  | "hosting:open-review-browser"
  | "hosting:pull-request-create"
  | "hosting:pull-request-detail"
  | "hosting:pull-request-diff"
  | "hosting:pull-requests"
  | "hosting:review-draft-save"
  | "hosting:review-submit"
  | "hosting:thread-resolve"
  | "repo:active"
  | "repo:add"
  | "repo:add-many"
  | "repo:list"
  | "repo:remove"
  | "repo:scan-cancel"
  | "repo:scan-start"
  | "repo:set-active"
  | "update:check"
  | "update:download"
  | "update:get-state"
  | "update:install"
  | "window:close"
  | "window:get-state"
  | "window:minimize"
  | "window:open-inspector"
  | "window:toggle-maximize"
  | "window:update-inspector";

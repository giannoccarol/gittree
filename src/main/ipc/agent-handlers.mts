import type { AgentSessionService } from '../agents/agent-session-service.mts';
import type { RepositoryWorkspace } from '../repository-workspace.mts';

interface OpenDialogResult {
  canceled: boolean;
  filePaths?: string[];
}

interface MainWindowLike {
  webContents: { send(channel: string, payload: unknown): void };
}

interface AgentHandlerDependencies {
  registerHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  registerManagedRepoHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  agentSessionService: AgentSessionService;
  repositoryWorkspace: RepositoryWorkspace;
  consumeAuthorizedDirectory?: (value: unknown) => unknown;
  showOpenDialog?: (window: unknown, options: Record<string, unknown>) => Promise<OpenDialogResult>;
  getMainWindow?: () => MainWindowLike | null;
}

export function registerAgentHandlers({
  registerHandler,
  registerManagedRepoHandler,
  agentSessionService,
  repositoryWorkspace,
  consumeAuthorizedDirectory = value => value,
  showOpenDialog,
  getMainWindow
}: AgentHandlerDependencies) {
  registerHandler('agent:settings', () => agentSessionService.getSettings());
  registerHandler('agent:root-select', async () => {
    const result = await showOpenDialog!(getMainWindow?.() ?? null, {
      title: 'Choose agent worktree root',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return agentSessionService.setWorktreeRoot(result.filePaths[0]);
  });
  registerHandler('agent:concurrency-set', value => (
    agentSessionService.setConcurrency(value)
  ));
  registerHandler('agent:enabled-set', enabled => (
    agentSessionService.setAgentsEnabled(enabled)
  ));
  registerHandler('agent:adapters-detect', () => agentSessionService.detectAdapters());
  registerHandler('agent:adapters-set', adapterIds => (
    agentSessionService.setEnabledAdapters(adapterIds)
  ));

  registerManagedRepoHandler('agent:tasks', repoPath => (
    agentSessionService.listTasks(String(repoPath))
  ));
  registerManagedRepoHandler('agent:task-create', (repoPath: string, options: Record<string, unknown> = {}) => {
    const safeOptions: Record<string, unknown> = { ...options };
    delete safeOptions.authorizedDestination;
    if (safeOptions.destinationPath) {
      safeOptions.authorizedDestination = consumeAuthorizedDirectory(safeOptions.destinationPath);
    }
    delete safeOptions.destinationPath;
    return agentSessionService.createTask(repoPath, safeOptions);
  });
  registerManagedRepoHandler('agent:task-create-worktree', (repoPath: string, worktreePath: string, options: Record<string, unknown>) => (
    agentSessionService.createTaskForWorktree(repoPath, worktreePath, options)
  ));
  registerManagedRepoHandler('agent:worktree-open', async (repoPath, worktreePath) => {
    const worktrees = await repositoryWorkspace.getGitService(repoPath).getWorktrees();
    const resolved = repositoryWorkspace.resolvePath(worktreePath);
    const belongs = worktrees.some(worktree => (
      repositoryWorkspace.pathKey(worktree.path) === repositoryWorkspace.pathKey(resolved)
    ));
    if (!belongs) throw new Error('Worktree does not belong to the registered repository');
    return repositoryWorkspace.addTrustedRepository(resolved);
  });

  registerHandler('agent:task-stop', taskId => agentSessionService.stopTask(String(taskId)));
  registerHandler('agent:task-resume', taskId => agentSessionService.resumeTask(String(taskId)));
  registerHandler('agent:task-archive', taskId => agentSessionService.archiveTask(String(taskId)));
  registerHandler('agent:terminal-write', (taskId, data) => (
    agentSessionService.writeTerminal(String(taskId), String(data))
  ));
  registerHandler('agent:terminal-resize', (taskId, cols, rows) => (
    agentSessionService.resizeTerminal(String(taskId), Number(cols), Number(rows))
  ));
  registerHandler('agent:attention-ack', taskId => (
    agentSessionService.acknowledgeAttention(String(taskId))
  ));
}



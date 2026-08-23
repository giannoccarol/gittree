import type { HostingService } from '../hosting-service.mts';
import type { CredentialVault } from '../credential-vault.mts';
import type { GitService } from '../git-service.mts';

type RegisterHandler = (channel: string, handler: (...args: never[]) => unknown) => void;

interface AuthHandlerDependencies {
  registerHandler: RegisterHandler;
  assertManagedRepo: (repoPath: unknown) => void;
  getHostingRepository: (repoPath: string, provider: string) => Promise<{ organization?: string }>;
  hostingService: HostingService;
  credentialVault: CredentialVault;
}

export function registerAuthHandlers({
  registerHandler,
  assertManagedRepo,
  getHostingRepository,
  hostingService,
  credentialVault
}: AuthHandlerDependencies) {
  const forwards = [
    ['auth:provider-status', 'providerStatus'],
    ['auth:provider-login', 'login'],
    ['auth:provider-cancel', 'cancelLogin'],
    ['auth:provider-logout', 'logout']
  ];
  for (const [channel, method] of forwards) {
    registerHandler(channel, (...args: unknown[]) => (hostingService[method as keyof HostingService] as (...a: unknown[]) => unknown)(...args));
  }
  registerHandler('auth:vault-reset', () => credentialVault.reset());
  registerHandler('auth:set-pat', async (provider: string, token: string, repoPath?: string) => {
    if (repoPath) assertManagedRepo(repoPath);
    let organization;
    if (provider === 'azure' && repoPath) {
      try {
        const repository = await getHostingRepository(repoPath, provider);
        organization = repository.organization;
      } catch {
        organization = undefined;
      }
    }
    return hostingService.setPat(provider, token, organization);
  });
}

interface PullRequestHandlerDependencies {
  registerManagedRepoHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  getHostingRepository: (repoPath: string, provider: string) => Promise<Record<string, unknown> & { organization?: string; remoteName?: string; webBase?: string }>;
  getGitService: (repoPath: string) => GitService;
  hostingService: HostingService;
  isSafeExternalUrl: (url: string) => boolean;
  openExternal: (url: string) => Promise<void> | void;
}

export function registerPullRequestHandlers({
  registerManagedRepoHandler,
  getHostingRepository,
  getGitService,
  hostingService,
  isSafeExternalUrl,
  openExternal
}: PullRequestHandlerDependencies) {
  type WithRepositoryImplementation = (
    repository: Record<string, unknown>,
    provider: string,
    repoPath: string,
    ...args: never[]
  ) => unknown;
  const withRepository = (implementation: WithRepositoryImplementation) =>
    async (repoPath: string, provider: string, ...args: unknown[]) => {
      const repository = await getHostingRepository(repoPath, provider);
      return (implementation as (
        repository: Record<string, unknown>,
        provider: string,
        repoPath: string,
        ...args: unknown[]
      ) => unknown)(repository, provider, repoPath, ...args);
    };
  registerManagedRepoHandler(
    'hosting:pull-request-create',
    withRepository((repository, _provider, _repoPath, input) => (
      hostingService.createPullRequest(repository as Parameters<HostingService['createPullRequest']>[0], input as Parameters<HostingService['createPullRequest']>[1])
    ))
  );
  registerManagedRepoHandler(
    'hosting:pull-requests',
    withRepository((repository, _provider, _repoPath, options) => (
      hostingService.listPullRequests(repository as Parameters<HostingService['listPullRequests']>[0], options as Parameters<HostingService['listPullRequests']>[1])
    ))
  );
  registerManagedRepoHandler(
    'hosting:pull-request-detail',
    withRepository(async (repository, _provider, _repoPath, id: string) => {
      const detail = await hostingService.pullRequestDetail(repository, String(id));
      let reviewDraft;
      try {
        reviewDraft = await hostingService.getReviewDraft(repository as Parameters<HostingService['getReviewDraft']>[0], String(id), String((detail as { headSha?: unknown }).headSha || ''));
      } catch {
        reviewDraft = null;
      }
      return { ...detail, reviewDraft };
    })
  );
  registerManagedRepoHandler(
    'hosting:pull-request-diff',
    withRepository((repository, _provider, _repoPath, id: string, page: number) => (
      hostingService.pullRequestDiff(repository, id, Number(page))
    ))
  );
  registerManagedRepoHandler(
    'hosting:review-draft-save',
    withRepository((repository, _provider, _repoPath, id, draft) => (
      hostingService.saveReviewDraft(repository as Parameters<HostingService['saveReviewDraft']>[0], String(id), draft as Record<string, unknown>)
    ))
  );
  registerManagedRepoHandler(
    'hosting:review-submit',
    withRepository((repository, _provider, _repoPath, id, draft) => (
      hostingService.submitReview(repository as Parameters<HostingService['submitReview']>[0], String(id), draft as Record<string, unknown>)
    ))
  );
  registerManagedRepoHandler(
    'hosting:thread-resolve',
    withRepository((repository, _provider, _repoPath, id, thread, resolved) => (
      hostingService.resolveThread(repository as Parameters<HostingService['resolveThread']>[0], String(id), thread as Record<string, unknown>, Boolean(resolved))
    ))
  );
  registerManagedRepoHandler(
    'hosting:checkout-source',
    withRepository((repository, provider, repoPath, pullRequest, confirmed) => {
      const pr = (pullRequest ?? {}) as Record<string, unknown>;
      return getGitService(repoPath).checkoutPullRequestSource({
        provider,
        remote: String(repository.remoteName),
        number: pr.number,
        source: pr.source,
        headSha: pr.headSha,
        localBranch: pr.localBranch,
        confirmed: Boolean(confirmed)
      });
    })
  );
  registerManagedRepoHandler(
    'hosting:open-review-browser',
    withRepository(async (repository, provider, _repoPath, id) => {
      const safeId = Number(id);
      if (!Number.isSafeInteger(safeId) || safeId <= 0) {
        throw new Error('Invalid pull request ID');
      }
      const url = provider === 'github'
        ? `${repository.webBase}/pull/${safeId}`
        : provider === 'azure'
          ? `${repository.webBase}/pullrequest/${safeId}`
          : `${repository.webBase}/-/merge_requests/${safeId}`;
      if (!isSafeExternalUrl(url)) throw new Error('Unsafe review URL');
      await openExternal(url);
      return { success: true };
    })
  );
}

interface OpenPullRequestDependencies {
  registerManagedRepoHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  getGitService: (repoPath: string) => GitService;
  buildPullRequestUrl: (provider: unknown, source: string, target: string) => string | null;
  isSafeExternalUrl: (url: string) => boolean;
  openExternal: (url: string) => Promise<void> | void;
}

export function registerOpenPullRequest({
  registerManagedRepoHandler,
  getGitService,
  buildPullRequestUrl,
  isSafeExternalUrl,
  openExternal
}: OpenPullRequestDependencies) {
  registerManagedRepoHandler(
    'app:open-pull-request',
    async (repoPath: string, remoteName: string, sourceBranch: string, targetBranch: string) => {
      const git = getGitService(repoPath);
      await git.assertValidBranchName(sourceBranch);
      await git.assertValidBranchName(targetBranch);
      const metadata = await git.getBranchMetadata();
      const remote = metadata.remotes.find((item: { name?: string }) => item.name === remoteName);
      if (!remote) return { error: 'Remote not found' };
      const url = buildPullRequestUrl(remote.provider, sourceBranch, targetBranch);
      if (!url) return { error: 'Pull requests are not supported for this remote provider' };
      if (!isSafeExternalUrl(url)) return { error: 'Unsafe pull request URL' };
      await openExternal(url);
      return { success: true, url };
    }
  );
}

export function registerHostingHandlers(
  dependencies: AuthHandlerDependencies & PullRequestHandlerDependencies & OpenPullRequestDependencies
) {
  registerAuthHandlers(dependencies);
  registerPullRequestHandlers(dependencies);
  registerOpenPullRequest(dependencies);
}

import type {
  ProviderPayload,
  HostingApiResult,
  PullRequestSummary,
  PullRequestFile,
  PullRequestDetail,
  PullRequestListPage,
  HostedRepositoryRef,
  HostingAccount
} from '../../../shared/hosting.mts';

export class AzureProviderAdapter {
  private api: (
    repo: HostedRepositoryRef,
    path: string,
    options?: Record<string, unknown>
  ) => Promise<HostingApiResult>;

  private identityMatches: (
    user: Record<string, unknown> | null | undefined,
    reviewer: ProviderPayload
  ) => boolean;

  private identitySearch: (
    organization: string | undefined,
    name: string
  ) => Promise<ProviderPayload[]>;

  constructor({ api, identityMatches, identitySearch }: {
    api: (repo: HostedRepositoryRef, path: string, options?: Record<string, unknown>) => Promise<HostingApiResult>;
    identityMatches: (user: Record<string, unknown> | null | undefined, reviewer: ProviderPayload) => boolean;
    identitySearch: (organization: string | undefined, name: string) => Promise<ProviderPayload[]>;
  }) {
    this.api = api;
    this.identityMatches = identityMatches;
    this.identitySearch = identitySearch;
  }

  normalizeSummary(item: ProviderPayload, user: HostingAccount['user']): PullRequestSummary {
    const author = item.createdBy || {};
    return {
      provider: 'azure',
      id: item.pullRequestId,
      number: item.pullRequestId,
      title: item.title || '',
      author: {
        login: author.uniqueName || author.displayName || '',
        id: author.id || '',
        avatarUrl: author._links?.avatar?.href || ''
      },
      source: (item.sourceRefName || '').replace('refs/heads/', ''),
      target: (item.targetRefName || '').replace('refs/heads/', ''),
      headSha: item.lastMergeSourceCommit?.commitId
        || item.lastMergeCommit?.commitId
        || '',
      state: item.status === 'active' || item.status === 'open'
        ? 'open'
        : item.status === 'completed'
          ? 'merged'
          : item.status === 'abandoned'
            ? 'abandoned'
            : item.status,
      draft: Boolean(item.isDraft),
      reviewStatus: (item.reviewers as Array<{vote?: unknown}> || []).some(
        (reviewer: {vote?: unknown}) => reviewer.vote === 0 && this.identityMatches(user, reviewer)
      ) ? 'requested' : 'none',
      ciStatus: item.mergeStatus === 'succeeded'
        ? 'success'
        : item.mergeStatus === 'conflicts' ? 'failure' : 'unknown',
      reviewers: item.reviewers || []
    };
  }

  async listPullRequests(
    repo: HostedRepositoryRef,
    { page, filter, search, account }: {
      page: number;
      filter: string;
      search?: string;
      account: HostingAccount;
    }
  ): Promise<PullRequestListPage> {
    const skip = (page - 1) * 50;
    const status = filter === 'all' ? 'all' : 'active';
    const result = await this.api(
      repo,
      `/pullrequests?searchCriteria.status=${status}&$top=50&$skip=${skip}`
    );
    if (!result.data || !Array.isArray(result.data.value)) {
      throw new Error('Failed to load pull requests');
    }
    let items = (result.data.value as ProviderPayload[]).map((item: ProviderPayload) => this.normalizeSummary(item, account.user));
    if (filter === 'authored') {
      items = items.filter((item: PullRequestSummary) => this.identityMatches(account.user, item.author as unknown as ProviderPayload));
    } else if (filter === 'review-requested') {
      items = items.filter((item: PullRequestSummary) => item.reviewStatus === 'requested');
    }
    if (search) {
      items = items.filter((item: PullRequestSummary) => (
        String(item.title || '').toLowerCase().includes(search)
        || String(item.source || '').toLowerCase().includes(search)
        || String(item.number) === search
      ));
    }
    return { items, page, hasMore: result.data.value.length >= 50 };
  }

  normalizeFile(entry: ProviderPayload): PullRequestFile | null {
    const filePath = String(entry?.item?.path || '').replace(/^\//, '');
    if (!filePath) return null;
    const changeType = String(entry.changeType || '').toLowerCase();
    let status = 'modified';
    if (changeType.includes('add')) status = 'added';
    else if (changeType.includes('delete')) status = 'removed';
    else if (changeType.includes('rename') || changeType.includes('sourceRename')) {
      status = 'renamed';
    }
    const oldPath = entry.originalPath
      ? String(entry.originalPath).replace(/^\//, '')
      : null;
    return {
      path: filePath,
      oldPath: oldPath && oldPath !== filePath ? oldPath : null,
      status,
      additions: 0,
      deletions: 0,
      binary: Boolean(entry.item?.isFolder),
      patch: ''
    };
  }

  async listPullRequestFiles(
    repo: HostedRepositoryRef,
    id: number
  ): Promise<{ files: PullRequestFile[]; headSha: string }> {
    try {
      const iterations = await this.api(repo, `/pullrequests/${id}/iterations`);
      const list = iterations.data.value || [];
      if (!list.length) return { files: [], headSha: '' };
      const latest = list[list.length - 1];
      const headSha = latest.sourceRefCommit?.commitId
        || latest.commonRefCommit?.commitId
        || '';
      const changes = await this.api(
        repo,
        `/pullrequests/${id}/iterations/${latest.id}/changes?$top=100`
      );
      return {
        files: (changes.data.changeEntries || [])
          .map((entry: ProviderPayload) => this.normalizeFile(entry))
          .filter(Boolean),
        headSha
      };
    } catch {
      return { files: [], headSha: '' };
    }
  }

  async pullRequestDetail(
    repo: HostedRepositoryRef,
    id: number,
    { viewer }: { viewer: HostingAccount['user'] }
  ): Promise<PullRequestDetail> {
    const result = await this.api(repo, `/pullrequests/${id}`);
    const pullRequest = result.data;
    const [threadsResult, fileResult] = await Promise.all([
      this.api(repo, `/pullrequests/${id}/threads`).catch(() => ({ data: { value: [] as ProviderPayload[] } })),
      this.listPullRequestFiles(repo, id)
    ]);
    const summary = this.normalizeSummary(pullRequest, viewer);
    const headSha = summary.headSha
      || fileResult.headSha
      || pullRequest.lastMergeSourceCommit?.commitId
      || '';
    return {
      summary: { ...summary, headSha },
      permissions: { review: true, resolveThreads: true, checkout: false },
      reviewers: (pullRequest.reviewers as ProviderPayload[] || []).map((reviewer: ProviderPayload) => ({
        login: reviewer.uniqueName || reviewer.displayName || '',
        state: reviewer.vote === 10
          ? 'APPROVED'
          : reviewer.vote === -10
            ? 'CHANGES_REQUESTED'
            : reviewer.vote === 5
              ? 'APPROVED'
              : reviewer.vote === 0 ? 'requested' : 'none',
        vote: reviewer.vote
      })),
      checks: [],
      files: fileResult.files,
      threads: (threadsResult.data.value as ProviderPayload[] || []).map((thread: ProviderPayload) => ({
        id: String(thread.id),
        commentId: (thread.comments?.[0] as ProviderPayload | undefined)?.id ?? null,
        resolved: thread.status === 'closed' || thread.status === 'fixed',
        path: thread.threadContext?.filePath || '',
        line: thread.threadContext?.rightFileEnd?.line || null,
        side: 'RIGHT',
        author: thread.comments?.[0]?.author?.uniqueName || '',
        body: thread.comments?.[0]?.content || '',
        createdAt: thread.comments?.[0]?.publishedDate,
        notes: (thread.comments as ProviderPayload[] || []).map((comment: ProviderPayload) => ({
          id: comment.id,
          author: comment.author?.uniqueName || '',
          body: comment.content || '',
          createdAt: comment.publishedDate
        }))
      })),
      headSha,
      mergeability: pullRequest.mergeStatus || 'unknown'
    };
  }

  async pullRequestDiff(repo: HostedRepositoryRef, id: number): Promise<{ files: PullRequestFile[]; page: number; hasMore: false }> {
    const { files } = await this.listPullRequestFiles(repo, id);
    return { files, page: 1, hasMore: false };
  }

  async resolveThread(
    repo: HostedRepositoryRef,
    id: number,
    thread: { id: string },
    resolved: boolean
  ): Promise<{ success: true; resolved: boolean }> {
    await this.api(
      repo,
      `/pullrequests/${id}/threads/${thread.id}`,
      { method: 'PATCH', body: { status: resolved ? 'closed' : 'active' } }
    );
    return { success: true, resolved: Boolean(resolved) };
  }

  async submitReview(
    repo: HostedRepositoryRef,
    id: number,
    draft: {
      body?: string;
      event: string;
      inlineComments: Array<{ body: string; path: string; line: number | null }>;
      replies: Array<{ threadId: unknown; commentId?: number | null; body: string }>;
      completedOperations?: string[];
    },
    { viewer, markCompleted, validateThreadId }: {
      viewer: HostingAccount['user'];
      markCompleted: (operation: string) => Promise<void> | void;
      validateThreadId: (threadId: unknown) => string;
    }
  ): Promise<{ success: true }> {
    const completed = new Set(draft.completedOperations);
    const perform = async (operation: string, action: () => Promise<unknown>): Promise<void> => {
      if (completed.has(operation)) return;
      await action();
      completed.add(operation);
      await markCompleted(operation);
    };
    for (let index = 0; index < draft.inlineComments.length; index += 1) {
      const comment = draft.inlineComments[index];
      await perform(`inline:${index}`, () => this.api(repo, `/pullrequests/${id}/threads`, {
        method: 'POST',
        body: {
          comments: [{ parentCommentId: 0, content: comment.body, commentType: 'text' }],
          status: 'active',
          threadContext: {
            filePath: comment.path,
            rightFileEnd: { line: comment.line, offset: 1 }
          }
        }
      }));
    }
    for (let index = 0; index < draft.replies.length; index += 1) {
      const reply = draft.replies[index];
      const threadId = validateThreadId(reply.threadId);
      await perform(`reply:${index}`, () => this.api(
        repo,
        `/pullrequests/${id}/threads/${encodeURIComponent(threadId)}/comments`,
        {
          method: 'POST',
          body: {
            parentCommentId: Number.isSafeInteger(reply.commentId) ? reply.commentId : 0,
            content: reply.body,
            commentType: 'text'
          }
        }
      ));
    }
    if (draft.body) {
      await perform('summary', () => this.api(repo, `/pullrequests/${id}/threads`, {
        method: 'POST',
        body: {
          comments: [{ parentCommentId: 0, content: draft.body, commentType: 'text' }],
          status: 'active'
        }
      }));
    }
    const votes = { APPROVE: ['approve', 10] as [string, number], REQUEST_CHANGES: ['request-changes', -10] as [string, number] };
    const vote = (votes as unknown as Record<string, [string, number]>)[draft.event];
    if (vote) {
      await perform(vote[0], async () => {
        const reviewersResult = await this.api(repo, `/pullrequests/${id}/reviewers`);
        const reviewer = (reviewersResult.data.value as ProviderPayload[] || []).find(
          (item: ProviderPayload) => this.identityMatches(viewer, item)
        );
        if (reviewer) {
          await this.api(repo, `/pullrequests/${id}/reviewers/${reviewer.id}`, {
            method: 'PUT',
            body: { vote: vote[1] }
          });
        }
      });
    }
    return { success: true };
  }

  async resolveReviewers(
    repo: HostedRepositoryRef,
    names: string[]
  ): Promise<Array<{ id: unknown }>> {
    const reviewers = [];
    for (const name of names) {
      const matches = await this.identitySearch(repo.organization, name);
      const exact = matches.find((item: Record<string, unknown>) => this.identityMatches(
        { login: name, name, id: name },
        {
          id: item.id,
          uniqueName: (item as { properties?: { Account?: { $value?: unknown }, Mail?: { $value?: unknown } } }).properties?.Account?.$value || (item as { properties?: { Account?: { $value?: unknown }, Mail?: { $value?: unknown } } }).properties?.Mail?.$value,
          displayName: item.providerDisplayName || item.customDisplayName,
          login: (item as { properties?: { Account?: { $value?: unknown }, Mail?: { $value?: unknown } } }).properties?.Account?.$value
        }
      )) || matches.find((item: Record<string, unknown>) => {
        const haystack = [
          item.providerDisplayName,
          item.customDisplayName,
          item.uniqueName,
          (item as { properties?: { Account?: { $value?: unknown }, Mail?: { $value?: unknown } } }).properties?.Account?.$value,
          (item as { properties?: { Account?: { $value?: unknown }, Mail?: { $value?: unknown } } }).properties?.Mail?.$value
        ].filter(Boolean).map((value: unknown) => String(value).toLowerCase());
        return haystack.includes(name.toLowerCase());
      }) || matches[0];
      if (!exact?.id) throw new Error(`Azure reviewer not found: ${name}`);
      reviewers.push({ id: exact.id });
    }
    return reviewers;
  }

  buildDescription(body: unknown, workItems?: Array<number | string>): string {
    const base = String(body || '').replace(/\s+$/, '');
    const mentions = (workItems || [])
      .filter(id => !new RegExp(`AB#${id}\\b`, 'i').test(base))
      .map(id => `AB#${id}`);
    if (!mentions.length) return base;
    return [base, '', ...mentions].join('\n').slice(0, 65536);
  }

  async createPullRequest(
    repo: HostedRepositoryRef,
    options: {
      title: string;
      source: string;
      target: string;
      body?: string;
      draft?: boolean;
      reviewers?: string[];
      labels?: string[];
      workItems?: Array<number | string>;
    },
    { viewer }: { viewer: HostingAccount['user'] }
  ) {
    const body: Record<string, unknown> = {
      sourceRefName: `refs/heads/${options.source}`,
      targetRefName: `refs/heads/${options.target}`,
      title: options.title,
      description: this.buildDescription(options.body, options.workItems),
      isDraft: options.draft
    };
    const reviewers = options.reviewers ?? [];
    const workItems = options.workItems ?? [];
    if (reviewers.length) {
      body.reviewers = await this.resolveReviewers(repo, reviewers);
    }
    if (workItems.length) {
      body.workItemRefs = workItems.map(id => ({ id: String(id) }));
    }
    const created = await this.api(repo, '/pullrequests', { method: 'POST', body });
    const warnings = [];
    for (const label of options.labels ?? []) {
      try {
        await this.api(repo, `/pullrequests/${created.data.pullRequestId}/labels`, {
          method: 'POST',
          body: { name: label }
        });
      } catch (error) {
        warnings.push(error.message);
      }
    }
    const summary = this.normalizeSummary(created.data, viewer);
    return {
      success: true,
      pullRequest: summary,
      url: `https://dev.azure.com/${encodeURIComponent(String(repo.organization))}/${encodeURIComponent(String(repo.project))}/_git/${encodeURIComponent(repo.repository)}/pullrequest/${summary.number}`,
      warnings
    };
  }
}


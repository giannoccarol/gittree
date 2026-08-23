import type {
  ProviderPayload,
  HostingApiResult,
  PullRequestSummary,
  PullRequestFile,
  PullRequestDetail,
  PullRequestListPage,
  PullRequestDiffPage,
  HostedRepositoryRef,
  HostingAccount
} from '../../../shared/hosting.mts';

export class GitHubProviderAdapter {
  private api: (
    repo: HostedRepositoryRef,
    path: string,
    options?: Record<string, unknown>
  ) => Promise<HostingApiResult>;

  private graphql: (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<HostingApiResult>;

  constructor({ api, graphql }: {
    api: (repo: HostedRepositoryRef, path: string, options?: Record<string, unknown>) => Promise<HostingApiResult>;
    graphql: (query: string, variables?: Record<string, unknown>) => Promise<HostingApiResult>;
  }) {
    this.api = api;
    this.graphql = graphql;
  }

  normalizeSummary(item: ProviderPayload, user: HostingAccount['user']): PullRequestSummary {
    return {
      provider: 'github',
      id: item.id,
      number: item.number,
      title: item.title,
      author: {
        login: item.user?.login || '',
        avatarUrl: item.user?.avatar_url || ''
      },
      source: item.head?.ref || '',
      target: item.base?.ref || '',
      headSha: item.head?.sha || '',
      state: item.merged_at || item.merged ? 'merged' : item.state,
      draft: Boolean(item.draft),
      reviewStatus: (item.requested_reviewers as ProviderPayload[] || []).some(
        (reviewer: ProviderPayload) => reviewer.login === user?.login
      ) ? 'requested' : 'none',
      ciStatus: 'unknown'
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
    const state = filter === 'all' ? 'all' : 'open';
    const result = await this.api(
      repo,
      `/repos/${encodeURIComponent(repo.ownerPath)}/${encodeURIComponent(repo.repository)}/pulls?state=${state}&per_page=50&page=${page}`
    );
    if (!Array.isArray(result.data)) throw new Error('Failed to load pull requests');
    let items = (result.data as ProviderPayload[]).map((item: ProviderPayload) => this.normalizeSummary(item, account.user));
    if (filter === 'authored') {
      items = items.filter((item: PullRequestSummary) => item.author?.login === account.user?.login);
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
    return {
      items,
      page,
      hasMore: /rel="next"/.test(result.headers?.get('link') || '')
    };
  }

  normalizeFile(file: ProviderPayload): PullRequestFile {
    return {
      path: file.filename,
      oldPath: file.previous_filename || null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: !file.patch,
      patch: file.patch || ''
    };
  }

  async pullRequestDetail(
    repo: HostedRepositoryRef,
    id: number,
    { viewer }: { viewer: HostingAccount['user'] }
  ): Promise<PullRequestDetail> {
    const prefix =
      `/repos/${encodeURIComponent(repo.ownerPath)}/${encodeURIComponent(repo.repository)}`;
    const pull = await this.api(repo, `${prefix}/pulls/${id}`);
    const headSha = pull.data.head?.sha;
    if (!headSha) throw new Error('Pull request head SHA is unavailable');
    const [reviews, checks, files, threadResult] = await Promise.all([
      this.api(repo, `${prefix}/pulls/${id}/reviews?per_page=100`),
      this.api(repo, `${prefix}/commits/${headSha}/check-runs?per_page=100`).catch(() => ({
        data: { check_runs: [] as ProviderPayload[] }
      })),
      this.api(repo, `${prefix}/pulls/${id}/files?per_page=100`),
      this.graphql(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    nodes {
                      id
                      databaseId
                      body
                      path
                      line
                      originalLine
                      diffSide
                      createdAt
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }`,
        { owner: repo.ownerPath, name: repo.repository, number: id }
      ).catch(() => ({ data: null as unknown as ProviderPayload }))
    ]);
    const latestReviews = new Map<string, ProviderPayload>();
    (reviews.data as ProviderPayload[]).forEach((review: ProviderPayload) => {
      latestReviews.set(review.user?.login || '', {
        login: review.user?.login || '',
        state: review.state,
        submittedAt: review.submitted_at
      });
    });
    return {
      summary: this.normalizeSummary(pull.data, viewer),
      permissions: { review: true, resolveThreads: true, checkout: true },
      reviewers: [...latestReviews.values()],
      checks: (((checks.data as ProviderPayload).check_runs as ProviderPayload[] | undefined) || []).map((check: ProviderPayload) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        url: check.html_url
      })),
      files: ((files.data as ProviderPayload[] | undefined) || []).map((file: ProviderPayload) => this.normalizeFile(file)),
      threads: (
        ((threadResult.data as ProviderPayload)?.repository?.pullRequest?.reviewThreads?.nodes as ProviderPayload[] | undefined) || []
      ).map((thread: ProviderPayload) => {
        const comments = ((thread.comments as ProviderPayload | undefined)?.nodes as ProviderPayload[] | undefined) || [];
        const first = (comments[0] as ProviderPayload | undefined) || {} as ProviderPayload;
        return {
          id: thread.id,
          commentId: first.databaseId || null,
          path: first.path || '',
          line: first.line || first.originalLine || null,
          side: first.diffSide || 'RIGHT',
          resolved: Boolean(thread.isResolved),
          author: (first.author as ProviderPayload | undefined)?.login || '',
          body: first.body || '',
          createdAt: first.createdAt,
          notes: comments.map((comment: ProviderPayload) => ({
            id: comment.databaseId,
            author: (comment.author as ProviderPayload | undefined)?.login || '',
            body: comment.body || '',
            createdAt: comment.createdAt
          }))
        };
      }),
      headSha,
      mergeability: pull.data.mergeable_state || (
        pull.data.mergeable === true ? 'mergeable' : 'unknown'
      )
    };
  }

  async pullRequestDiff(
    repo: HostedRepositoryRef,
    id: number,
    page: number
  ): Promise<PullRequestDiffPage> {
    const result = await this.api(
      repo,
      `/repos/${encodeURIComponent(repo.ownerPath)}/${encodeURIComponent(repo.repository)}/pulls/${id}/files?per_page=50&page=${page}`
    );
    return {
      files: (result.data as ProviderPayload[]).map((file: ProviderPayload) => this.normalizeFile(file)),
      page,
      hasMore: /rel="next"/.test(result.headers?.get('link') || '')
    };
  }

  async resolveThread(
    _repo: HostedRepositoryRef,
    _id: number,
    thread: { id: string },
    resolved: boolean
  ): Promise<{ success: true; resolved: boolean }> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const result = await this.graphql(
      `mutation($threadId: ID!) { ${mutation}(input: {threadId: $threadId}) { thread { id isResolved } } }`,
      { threadId: thread.id }
    );
    const updated = result.data?.[mutation]?.thread;
    return { success: true, resolved: Boolean(updated?.isResolved) };
  }

  async submitReview(
    repo: HostedRepositoryRef,
    id: number,
    draft: {
      headSha: string;
      body: string;
      event: string;
      inlineComments: unknown[];
      replies: Array<{ commentId?: number | null; body: string }>
    }
  ): Promise<{ success: true; review: { id: unknown; state: unknown } }> {
    const prefix =
      `/repos/${encodeURIComponent(repo.ownerPath)}/${encodeURIComponent(repo.repository)}`;
    const result = await this.api(repo, `${prefix}/pulls/${id}/reviews`, {
      method: 'POST',
      body: {
        commit_id: draft.headSha,
        body: draft.body,
        event: draft.event,
        comments: draft.inlineComments
      }
    });
    for (const reply of draft.replies) {
      if (!reply.commentId) throw new Error('GitHub reply is missing its comment ID');
      await this.api(
        repo,
        `${prefix}/pulls/${id}/comments/${reply.commentId}/replies`,
        { method: 'POST', body: { body: reply.body } }
      );
    }
    return { success: true, review: { id: result.data.id, state: result.data.state } };
  }

  async createPullRequest(
    repo: HostedRepositoryRef,
    options: {
      title: string;
      source: string;
      target: string;
      body?: string;
      draft?: boolean;
      maintainerCanModify?: boolean;
      reviewers?: string[];
      assignees?: string[];
      labels?: string[];
    },
    { viewer }: { viewer: HostingAccount['user'] }
  ) {
    const prefix =
      `/repos/${encodeURIComponent(repo.ownerPath)}/${encodeURIComponent(repo.repository)}`;
    const created = await this.api(repo, `${prefix}/pulls`, {
      method: 'POST',
      body: {
        title: options.title,
        head: options.source,
        base: options.target,
        body: options.body,
        draft: options.draft,
        maintainer_can_modify: options.maintainerCanModify
      }
    });
    const number = created.data.number;
    const warnings: string[] = [];
    for (const [values, endpoint, key] of [
      [options.reviewers, `pulls/${number}/requested_reviewers`, 'reviewers'],
      [options.assignees, `issues/${number}/assignees`, 'assignees'],
      [options.labels, `issues/${number}/labels`, 'labels']
    ] as Array<[string[] | undefined, string, string]>) {
      if (!values?.length) continue;
      try {
        await this.api(repo, `${prefix}/${endpoint}`, {
          method: 'POST',
          body: { [key]: values }
        });
      } catch (error: unknown) {
        warnings.push((error as Error).message);
      }
    }
    return {
      success: true,
      pullRequest: this.normalizeSummary(created.data, viewer),
      url: created.data.html_url || '',
      warnings
    };
  }
}


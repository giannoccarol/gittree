const test = require('node:test');
const assert = require('node:assert/strict');
const { HostingService } = require('../src/main/hosting-service.mts');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function memoryVault(account) {
  const drafts = new Map();
  return {
    getSecurityState: () => ({ memoryOnly: false, warning: '' }),
    getAccount: async () => account,
    setAccount: async () => {},
    removeAccount: async () => {},
    getReviewDraft: async key => drafts.get(key) || null,
    saveReviewDraft: async (key, value) => drafts.set(key, value),
    removeReviewDraft: async key => drafts.delete(key),
    removeProviderDrafts: async () => {}
  };
}

test('normalizes GitHub pull requests and keeps authorization data out of results', async () => {
  const requests = [];
  const service = new HostingService({
    vault: memoryVault({
      accessToken: 'top-secret',
      user: { login: 'octocat' }
    }),
    oauthConfig: { github: 'client-id' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse([
        {
          id: 91,
          number: 7,
          title: 'Improve graph',
          user: { login: 'alice', avatar_url: 'https://example.test/a.png' },
          head: { ref: 'feature/graph', sha: 'abc' },
          base: { ref: 'main' },
          state: 'open',
          draft: false,
          requested_reviewers: [{ login: 'octocat' }]
        }
      ], 200, { link: '<next>; rel="next"' });
    }
  });

  const result = await service.listPullRequests(
    { provider: 'github', host: 'github.com', ownerPath: 'owner', repository: 'repo' },
    { filter: 'review-requested', page: 1, search: 'graph' }
  );

  assert.equal(result.items[0].number, 7);
  assert.equal(result.items[0].source, 'feature/graph');
  assert.equal(result.items[0].reviewStatus, 'requested');
  assert.equal(result.hasMore, true);
  assert.equal(JSON.stringify(result).includes('top-secret'), false);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer top-secret');
});

test('encrypted review drafts become stale when the provider head SHA changes', async () => {
  const vault = memoryVault({ accessToken: 'token', user: { login: 'me' } });
  const service = new HostingService({
    vault,
    oauthConfig: { github: 'client-id' },
    fetch: async () => jsonResponse({})
  });
  const repository = {
    provider: 'github',
    host: 'github.com',
    ownerPath: 'owner',
    repository: 'repo'
  };
  await service.saveReviewDraft(repository, 7, {
    headSha: 'a'.repeat(40),
    event: 'COMMENT',
    inlineComments: [],
    replies: []
  });

  const draft = await service.getReviewDraft(repository, 7, 'b'.repeat(40));
  assert.equal(draft.stale, true);
  assert.equal(draft.headSha, 'a'.repeat(40));
});

test('submits one atomic GitHub review with validated inline comments', async () => {
  const requests = [];
  const vault = memoryVault({ accessToken: 'token', user: { login: 'me' } });
  const service = new HostingService({
    vault,
    oauthConfig: { github: 'client-id' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ id: 123, state: 'APPROVED' });
    }
  });
  const repository = {
    provider: 'github',
    host: 'github.com',
    ownerPath: 'owner',
    repository: 'repo'
  };

  const result = await service.submitReview(repository, 7, {
    headSha: 'a'.repeat(40),
    body: 'Looks good',
    event: 'APPROVE',
    inlineComments: [{
      path: 'src/app.js',
      line: 10,
      side: 'RIGHT',
      body: 'Clear implementation'
    }],
    replies: []
  });

  assert.equal(result.success, true);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.event, 'APPROVE');
  assert.equal(payload.comments[0].line, 10);
  assert.equal(requests.length, 1);
});

test('GitLab partial review retries do not duplicate completed discussions', async () => {
  const requests = [];
  let secondFailures = 0;
  const vault = memoryVault({ accessToken: 'token', user: { login: 'me' } });
  const service = new HostingService({
    vault,
    oauthConfig: { gitlab: 'client-id' },
    fetch: async (url, options) => {
      const payload = options.body ? JSON.parse(options.body) : {};
      requests.push({ url, payload });
      if (payload.body === 'second' && secondFailures++ === 0) {
        return jsonResponse({ message: 'temporary failure' }, 500);
      }
      return jsonResponse({ id: requests.length });
    }
  });
  const repository = {
    provider: 'gitlab',
    host: 'gitlab.com',
    ownerPath: 'group',
    repository: 'repo'
  };
  const draft = {
    headSha: 'a'.repeat(40),
    body: '',
    event: 'COMMENT',
    inlineComments: [
      { path: 'one.js', line: 1, side: 'RIGHT', body: 'first' },
      { path: 'two.js', line: 2, side: 'RIGHT', body: 'second' }
    ],
    replies: []
  };

  await assert.rejects(service.submitReview(repository, 4, draft), /temporary failure/);
  const result = await service.submitReview(repository, 4, draft);

  assert.equal(result.success, true);
  assert.equal(requests.filter(request => request.payload.body === 'first').length, 1);
  assert.equal(requests.filter(request => request.payload.body === 'second').length, 2);
});

test('azure PAT sign-in validates against the organization connectionData endpoint', async () => {
  const requests = [];
  let stored = null;
  const vault = memoryVault(null);
  vault.setAccount = async (provider, account) => { stored = { provider, account }; };
  const token = 'a'.repeat(52);
  const service = new HostingService({
    vault,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        authenticatedUser: {
          id: 'user-guid',
          providerDisplayName: 'patricia@contoso.com',
          customDisplayName: 'Patricia'
        }
      });
    }
  });

  const result = await service.setPat('azure', token, 'contoso');

  assert.equal(requests[0].url, 'https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1-preview');
  assert.equal(
    requests[0].options.headers.Authorization,
    `Basic ${Buffer.from(`:${token}`).toString('base64')}`
  );
  assert.equal(result.user.login, 'patricia@contoso.com');
  assert.equal(result.user.name, 'Patricia');
  assert.equal(stored.provider, 'azure');
  assert.equal(stored.account.accessToken, token);
});

test('azure pull request URLs keep organization and project segments', async () => {
  const requests = [];
  const service = new HostingService({
    vault: memoryVault({ accessToken: 'token', user: { login: 'patricia@contoso.com' } }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ value: [] });
    }
  });

  await service.listPullRequests(
    {
      provider: 'azure',
      host: 'dev.azure.com',
      ownerPath: 'contoso/platform',
      repository: 'widgets',
      organization: 'contoso',
      project: 'platform'
    },
    { filter: 'open', page: 1 }
  );

  assert.equal(
    requests[0].url,
    'https://dev.azure.com/contoso/platform/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&$top=50&$skip=0&api-version=7.1-preview'
  );
  assert.equal(requests[0].url.includes('undefined'), false);
});

test('getReviewDraft returns null for missing head SHA instead of throwing', async () => {
  const service = new HostingService({
    vault: memoryVault({ accessToken: 'token', user: { login: 'me' } }),
    fetch: async () => jsonResponse({})
  });
  const repository = {
    provider: 'azure',
    host: 'dev.azure.com',
    ownerPath: 'contoso/platform',
    repository: 'widgets',
    organization: 'contoso',
    project: 'platform'
  };
  assert.equal(await service.getReviewDraft(repository, 7, ''), null);
  assert.equal(await service.getReviewDraft(repository, 7, null), null);
});

test('azure list filters review-requested and authored by identity', async () => {
  const service = new HostingService({
    vault: memoryVault({
      accessToken: 'token',
      user: { id: 'user-1', login: 'patricia@contoso.com', name: 'Patricia' }
    }),
    fetch: async () => jsonResponse({
      value: [
        {
          pullRequestId: 11,
          title: 'Mine',
          createdBy: { id: 'user-1', uniqueName: 'patricia@contoso.com', displayName: 'Patricia' },
          sourceRefName: 'refs/heads/feature-a',
          targetRefName: 'refs/heads/main',
          status: 'active',
          lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
          reviewers: []
        },
        {
          pullRequestId: 12,
          title: 'Needs me',
          createdBy: { id: 'other', uniqueName: 'other@contoso.com', displayName: 'Other' },
          sourceRefName: 'refs/heads/feature-b',
          targetRefName: 'refs/heads/main',
          status: 'active',
          lastMergeSourceCommit: { commitId: 'b'.repeat(40) },
          reviewers: [{ id: 'user-1', uniqueName: 'patricia@contoso.com', vote: 0 }]
        },
        {
          pullRequestId: 13,
          title: 'Unrelated',
          createdBy: { id: 'other', uniqueName: 'other@contoso.com', displayName: 'Other' },
          sourceRefName: 'refs/heads/feature-c',
          targetRefName: 'refs/heads/main',
          status: 'active',
          reviewers: [{ id: 'someone', uniqueName: 'someone@contoso.com', vote: 0 }]
        }
      ]
    })
  });
  const repository = {
    provider: 'azure',
    host: 'dev.azure.com',
    ownerPath: 'contoso/platform',
    repository: 'widgets',
    organization: 'contoso',
    project: 'platform'
  };

  const authored = await service.listPullRequests(repository, { filter: 'authored', page: 1 });
  assert.deepEqual(authored.items.map(item => item.number), [11]);

  const requested = await service.listPullRequests(repository, {
    filter: 'review-requested',
    page: 1
  });
  assert.deepEqual(requested.items.map(item => item.number), [12]);
});

test('azure pull request detail loads iteration files and tolerates empty draft SHA', async () => {
  const requests = [];
  const service = new HostingService({
    vault: memoryVault({
      accessToken: 'token',
      user: { id: 'user-1', login: 'patricia@contoso.com' }
    }),
    fetch: async url => {
      requests.push(url);
      if (url.includes('/iterations/') && url.includes('/changes')) {
        return jsonResponse({
          changeEntries: [
            { changeType: 'edit', item: { path: '/src/app.js' } },
            { changeType: 'add', item: { path: '/README.md' } }
          ]
        });
      }
      if (url.includes('/iterations')) {
        return jsonResponse({
          value: [{ id: 1, sourceRefCommit: { commitId: 'c'.repeat(40) } }]
        });
      }
      if (url.includes('/threads')) {
        return jsonResponse({ value: [] });
      }
      return jsonResponse({
        pullRequestId: 42,
        title: 'Ship it',
        createdBy: { id: 'user-1', uniqueName: 'patricia@contoso.com' },
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        status: 'active',
        mergeStatus: 'succeeded',
        reviewers: []
      });
    }
  });

  const detail = await service.pullRequestDetail(
    {
      provider: 'azure',
      host: 'dev.azure.com',
      ownerPath: 'contoso/platform',
      repository: 'widgets',
      organization: 'contoso',
      project: 'platform'
    },
    42
  );

  assert.equal(detail.summary.number, 42);
  assert.equal(detail.headSha, 'c'.repeat(40));
  assert.equal(detail.permissions.checkout, false);
  assert.equal(detail.files.length, 2);
  assert.equal(detail.files[0].path, 'src/app.js');
  assert.equal(requests.some(url => url.includes('api-version=7.1-preview')), true);
  assert.equal(await service.getReviewDraft({
    provider: 'azure',
    host: 'dev.azure.com',
    ownerPath: 'contoso/platform',
    repository: 'widgets',
    organization: 'contoso',
    project: 'platform'
  }, 42, detail.headSha) === null, true);
});

test('creates a complete GitHub pull request with reviewers assignees and labels', async () => {
  const requests = [];
  const service = new HostingService({
    vault: memoryVault({ accessToken: 'token', user: { login: 'me' } }),
    oauthConfig: { github: 'client-id' },
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || 'GET', body: options?.body });
      if (url.endsWith('/pulls') && options?.method === 'POST') {
        return jsonResponse({
          id: 99,
          number: 42,
          title: 'Ship feature',
          html_url: 'https://github.com/owner/repo/pull/42',
          user: { login: 'me' },
          head: { ref: 'feature', sha: 'a'.repeat(40) },
          base: { ref: 'main' },
          state: 'open',
          draft: true,
          requested_reviewers: []
        });
      }
      return jsonResponse({});
    }
  });

  const result = await service.createPullRequest(
    { provider: 'github', host: 'github.com', ownerPath: 'owner', repository: 'repo' },
    {
      title: 'Ship feature',
      body: 'Details',
      source: 'feature',
      target: 'main',
      draft: true,
      reviewers: 'alice, bob',
      assignees: 'carol',
      labels: 'ready,ui',
      maintainerCanModify: true
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.pullRequest.number, 42);
  assert.equal(result.url, 'https://github.com/owner/repo/pull/42');
  const createBody = JSON.parse(requests[0].body);
  assert.equal(createBody.draft, true);
  assert.equal(createBody.maintainer_can_modify, true);
  assert.equal(requests.some(item => item.url.includes('/requested_reviewers')), true);
  assert.equal(requests.some(item => item.url.includes('/assignees')), true);
  assert.equal(requests.some(item => item.url.includes('/labels')), true);
});

test('creates an Azure pull request with draft reviewers work items and labels', async () => {
  const requests = [];
  const service = new HostingService({
    vault: memoryVault({
      accessToken: 'token',
      user: { id: 'user-1', login: 'patricia@contoso.com' }
    }),
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || 'GET', body: options?.body });
      if (url.includes('vssps.dev.azure.com') && url.includes('/identities')) {
        return jsonResponse({
          value: [{
            id: 'reviewer-guid',
            providerDisplayName: 'alice@contoso.com',
            properties: { Account: { $value: 'alice@contoso.com' } }
          }]
        });
      }
      if (url.includes('/pullrequests') && options?.method === 'POST' && !url.includes('/labels')) {
        return jsonResponse({
          pullRequestId: 77,
          title: 'Azure feature',
          createdBy: { id: 'user-1', uniqueName: 'patricia@contoso.com' },
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          status: 'active',
          isDraft: true,
          reviewers: []
        });
      }
      return jsonResponse({});
    }
  });

  const result = await service.createPullRequest(
    {
      provider: 'azure',
      host: 'dev.azure.com',
      ownerPath: 'contoso/platform',
      repository: 'widgets',
      organization: 'contoso',
      project: 'platform'
    },
    {
      title: 'Azure feature',
      body: 'Ship it',
      source: 'feature',
      target: 'main',
      draft: true,
      reviewers: 'alice@contoso.com',
      labels: 'ready',
      workItems: '1001, 1002'
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.pullRequest.number, 77);
  assert.match(result.url, /pullrequest\/77$/);
  const createBody = JSON.parse(requests.find(item => (
    item.method === 'POST' && item.url.includes('/pullrequests') && !item.url.includes('/labels')
  )).body);
  assert.equal(createBody.isDraft, true);
  assert.equal(createBody.reviewers[0].id, 'reviewer-guid');
  assert.deepEqual(createBody.workItemRefs, [{ id: '1001' }, { id: '1002' }]);
  assert.equal(requests.some(item => item.url.includes('/labels')), true);
});

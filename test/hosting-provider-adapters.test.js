const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GitHubProviderAdapter,
  GitLabProviderAdapter,
  AzureProviderAdapter
} = require('../src/main/hosting/providers/index.mts');

const repositories = {
  github: { provider: 'github', ownerPath: 'owner', repository: 'repo' },
  gitlab: { provider: 'gitlab', ownerPath: 'group/subgroup', repository: 'repo' },
  azure: {
    provider: 'azure',
    organization: 'organization',
    project: 'project',
    repository: 'repo'
  }
};

function response(data, headers = {}) {
  return {
    data,
    headers: { get: name => headers[name.toLowerCase()] || '' }
  };
}

const cases = [
  {
    name: 'github',
    Adapter: GitHubProviderAdapter,
    payload: [{
      id: 10,
      number: 7,
      title: 'Graph work',
      user: { login: 'author' },
      head: { ref: 'feature/graph', sha: 'abc1234' },
      base: { ref: 'main' },
      state: 'open',
      requested_reviewers: [{ login: 'reviewer' }]
    }],
    headers: { link: '<next>; rel="next"' },
    hasMore: true
  },
  {
    name: 'gitlab',
    Adapter: GitLabProviderAdapter,
    payload: [{
      id: 10,
      iid: 7,
      title: 'Graph work',
      author: { username: 'author' },
      source_branch: 'feature/graph',
      target_branch: 'main',
      state: 'opened',
      reviewers: [{ username: 'reviewer' }]
    }],
    headers: { 'x-next-page': '2' },
    hasMore: true
  },
  {
    name: 'azure',
    Adapter: AzureProviderAdapter,
    payload: { value: [{
      pullRequestId: 7,
      title: 'Graph work',
      createdBy: { uniqueName: 'author' },
      sourceRefName: 'refs/heads/feature/graph',
      targetRefName: 'refs/heads/main',
      status: 'active',
      reviewers: [{ uniqueName: 'reviewer', vote: 0 }]
    }] },
    hasMore: false
  }
];

for (const providerCase of cases) {
  test(`${providerCase.name} adapter satisfies the pull-request list contract`, async () => {
    const calls = [];
    const adapter = new providerCase.Adapter({
      api: async (repository, endpoint) => {
        calls.push({ repository, endpoint });
        return response(providerCase.payload, providerCase.headers);
      },
      identityMatches: (left, right) => left?.login === right?.uniqueName
    });

    const result = await adapter.listPullRequests(repositories[providerCase.name], {
      page: 1,
      filter: 'review-requested',
      search: 'graph',
      account: { user: { login: 'reviewer' } }
    });

    assert.equal(result.page, 1);
    assert.equal(result.hasMore, providerCase.hasMore);
    assert.equal(result.items.length, 1);
    for (const key of [
      'author', 'ciStatus', 'draft', 'headSha', 'id', 'number', 'provider',
      'reviewStatus', 'source', 'state', 'target', 'title'
    ]) assert.ok(key in result.items[0]);
    assert.equal(result.items[0].provider, providerCase.name);
    assert.equal(result.items[0].number, 7);
    assert.equal(result.items[0].reviewStatus, 'requested');
    assert.equal(calls.length, 1);
  });
}

test('provider adapters reject malformed list responses', async () => {
  for (const providerCase of cases) {
    const adapter = new providerCase.Adapter({
      api: async () => response(providerCase.name === 'azure' ? {} : {}),
      identityMatches: () => false
    });
    await assert.rejects(
      adapter.listPullRequests(repositories[providerCase.name], {
        page: 1,
        filter: 'open',
        search: '',
        account: { user: null }
      }),
      /Failed to load pull requests/
    );
  }
});

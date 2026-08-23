const test = require('node:test');
const assert = require('node:assert/strict');
const { HostingService } = require('../src/main/hosting-service.mts');
const {
  GitHubProviderAdapter,
  GitLabProviderAdapter,
  AzureProviderAdapter
} = require('../src/main/hosting/providers/index.mts');

function response(data, headers = {}) {
  return {
    data,
    headers: { get: name => headers[name.toLowerCase()] || '' }
  };
}

function createDraft(overrides = {}) {
  return {
    headSha: 'a'.repeat(40),
    body: '',
    event: 'COMMENT',
    inlineComments: [],
    replies: [],
    completedOperations: [],
    ...overrides
  };
}

function createContext(overrides = {}) {
  const completed = [];
  return {
    completed,
    value: {
      viewer: { id: 'viewer-id', login: 'viewer@example.test', name: 'Viewer' },
      markCompleted: async operation => completed.push(operation),
      ...overrides
    }
  };
}

const repositories = {
  github: {
    provider: 'github', host: 'github.com', ownerPath: 'owner', repository: 'repo'
  },
  gitlab: {
    provider: 'gitlab', host: 'gitlab.com', ownerPath: 'group/subgroup', repository: 'repo'
  },
  azure: {
    provider: 'azure', host: 'dev.azure.com', ownerPath: 'organization/project',
    organization: 'organization', project: 'project', repository: 'repo'
  }
};

test('GitHub adapter resolves and unresolves review threads through GraphQL', async () => {
  const calls = [];
  const adapter = new GitHubProviderAdapter({
    api: async () => { throw new Error('REST should not be used'); },
    graphql: async (query, variables) => {
      calls.push({ query, variables });
      const mutation = query.includes('unresolveReviewThread')
        ? 'unresolveReviewThread'
        : 'resolveReviewThread';
      return {
        data: {
          [mutation]: {
            thread: { id: variables.threadId, isResolved: mutation === 'resolveReviewThread' }
          }
        }
      };
    }
  });

  assert.deepEqual(
    await adapter.resolveThread(repositories.github, 7, { id: 'thread_1' }, true),
    { success: true, resolved: true }
  );
  assert.deepEqual(
    await adapter.resolveThread(repositories.github, 7, { id: 'thread_1' }, false),
    { success: true, resolved: false }
  );
  assert.equal(calls[0].variables.threadId, 'thread_1');
  assert.match(calls[0].query, /resolveReviewThread/);
  assert.match(calls[1].query, /unresolveReviewThread/);
});

test('GitLab adapter resolves a concrete discussion note', async () => {
  const calls = [];
  const adapter = new GitLabProviderAdapter({
    api: async (...args) => {
      calls.push(args);
      return response({});
    }
  });

  const result = await adapter.resolveThread(
    repositories.gitlab,
    9,
    { id: 'discussion_1', noteId: 4 },
    false
  );

  assert.deepEqual(result, { success: true, resolved: false });
  assert.match(calls[0][1], /merge_requests\/9\/discussions\/discussion_1\/notes\/4$/);
  assert.deepEqual(calls[0][2], { method: 'PUT', body: { resolved: false } });
  await assert.rejects(
    adapter.resolveThread(
      repositories.gitlab,
      9,
      { id: 'discussion_1', noteId: 0 },
      true
    ),
    /Invalid GitLab discussion note/
  );
});

test('Azure adapter maps thread resolution to thread status', async () => {
  const calls = [];
  const adapter = new AzureProviderAdapter({
    identityMatches: () => false,
    api: async (...args) => {
      calls.push(args);
      return response({});
    }
  });

  const result = await adapter.resolveThread(
    repositories.azure,
    8,
    { id: '12' },
    true
  );

  assert.deepEqual(result, { success: true, resolved: true });
  assert.equal(calls[0][1], '/pullrequests/8/threads/12');
  assert.deepEqual(calls[0][2], { method: 'PATCH', body: { status: 'closed' } });
});

test('GitHub adapter submits one review and its explicit replies', async () => {
  const calls = [];
  const adapter = new GitHubProviderAdapter({
    graphql: async () => ({ data: {} }),
    api: async (...args) => {
      calls.push(args);
      if (args[1].endsWith('/reviews')) return response({ id: 123, state: 'APPROVED' });
      return response({ id: 124 });
    }
  });
  const { value: context } = createContext();
  const draft = createDraft({
    body: 'Looks good',
    event: 'APPROVE',
    inlineComments: [{
      path: 'src/app.js', line: 10, side: 'RIGHT', body: 'Clear implementation'
    }],
    replies: [{ commentId: 44, threadId: '', body: 'Resolved, thanks' }]
  });

  const result = await adapter.submitReview(repositories.github, 7, draft, context);

  assert.deepEqual(result, { success: true, review: { id: 123, state: 'APPROVED' } });
  assert.match(calls[0][1], /pulls\/7\/reviews$/);
  assert.deepEqual(calls[0][2].body, {
    commit_id: draft.headSha,
    body: 'Looks good',
    event: 'APPROVE',
    comments: draft.inlineComments
  });
  assert.match(calls[1][1], /comments\/44\/replies$/);
  assert.deepEqual(calls[1][2], { method: 'POST', body: { body: 'Resolved, thanks' } });
});

test('GitHub adapter rejects a reply without its numeric comment ID', async () => {
  const adapter = new GitHubProviderAdapter({
    graphql: async () => ({ data: {} }),
    api: async () => response({ id: 123, state: 'COMMENTED' })
  });
  const { value: context } = createContext();

  await assert.rejects(
    adapter.submitReview(repositories.github, 7, createDraft({
      replies: [{ threadId: 'thread_1', commentId: null, body: 'Reply' }]
    }), context),
    /GitHub reply is missing its comment ID/
  );
});

test('GitLab adapter creates a draft with resolved users and source removal', async () => {
  const calls = [];
  const adapter = new GitLabProviderAdapter({
    api: async (...args) => {
      calls.push(args);
      const endpoint = args[1];
      if (endpoint.includes('/users?username=alice')) return response([]);
      if (endpoint.includes('/users?search=alice')) {
        return response([{ id: 11, username: 'alice', name: 'Alice' }]);
      }
      if (endpoint.includes('/users?username=bob')) {
        return response([{ id: 12, username: 'bob', name: 'Bob' }]);
      }
      if (endpoint.endsWith('/merge_requests')) {
        return response({
          id: 80,
          iid: 8,
          title: 'Draft: Ship feature',
          web_url: 'https://gitlab.com/group/subgroup/repo/-/merge_requests/8',
          author: { username: 'viewer' },
          source_branch: 'feature',
          target_branch: 'main',
          state: 'opened',
          draft: true,
          reviewers: []
        });
      }
      throw new Error(`Unexpected GitLab endpoint: ${endpoint}`);
    }
  });
  const { value: context } = createContext({ viewer: { login: 'viewer' } });

  const result = await adapter.createPullRequest(repositories.gitlab, {
    title: 'Ship feature',
    body: 'Details',
    source: 'feature',
    target: 'main',
    draft: true,
    maintainerCanModify: true,
    reviewers: ['alice'],
    assignees: ['bob'],
    labels: ['ready', 'ui'],
    workItems: [],
    removeSourceBranch: true
  }, context);

  const createCall = calls.find(call => call[1].endsWith('/merge_requests'));
  assert.equal(result.pullRequest.provider, 'gitlab');
  assert.equal(result.pullRequest.number, 8);
  assert.equal(result.url, 'https://gitlab.com/group/subgroup/repo/-/merge_requests/8');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(createCall[2].body, {
    source_branch: 'feature',
    target_branch: 'main',
    title: 'Draft: Ship feature',
    description: 'Details',
    draft: true,
    labels: 'ready,ui',
    reviewer_ids: [11],
    assignee_ids: [12],
    remove_source_branch: true
  });
  assert.ok(calls.some(call => call[1].includes('/users?search=alice')));
});

test('Azure adapter records approve and request-changes votes without owning the journal', async () => {
  for (const [event, vote, operation] of [
    ['APPROVE', 10, 'approve'],
    ['REQUEST_CHANGES', -10, 'request-changes']
  ]) {
    const calls = [];
    const adapter = new AzureProviderAdapter({
      identityMatches: (left, right) => left?.id === right?.id,
      api: async (...args) => {
        calls.push(args);
        if (args[1].endsWith('/reviewers')) {
          return response({ value: [{ id: 'viewer-id', vote: 0 }] });
        }
        return response({});
      }
    });
    const { value: context, completed } = createContext();

    assert.deepEqual(
      await adapter.submitReview(
        repositories.azure,
        12,
        createDraft({ event }),
        context
      ),
      { success: true }
    );
    const voteCall = calls.find(call => call[2]?.method === 'PUT');
    assert.equal(voteCall[1], '/pullrequests/12/reviewers/viewer-id');
    assert.deepEqual(voteCall[2].body, { vote });
    assert.deepEqual(completed, [operation]);
  }
});

test('Azure adapter creates a draft with reviewers, work items and labels', async () => {
  const calls = [];
  const identityQueries = [];
  const adapter = new AzureProviderAdapter({
    identityMatches: (left, right) => (
      String(left?.login || '').toLowerCase() === String(right?.uniqueName || '').toLowerCase()
    ),
    identitySearch: async (organization, query) => {
      identityQueries.push([organization, query]);
      return [{ id: 'reviewer-guid', uniqueName: 'alice@example.test' }];
    },
    api: async (...args) => {
      calls.push(args);
      if (args[1] === '/pullrequests') {
        return response({
          pullRequestId: 77,
          title: 'Azure feature',
          createdBy: { id: 'viewer-id', uniqueName: 'viewer@example.test' },
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          status: 'active',
          isDraft: true,
          reviewers: []
        });
      }
      return response({});
    }
  });
  const { value: context } = createContext();

  const result = await adapter.createPullRequest(repositories.azure, {
    title: 'Azure feature',
    body: 'Ship it',
    source: 'feature',
    target: 'main',
    draft: true,
    maintainerCanModify: true,
    reviewers: ['alice@example.test'],
    assignees: [],
    labels: ['ready'],
    workItems: [1001, 1002],
    removeSourceBranch: false
  }, context);

  const createCall = calls.find(call => call[1] === '/pullrequests');
  assert.deepEqual(identityQueries, [['organization', 'alice@example.test']]);
  assert.deepEqual(createCall[2].body, {
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    title: 'Azure feature',
    description: 'Ship it\n\nAB#1001\nAB#1002',
    isDraft: true,
    reviewers: [{ id: 'reviewer-guid' }],
    workItemRefs: [{ id: '1001' }, { id: '1002' }]
  });
  assert.ok(calls.some(call => call[1] === '/pullrequests/77/labels'));
  assert.equal(result.pullRequest.provider, 'azure');
  assert.equal(result.pullRequest.number, 77);
  assert.match(result.url, /pullrequest\/77$/);
  assert.deepEqual(result.warnings, []);
});

test('Azure adapter keeps the description untouched without work items and dedupes existing mentions', async () => {
  const calls = [];
  const adapter = new AzureProviderAdapter({
    identityMatches: () => false,
    identitySearch: async () => [],
    api: async (...args) => {
      calls.push(args);
      return response({ pullRequestId: 78, reviewers: [] });
    }
  });
  const { value: context } = createContext();
  const options = {
    title: 'Azure feature',
    source: 'feature',
    target: 'main',
    draft: false,
    maintainerCanModify: true,
    reviewers: [],
    assignees: [],
    labels: [],
    removeSourceBranch: false
  };

  await adapter.createPullRequest(repositories.azure, {
    ...options,
    body: 'Plain body\n',
    workItems: []
  }, context);
  assert.equal(calls[0][2].body.description, 'Plain body');

  await adapter.createPullRequest(repositories.azure, {
    ...options,
    body: 'Mentions AB#1001 already\n',
    workItems: [1001, 1002]
  }, context);
  assert.equal(calls[1][2].body.description, 'Mentions AB#1001 already\n\nAB#1002');
  assert.deepEqual(calls[1][2].body.workItemRefs, [{ id: '1001' }, { id: '1002' }]);
});

function createServiceVault() {
  const removedDrafts = [];
  return {
    removedDrafts,
    getAccount: async () => ({
      accessToken: 'must-not-reach-adapter',
      user: { id: 'viewer-id', login: 'viewer@example.test' }
    }),
    getReviewDraft: async () => null,
    saveReviewDraft: async () => {},
    removeReviewDraft: async key => removedDrafts.push(key)
  };
}

test('HostingService validates mutations and delegates only normalized values', async () => {
  const calls = [];
  const vault = createServiceVault();
  const expected = {
    resolve: { success: true, resolved: true },
    review: { success: true },
    create: { success: true, pullRequest: { provider: 'github', number: 7 } }
  };
  const adapter = {
    resolveThread: async (...args) => {
      calls.push(['resolve', ...args]);
      return expected.resolve;
    },
    submitReview: async (...args) => {
      calls.push(['review', ...args]);
      return expected.review;
    },
    createPullRequest: async (...args) => {
      calls.push(['create', ...args]);
      return expected.create;
    }
  };
  const service = new HostingService({
    vault,
    providerAdapters: { github: adapter },
    fetch: async () => { throw new Error('HostingService bypassed its provider adapter'); }
  });
  const draft = createDraft({
    inlineComments: [{ path: 'src/app.js', line: 3, body: 'Review', side: 'RIGHT' }]
  });

  assert.equal(
    await service.resolveThread(repositories.github, '7', { id: 'thread_1' }, true),
    expected.resolve
  );
  assert.equal(await service.submitReview(repositories.github, '7', draft), expected.review);
  assert.equal(await service.createPullRequest(repositories.github, {
    title: '  Ship feature  ',
    source: 'refs/heads/feature',
    target: 'main',
    reviewers: 'alice, bob',
    labels: 'ready'
  }), expected.create);

  assert.equal(calls[0][0], 'resolve');
  assert.equal(calls[0][2], 7);
  assert.equal(calls[0][3].id, 'thread_1');
  assert.equal(calls[1][0], 'review');
  assert.equal(calls[1][2], 7);
  assert.deepEqual(calls[1][3].completedOperations, []);
  assert.equal(calls[1][4].viewer.login, 'viewer@example.test');
  assert.equal('accessToken' in calls[1][4], false);
  assert.equal(calls[2][0], 'create');
  assert.equal(calls[2][2].title, 'Ship feature');
  assert.equal(calls[2][2].source, 'feature');
  assert.deepEqual(calls[2][2].reviewers, ['alice', 'bob']);
  assert.equal(calls[2][3].viewer.login, 'viewer@example.test');
  assert.equal('accessToken' in calls[2][3], false);

  const callCount = calls.length;
  await assert.rejects(
    service.resolveThread(repositories.github, 7, { id: 'bad thread' }, true),
    /Invalid review thread ID/
  );
  await assert.rejects(
    service.submitReview(repositories.github, 7, createDraft({ headSha: 'bad' })),
    /Invalid review head SHA/
  );
  await assert.rejects(
    service.createPullRequest(repositories.github, {
      title: 'Invalid', source: 'main', target: 'main'
    }),
    /Source and target branches must differ/
  );
  assert.equal(calls.length, callCount);
  assert.deepEqual(vault.removedDrafts, ['github:owner/repo:7']);
});

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

function assertDetailContract(detail, provider) {
  for (const key of [
    'summary', 'permissions', 'reviewers', 'checks', 'files', 'threads',
    'headSha', 'mergeability'
  ]) assert.ok(key in detail, `${provider} detail is missing ${key}`);
  assert.equal(detail.summary.provider, provider);
  assert.equal(detail.summary.headSha, detail.headSha);
  assert.ok(Array.isArray(detail.reviewers));
  assert.ok(Array.isArray(detail.checks));
  assert.ok(Array.isArray(detail.files));
  assert.ok(Array.isArray(detail.threads));
  for (const file of detail.files) {
    for (const key of [
      'path', 'oldPath', 'status', 'additions', 'deletions', 'binary', 'patch'
    ]) assert.ok(key in file, `${provider} file is missing ${key}`);
  }
}

test('GitHub adapter owns normalized pull-request detail and paged diff', async () => {
  const headSha = 'a'.repeat(40);
  const adapter = new GitHubProviderAdapter({
    api: async (_repository, endpoint) => {
      if (endpoint.endsWith('/pulls/7')) {
        return response({
          id: 70,
          number: 7,
          title: 'GitHub detail',
          user: { login: 'author' },
          head: { ref: 'feature/github', sha: headSha },
          base: { ref: 'main' },
          state: 'open',
          requested_reviewers: [{ login: 'reviewer' }],
          mergeable_state: 'clean'
        });
      }
      if (endpoint.includes('/reviews?')) {
        return response([
          { user: { login: 'reviewer' }, state: 'COMMENTED', submitted_at: 'first' },
          { user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: 'latest' }
        ]);
      }
      if (endpoint.includes('/check-runs?')) {
        return response({
          check_runs: [{
            id: 1,
            name: 'CI',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://example.test/check/1'
          }]
        });
      }
      if (endpoint.includes('/files?')) {
        return response([{
          filename: 'src/app.js',
          previous_filename: 'src/old-app.js',
          status: 'renamed',
          additions: 4,
          deletions: 2,
          patch: '@@ change'
        }], { link: '<next>; rel="next"' });
      }
      throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
    },
    graphql: async () => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [{
                    databaseId: 9,
                    body: 'Please adjust this',
                    path: 'src/app.js',
                    line: 12,
                    diffSide: 'RIGHT',
                    createdAt: 'now',
                    author: { login: 'reviewer' }
                  }]
                }
              }]
            }
          }
        }
      }
    })
  });
  const repository = { provider: 'github', ownerPath: 'owner', repository: 'repo' };

  const detail = await adapter.pullRequestDetail(repository, 7, {
    viewer: { login: 'reviewer' }
  });
  const diff = await adapter.pullRequestDiff(repository, 7, 2);

  assertDetailContract(detail, 'github');
  assert.equal(detail.reviewers.length, 1);
  assert.equal(detail.reviewers[0].state, 'APPROVED');
  assert.equal(detail.checks[0].conclusion, 'success');
  assert.equal(detail.files[0].oldPath, 'src/old-app.js');
  assert.equal(detail.threads[0].commentId, 9);
  assert.equal(detail.mergeability, 'clean');
  assert.equal(diff.page, 2);
  assert.equal(diff.hasMore, true);
  assert.equal(diff.files[0].path, 'src/app.js');
});

test('GitLab adapter owns normalized pull-request detail and diff', async () => {
  const headSha = 'b'.repeat(40);
  const adapter = new GitLabProviderAdapter({
    api: async (_repository, endpoint) => {
      if (endpoint.endsWith('/merge_requests/8')) {
        return response({
          id: 80,
          iid: 8,
          title: 'GitLab detail',
          author: { username: 'author' },
          source_branch: 'feature/gitlab',
          target_branch: 'main',
          state: 'opened',
          reviewers: [{ username: 'reviewer' }],
          diff_refs: { head_sha: headSha },
          detailed_merge_status: 'mergeable'
        });
      }
      if (endpoint.endsWith('/approvals')) {
        return response({ approved_by: [{ user: { username: 'approver' } }] });
      }
      if (endpoint.includes('/pipelines?')) {
        return response([{
          id: 22,
          status: 'success',
          web_url: 'https://example.test/pipeline/22'
        }]);
      }
      if (endpoint.endsWith('/changes')) {
        return response({
          changes: [{
            new_path: 'src/new.js',
            old_path: 'src/old.js',
            renamed_file: true,
            diff: '@@ change'
          }]
        });
      }
      if (endpoint.includes('/discussions?')) {
        return response([{
          id: 'discussion-1',
          notes: [{
            id: 4,
            author: { username: 'reviewer' },
            body: 'Discussion note',
            resolvable: true,
            resolved: false,
            created_at: 'now'
          }]
        }]);
      }
      throw new Error(`Unexpected GitLab endpoint: ${endpoint}`);
    }
  });
  const repository = {
    provider: 'gitlab', ownerPath: 'group/subgroup', repository: 'repo'
  };

  const detail = await adapter.pullRequestDetail(repository, 8, {
    viewer: { login: 'reviewer' }
  });
  const diff = await adapter.pullRequestDiff(repository, 8, 9);

  assertDetailContract(detail, 'gitlab');
  assert.equal(detail.permissions.requestChanges, false);
  assert.deepEqual(detail.reviewers.map(item => item.login), ['reviewer', 'approver']);
  assert.equal(detail.checks[0].name, 'Pipeline #22');
  assert.equal(detail.files[0].status, 'renamed');
  assert.equal(detail.threads[0].resolved, false);
  assert.equal(diff.page, 1);
  assert.equal(diff.hasMore, false);
  assert.equal(diff.files[0].oldPath, 'src/old.js');
});

test('Azure adapter owns normalized pull-request detail and iteration diff', async () => {
  const headSha = 'c'.repeat(40);
  const adapter = new AzureProviderAdapter({
    identityMatches: (left, right) => left?.id === right?.id,
    api: async (_repository, endpoint) => {
      if (endpoint === '/pullrequests/9') {
        return response({
          pullRequestId: 9,
          title: 'Azure detail',
          createdBy: { id: 'author', uniqueName: 'author@example.test' },
          sourceRefName: 'refs/heads/feature/azure',
          targetRefName: 'refs/heads/main',
          status: 'active',
          mergeStatus: 'succeeded',
          reviewers: [{ id: 'reviewer', uniqueName: 'reviewer@example.test', vote: 10 }]
        });
      }
      if (endpoint.endsWith('/threads')) {
        return response({
          value: [{
            id: 12,
            status: 'active',
            threadContext: {
              filePath: '/src/azure.js',
              rightFileEnd: { line: 17 }
            },
            comments: [{
              id: 13,
              author: { uniqueName: 'reviewer@example.test' },
              content: 'Azure note',
              publishedDate: 'now'
            }]
          }]
        });
      }
      if (endpoint.endsWith('/iterations')) {
        return response({ value: [{ id: 3, sourceRefCommit: { commitId: headSha } }] });
      }
      if (endpoint.includes('/iterations/3/changes?')) {
        return response({
          changeEntries: [{
            changeType: 'rename',
            originalPath: '/src/old-azure.js',
            item: { path: '/src/azure.js' }
          }]
        });
      }
      throw new Error(`Unexpected Azure endpoint: ${endpoint}`);
    }
  });
  const repository = {
    provider: 'azure', organization: 'organization', project: 'project', repository: 'repo'
  };

  const detail = await adapter.pullRequestDetail(repository, 9, {
    viewer: { id: 'reviewer' }
  });
  const diff = await adapter.pullRequestDiff(repository, 9, 4);

  assertDetailContract(detail, 'azure');
  assert.equal(detail.permissions.checkout, false);
  assert.equal(detail.reviewers[0].state, 'APPROVED');
  assert.equal(detail.files[0].status, 'renamed');
  assert.equal(detail.threads[0].line, 17);
  assert.equal(detail.headSha, headSha);
  assert.equal(diff.page, 1);
  assert.equal(diff.hasMore, false);
  assert.equal(diff.files[0].path, 'src/azure.js');
});

test('provider read fallbacks stay local to the adapter that defines them', async () => {
  const headSha = 'd'.repeat(40);
  const github = new GitHubProviderAdapter({
    graphql: async () => { throw new Error('GraphQL unavailable'); },
    api: async (_repository, endpoint) => {
      if (endpoint.endsWith('/pulls/5')) {
        return response({
          id: 5,
          number: 5,
          title: 'Fallbacks',
          user: { login: 'author' },
          head: { ref: 'feature', sha: headSha },
          base: { ref: 'main' },
          state: 'open'
        });
      }
      if (endpoint.includes('/reviews?')) return response([]);
      if (endpoint.includes('/check-runs?')) throw new Error('Checks unavailable');
      if (endpoint.includes('/files?')) return response([]);
      throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
    }
  });
  const githubDetail = await github.pullRequestDetail(
    { provider: 'github', ownerPath: 'owner', repository: 'repo' },
    5,
    { viewer: null }
  );
  assert.deepEqual(githubDetail.checks, []);
  assert.deepEqual(githubDetail.threads, []);

  const azure = new AzureProviderAdapter({
    identityMatches: () => false,
    api: async () => { throw new Error('Iterations unavailable'); }
  });
  assert.deepEqual(await azure.pullRequestDiff(
    { provider: 'azure', organization: 'org', project: 'project', repository: 'repo' },
    6,
    1
  ), { files: [], page: 1, hasMore: false });
});

test('GitHub detail rejects a response without a head SHA', async () => {
  const adapter = new GitHubProviderAdapter({
    api: async () => response({ head: {} }),
    graphql: async () => ({ data: null })
  });
  await assert.rejects(adapter.pullRequestDetail(
    { provider: 'github', ownerPath: 'owner', repository: 'repo' },
    7,
    { viewer: null }
  ), /Pull request head SHA is unavailable/);
});

test('HostingService validates read arguments and delegates through the provider seam', async () => {
  const calls = [];
  const expectedDetail = { summary: { provider: 'github' } };
  const expectedDiff = { files: [], page: 3, hasMore: false };
  const account = { accessToken: 'secret', user: { login: 'reviewer' } };
  const adapter = {
    async pullRequestDetail(...args) {
      calls.push(['detail', ...args]);
      return expectedDetail;
    },
    async pullRequestDiff(...args) {
      calls.push(['diff', ...args]);
      return expectedDiff;
    }
  };
  const service = new HostingService({
    vault: { getAccount: async () => account },
    providerAdapters: { github: adapter }
  });
  const repository = {
    provider: 'github', host: 'github.com', ownerPath: 'owner', repository: 'repo'
  };

  assert.equal(await service.pullRequestDetail(repository, '7'), expectedDetail);
  assert.equal(await service.pullRequestDiff(repository, 7, 3), expectedDiff);
  assert.equal(calls[0][0], 'detail');
  assert.equal(calls[0][2], 7);
  assert.equal(calls[0][3].viewer, account.user);
  assert.equal(calls[1][0], 'diff');
  assert.equal(calls[1][2], 7);
  assert.equal(calls[1][3], 3);

  await service.pullRequestDiff(repository, 7, Number.POSITIVE_INFINITY);
  assert.equal(calls[2][3], 10000);

  await assert.rejects(service.pullRequestDetail(repository, 'bad'), /Invalid pull request ID/);
  await assert.rejects(service.pullRequestDiff(repository, 0), /Invalid pull request ID/);
});

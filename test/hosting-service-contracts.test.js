const test = require('node:test');
const assert = require('node:assert/strict');

const { HostingService } = require('../src/main/hosting-service.mts');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function createVault(initialAccount = null) {
  let account = initialAccount;
  const calls = [];
  return {
    calls,
    getSecurityState: () => ({ memoryOnly: false, warning: 'local warning' }),
    getAccount: async provider => {
      calls.push(['getAccount', provider]);
      return account;
    },
    setAccount: async (provider, value) => {
      calls.push(['setAccount', provider, value]);
      account = value;
    },
    removeAccount: async provider => calls.push(['removeAccount', provider]),
    removeProviderDrafts: async provider => calls.push(['removeProviderDrafts', provider]),
    getReviewDraft: async () => null,
    saveReviewDraft: async () => {},
    removeReviewDraft: async () => {}
  };
}

const repositories = {
  github: { provider: 'github', host: 'github.com', ownerPath: 'owner', repository: 'repo' },
  gitlab: {
    provider: 'gitlab', host: 'gitlab.com', ownerPath: 'group/subgroup', repository: 'repo'
  },
  azure: {
    provider: 'azure', host: 'dev.azure.com', ownerPath: 'organization/project',
    repository: 'repo'
  }
};

test('hosting repository and pull request validators reject untrusted identifiers', () => {
  const service = new HostingService({ vault: createVault() });

  assert.deepEqual(service.validateRepository(repositories.github), repositories.github);
  assert.deepEqual(service.validateRepository(repositories.gitlab), repositories.gitlab);
  assert.deepEqual(service.validateRepository(repositories.azure), {
    ...repositories.azure,
    organization: 'organization',
    project: 'project'
  });
  assert.equal(service.validatePullRequestId('42'), 42);
  assert.equal(service.repositoryKey(repositories.github), 'github:owner/repo');
  assert.equal(service.draftKey(repositories.github, 7), 'github:owner/repo:7');

  assert.throws(() => service.validateProvider('bitbucket'), /Unsupported hosting provider/);
  assert.throws(() => service.validateRepository({}), /Unsupported hosting provider/);
  assert.throws(() => service.validateRepository({
    ...repositories.github, host: 'evil.example'
  }), /available only for github\.com/);
  assert.throws(() => service.validateRepository({
    ...repositories.github, ownerPath: 'owner//nested'
  }), /Invalid hosting repository/);
  assert.throws(() => service.validateRepository({
    ...repositories.github, repository: '--bad name'
  }), /Invalid hosting repository/);
  assert.throws(() => service.validateRepository({
    ...repositories.github, ownerPath: 'a'.repeat(501)
  }), /Invalid hosting repository/);
  for (const value of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, 'nope']) {
    assert.throws(() => service.validatePullRequestId(value), /Invalid pull request ID/);
  }
  const noAdapters = new HostingService({ vault: createVault(), providerAdapters: {} });
  assert.throws(() => noAdapters.providerAdapter('github'), /Unsupported hosting provider/);
});

test('provider status reports configuration, sessions and vault security', async () => {
  const vault = createVault({ accessToken: 'token', user: { login: 'octocat' } });
  const service = new HostingService({ vault, oauthConfig: { github: 'client-id' } });
  service.loginSessions.set('github', { controller: new AbortController() });

  assert.deepEqual(await service.providerStatus('github'), {
    provider: 'github',
    configured: true,
    connected: true,
    user: { login: 'octocat' },
    phase: 'authorizing',
    warning: 'local warning'
  });
  assert.equal((await service.providerStatus('azure')).configured, true);
});

test('PAT, cancellation and logout validate input and clear provider state', async () => {
  const vault = createVault();
  const authEvents = [];
  const service = new HostingService({ vault, onAuthState: event => authEvents.push(event) });
  service.fetchCurrentUser = async () => ({ login: 'alice' });

  for (const token of [null, 'short', 'x'.repeat(201)]) {
    await assert.rejects(service.setPat('github', token), /Invalid Personal Access Token/);
  }
  assert.equal((await service.setPat('github', 'x'.repeat(20))).success, true);
  assert.equal(authEvents[0].phase, 'connected');

  const controller = new AbortController();
  service.loginSessions.set('github', { controller });
  assert.deepEqual(await service.cancelLogin('github'), { success: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(service.loginSessions.has('github'), false);
  const pendingController = new AbortController();
  service.loginSessions.set('gitlab', { controller: pendingController });
  service.destroy();
  assert.equal(pendingController.signal.aborted, true);
  assert.equal(service.loginSessions.size, 0);
  assert.deepEqual(await service.logout('github'), { success: true, provider: 'github' });
  assert.ok(vault.calls.some(call => call[0] === 'removeAccount'));
  assert.ok(vault.calls.some(call => call[0] === 'removeProviderDrafts'));
});

test('device login validates provider configuration and verification URLs', async () => {
  const opened = [];
  const service = new HostingService({
    vault: createVault(),
    oauthConfig: { github: 'github-client' },
    openExternal: async url => opened.push(url)
  });
  service.requestForm = async () => ({
    device_code: 'device',
    user_code: 'ABCD',
    verification_uri_complete: 'https://github.com/login/device?user_code=ABCD',
    expires_in: 120,
    interval: 1
  });
  let polled;
  service.pollDeviceToken = async (...args) => { polled = args; };

  await assert.rejects(service.login('azure'), /Personal Access Token/);
  await assert.rejects(service.login('gitlab'), /OAuth is not configured/);
  const result = await service.login('github');
  assert.equal(result.interval, 5);
  assert.equal(result.expiresIn, 120);
  assert.deepEqual(opened, ['https://github.com/login/device?user_code=ABCD']);
  assert.equal(polled[0], 'github');

  service.requestForm = async () => ({
    device_code: 'device', user_code: 'ABCD', verification_uri: 'http://evil.example/device'
  });
  await assert.rejects(service.login('github'), /unsafe verification URL/);
});

test('device token polling handles pending, slowdown and successful authorization', async () => {
  const vault = createVault();
  const events = [];
  const service = new HostingService({
    vault,
    oauthConfig: { github: 'client-id' },
    sleep: async () => {},
    onAuthState: event => events.push(event)
  });
  const responses = [
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { access_token: 'new-token', refresh_token: 'refresh', expires_in: 3600 }
  ];
  service.requestForm = async () => responses.shift();
  service.fetchCurrentUser = async () => ({ login: 'octocat' });
  const session = {
    controller: new AbortController(),
    deviceCode: 'device',
    expiresAt: Date.now() + 10000,
    interval: 5
  };
  service.loginSessions.set('github', session);

  await service.pollDeviceToken('github', 'client-id', session);
  assert.equal(session.interval, 10);
  assert.equal(service.loginSessions.has('github'), false);
  assert.equal(vault.calls.find(call => call[0] === 'setAccount')[2].accessToken, 'new-token');
  assert.equal(events.at(-1).phase, 'connected');
});

test('device token polling reports provider errors, missing tokens and expiry', async () => {
  const service = new HostingService({ vault: createVault(), sleep: async () => {} });
  const session = () => ({
    controller: new AbortController(), deviceCode: 'device',
    expiresAt: Date.now() + 10000, interval: 5
  });
  service.requestForm = async () => ({ error: 'denied', error_description: 'Access denied' });
  await assert.rejects(service.pollDeviceToken('gitlab', 'client', session()), /Access denied/);
  service.requestForm = async () => ({});
  await assert.rejects(service.pollDeviceToken('github', 'client', session()), /access token/);
  await assert.rejects(service.pollDeviceToken('github', 'client', {
    ...session(), expiresAt: Date.now() - 1
  }), /authorization expired/);
  const aborted = session();
  aborted.controller.abort();
  await service.pollDeviceToken('github', 'client', aborted);
});

test('response parsing enforces size, JSON errors and rate-limit messages', async () => {
  const service = new HostingService({ vault: createVault() });
  const oversized = {
    headers: { get: name => name === 'content-length' ? String(21 * 1024 * 1024) : '' },
    text: async () => { throw new Error('must not read'); },
    ok: true
  };
  await assert.rejects(service.readResponse(oversized), /too large/);
  assert.deepEqual(await service.readResponse(new Response('', { status: 200 })), {});
  assert.deepEqual(await service.readResponse(new Response('plain text', { status: 200 })), {
    message: 'plain text'
  });
  await assert.rejects(service.readResponse(jsonResponse(
    { message: 'Slow down' }, 429, { 'x-ratelimit-remaining': '0' }
  )), /Slow down Provider rate limit reached/);
  await assert.rejects(service.readResponse(jsonResponse(
    { error_description: 'Expired token' }, 401
  )), /Expired token/);
});

test('provider requests reject non-HTTPS responses and form encode values', async () => {
  const requests = [];
  const service = new HostingService({
    vault: createVault(),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('unsafe')) return { url: 'http://unsafe.test', ok: true };
      return jsonResponse({ ok: true });
    }
  });
  await assert.rejects(service.fetchWithTimeout('https://unsafe.test'), /not delivered over HTTPS/);
  assert.deepEqual(await service.requestForm('https://safe.test/token', {
    client_id: 'abc', scope: 'api read'
  }), { ok: true });
  assert.equal(requests.at(-1).options.method, 'POST');
  assert.equal(requests.at(-1).options.body, 'client_id=abc&scope=api+read');
});

test('Azure URL and identity helpers normalize expected provider values', () => {
  const service = new HostingService({ vault: createVault() });
  assert.equal(service.withAzureApiVersion('/pullrequests'), '/pullrequests?api-version=7.1-preview');
  assert.equal(
    service.withAzureApiVersion('/pullrequests?search=active'),
    '/pullrequests?search=active&api-version=7.1-preview'
  );
  assert.equal(service.withAzureApiVersion('/x?api-version=7.0'), '/x?api-version=7.0');
  assert.equal(service.azureIdentityMatches(null, {}), false);
  assert.equal(service.azureIdentityMatches({ login: 'ALICE' }, { uniqueName: 'alice' }), true);
  assert.equal(service.azureIdentityMatches({ id: 'one' }, { id: 'two' }), false);
});

test('current-user normalization supports GitHub, GitLab and both Azure identity shapes', async () => {
  const service = new HostingService({
    vault: createVault(),
    fetch: async url => {
      if (url.includes('api.github.com')) {
        return jsonResponse({ id: 1, login: 'octocat', name: 'Octo', avatar_url: 'gh.png' });
      }
      if (url.includes('gitlab.com')) {
        return jsonResponse({ id: 2, username: 'fox', name: 'Fox', avatar_url: 'gl.png' });
      }
      if (url.includes('connectionData')) {
        return jsonResponse({
          authenticatedUser: { id: '3', providerDisplayName: 'azure@example.test' }
        });
      }
      return jsonResponse({ id: '4', emailAddress: 'profile@example.test', displayName: 'Profile' });
    }
  });

  assert.equal((await service.fetchCurrentUser('github', 'token')).login, 'octocat');
  assert.equal((await service.fetchCurrentUser('gitlab', 'token')).login, 'fox');
  assert.equal((await service.fetchCurrentUser('azure', 'token', 'organization')).id, '3');
  assert.equal((await service.fetchCurrentUser('azure', 'token')).login, 'profile@example.test');
});

test('API requests construct provider URLs, authentication and JSON bodies', async () => {
  const requests = [];
  const vault = createVault({ accessToken: 'secret' });
  const service = new HostingService({
    vault,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ value: 1 }, 200, { 'x-next-page': '2' });
    }
  });

  const github = await service.api(repositories.github, '/repos/owner/repo/pulls', {
    method: 'POST', body: { title: 'PR' }
  });
  assert.equal(github.data.value, 1);
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/pulls');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.equal(requests[0].options.body, JSON.stringify({ title: 'PR' }));

  await service.api(repositories.gitlab, '/projects/group%2Frepo/merge_requests');
  assert.match(requests[1].url, /^https:\/\/gitlab\.com\/api\/v4/);
  await service.api(repositories.azure, '/pullrequests?search=active');
  assert.match(requests[2].url, /organization\/project\/_apis\/git\/repositories\/repo\/pullrequests/);
  assert.match(requests[2].url, /api-version=7\.1-preview/);
  assert.match(requests[2].options.headers.Authorization, /^Basic /);

  const disconnected = new HostingService({ vault: createVault(null) });
  await assert.rejects(disconnected.api(repositories.github, '/x'), /Connect github first/);
});

test('expired OAuth accounts refresh once and preserve refresh-token fallbacks', async () => {
  const vault = createVault({
    accessToken: 'old', refreshToken: 'refresh-old', expiresAt: Date.now() - 1000,
    user: { login: 'me' }
  });
  const service = new HostingService({ vault, oauthConfig: { github: 'client-id' } });
  service.requestForm = async (url, values) => {
    assert.match(url, /github\.com\/login\/oauth\/access_token/);
    assert.equal(values.refresh_token, 'refresh-old');
    return { access_token: 'new', expires_in: 3600 };
  };
  const refreshed = await service.getAccessAccount('github');
  assert.equal(refreshed.accessToken, 'new');
  assert.equal(refreshed.refreshToken, 'refresh-old');
  assert.ok(refreshed.expiresAt > Date.now());

  const missingConfig = new HostingService({ vault: createVault({
    accessToken: 'old', refreshToken: 'refresh', expiresAt: 1
  }) });
  await assert.rejects(missingConfig.getAccessAccount('gitlab'), /OAuth is not configured/);
  missingConfig.oauthConfig.gitlab = 'client-id';
  missingConfig.requestForm = async () => ({});
  await assert.rejects(missingConfig.getAccessAccount('gitlab'), /token refresh failed/);

  assert.equal(await new HostingService({ vault: createVault(null) }).getAccessAccount('github'), null);
  const azureAccount = { accessToken: 'pat', expiresAt: 1 };
  assert.equal(
    await new HostingService({ vault: createVault(azureAccount) }).getAccessAccount('azure'),
    azureAccount
  );
});

test('review thread resolution uses each provider contract and validates identifiers', async () => {
  const service = new HostingService({ vault: createVault({ accessToken: 'token' }) });
  assert.equal(service.validateThreadId('thread_1:/+='), 'thread_1:/+=');
  for (const value of ['', 'bad thread', 'x'.repeat(201)]) {
    assert.throws(() => service.validateThreadId(value), /Invalid review thread ID/);
  }

  const calls = [];
  service.githubGraphql = async (query, variables) => {
    calls.push(['github', query, variables]);
    return { data: { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } } };
  };
  assert.deepEqual(await service.resolveThread(repositories.github, 7, { id: 'github-thread' }, true), {
    success: true, resolved: true
  });
  service.githubGraphql = async () => ({
    data: { unresolveReviewThread: { thread: { id: 'github-thread', isResolved: false } } }
  });
  assert.equal((await service.resolveThread(
    repositories.github, 7, { id: 'github-thread' }, false
  )).resolved, false);

  service.api = async (...args) => { calls.push(['api', ...args]); return { data: {} }; };
  assert.equal((await service.resolveThread(
    repositories.azure, 8, { id: '12' }, true
  )).resolved, true);
  assert.equal((await service.resolveThread(
    repositories.gitlab, 9, { id: 'discussion', noteId: 4 }, false
  )).resolved, false);
  await assert.rejects(service.resolveThread(
    repositories.gitlab, 9, { id: 'discussion', noteId: 0 }, true
  ), /Invalid GitLab discussion note/);
  assert.ok(calls.some(call => JSON.stringify(call).includes('threads/12')));
  assert.ok(calls.some(call => JSON.stringify(call).includes('discussions/discussion/notes/4')));
});

test('GitHub GraphQL and review drafts normalize success and validation failures', async () => {
  const vault = createVault({ accessToken: 'token' });
  const service = new HostingService({
    vault,
    fetch: async () => jsonResponse({ data: { viewer: { login: 'me' } } })
  });
  assert.equal((await service.githubGraphql('query { viewer { login } }', {})).data.viewer.login, 'me');
  service.fetch = async () => jsonResponse({ errors: [{ message: 'GraphQL failed' }] });
  await assert.rejects(service.githubGraphql('query { viewer { login } }', {}), /GraphQL failed/);
  await assert.rejects(
    new HostingService({ vault: createVault(null) }).githubGraphql('query { viewer { login } }', {}),
    /Connect github first/
  );

  const valid = service.validateReviewDraft({
    headSha: 'a'.repeat(40),
    body: 'Review body',
    event: 'COMMENT',
    inlineComments: [{ path: 'src/app.js', line: 4, side: 'LEFT', body: 'Change this' }],
    replies: [{ commentId: 9, body: 'Done' }]
  });
  assert.equal(valid.inlineComments[0].side, 'LEFT');
  assert.equal(valid.replies[0].commentId, 9);
  assert.deepEqual(valid.completedOperations, []);

  for (const [draft, pattern] of [
    [null, /Invalid review draft/],
    [{ headSha: 'bad', event: 'COMMENT' }, /Invalid review head SHA/],
    [{ headSha: 'a'.repeat(40), event: 'MERGE' }, /Invalid review event/],
    [{ headSha: 'a'.repeat(40), event: 'COMMENT', body: '\0' }, /Review body is too long/],
    [{
      headSha: 'a'.repeat(40), event: 'COMMENT',
      inlineComments: [{ path: '../secret', line: 1, body: 'x' }]
    }, /Invalid review comment path/],
    [{
      headSha: 'a'.repeat(40), event: 'COMMENT',
      inlineComments: [{ path: 'file.js', line: 0, body: 'x' }]
    }, /Invalid review line/],
    [{
      headSha: 'a'.repeat(40), event: 'COMMENT',
      inlineComments: [{ path: 'file.js', line: 1, body: ' ' }]
    }, /Invalid review comment/],
    [{
      headSha: 'a'.repeat(40), event: 'COMMENT', replies: [{ body: 'missing target' }]
    }, /Invalid review reply/]
  ]) assert.throws(() => service.validateReviewDraft(draft), pattern);
});

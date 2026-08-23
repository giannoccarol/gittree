const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRemoteUrl,
  buildPullRequestUrl
} = require('../src/main/provider-links.mts');

test('GitHub HTTPS and SSH remotes open a prefilled compare page', () => {
  const httpsRemote = parseRemoteUrl('https://github.com/acme/widgets.git');
  const sshRemote = parseRemoteUrl('git@github.com:acme/widgets.git');

  assert.deepEqual(httpsRemote, {
    provider: 'github',
    host: 'github.com',
    ownerPath: 'acme',
    repository: 'widgets',
    webBase: 'https://github.com/acme/widgets'
  });
  assert.deepEqual(sshRemote, httpsRemote);
  assert.equal(
    buildPullRequestUrl(httpsRemote, 'feature/payments', 'main'),
    'https://github.com/acme/widgets/compare/main...feature%2Fpayments?expand=1'
  );
});

test('GitLab nested groups open a prefilled merge request page', () => {
  const remote = parseRemoteUrl('git@gitlab.com:platform/apps/widgets.git');

  assert.equal(remote.provider, 'gitlab');
  assert.equal(remote.ownerPath, 'platform/apps');
  assert.equal(
    buildPullRequestUrl(remote, 'feature/payments', 'develop'),
    'https://gitlab.com/platform/apps/widgets/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fpayments&merge_request%5Btarget_branch%5D=develop'
  );
});

test('Bitbucket remotes open a prefilled pull request page', () => {
  const remote = parseRemoteUrl('ssh://git@bitbucket.org/acme/widgets.git');

  assert.equal(remote.provider, 'bitbucket');
  assert.equal(
    buildPullRequestUrl(remote, 'feature/payments', 'main'),
    'https://bitbucket.org/acme/widgets/pull-requests/new?source=feature%2Fpayments&dest=main'
  );
});

test('Azure DevOps HTTPS and SSH remotes open a prefilled pull request page', () => {
  const httpsRemote = parseRemoteUrl(
    'https://contoso@dev.azure.com/contoso/platform/_git/widgets'
  );
  const sshRemote = parseRemoteUrl(
    'git@ssh.dev.azure.com:v3/contoso/platform/widgets'
  );

  assert.equal(httpsRemote.provider, 'azure');
  assert.equal(httpsRemote.organization, 'contoso');
  assert.equal(httpsRemote.project, 'platform');
  assert.equal(httpsRemote.repository, 'widgets');
  assert.deepEqual(sshRemote, {
    ...httpsRemote,
    host: 'ssh.dev.azure.com'
  });
  assert.equal(
    buildPullRequestUrl(httpsRemote, 'feature/payments', 'main'),
    'https://dev.azure.com/contoso/platform/_git/widgets/pullrequestcreate?sourceRef=feature%2Fpayments&targetRef=main'
  );
});

test('legacy Azure DevOps remotes are normalized to dev.azure.com', () => {
  const remote = parseRemoteUrl(
    'https://contoso.visualstudio.com/platform/_git/widgets'
  );

  assert.equal(remote.provider, 'azure');
  assert.equal(
    remote.webBase,
    'https://dev.azure.com/contoso/platform/_git/widgets'
  );
});

test('unknown providers do not produce an external URL', () => {
  const remote = parseRemoteUrl('ssh://git@git.example.test/acme/widgets.git');
  assert.equal(remote.provider, null);
  assert.equal(buildPullRequestUrl(remote, 'feature/payments', 'main'), null);
});

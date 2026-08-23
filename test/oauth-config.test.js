const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadOAuthConfig, validClientId } = require('../src/main/oauth-config.mts');

test('OAuth client IDs accept only public identifier syntax', () => {
  assert.equal(validClientId('client_123.example'), 'client_123.example');
  assert.equal(validClientId('short'), '');
  assert.equal(validClientId('client secret'), '');
  assert.equal(validClientId(null), '');
});

test('packaged OAuth config loads from resources and environment takes precedence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-oauth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'oauth-config.json'), JSON.stringify({
    githubClientId: 'packaged-github',
    gitlabClientId: 'packaged-gitlab'
  }));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: directory });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor);
    else delete process.resourcesPath;
  });
  const previousGithub = process.env.GITTREE_GITHUB_CLIENT_ID;
  const previousGitlab = process.env.GITTREE_GITLAB_CLIENT_ID;
  process.env.GITTREE_GITHUB_CLIENT_ID = 'environment-github';
  delete process.env.GITTREE_GITLAB_CLIENT_ID;
  t.after(() => {
    if (previousGithub === undefined) delete process.env.GITTREE_GITHUB_CLIENT_ID;
    else process.env.GITTREE_GITHUB_CLIENT_ID = previousGithub;
    if (previousGitlab === undefined) delete process.env.GITTREE_GITLAB_CLIENT_ID;
    else process.env.GITTREE_GITLAB_CLIENT_ID = previousGitlab;
  });

  assert.deepEqual(loadOAuthConfig({ isPackaged: true }), {
    github: 'environment-github',
    gitlab: 'packaged-gitlab'
  });
});

test('missing or malformed packaged OAuth config is treated as empty', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-oauth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'oauth-config.json'), '{broken');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: directory });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor);
    else delete process.resourcesPath;
  });
  const previousGithub = process.env.GITTREE_GITHUB_CLIENT_ID;
  const previousGitlab = process.env.GITTREE_GITLAB_CLIENT_ID;
  delete process.env.GITTREE_GITHUB_CLIENT_ID;
  delete process.env.GITTREE_GITLAB_CLIENT_ID;
  t.after(() => {
    if (previousGithub !== undefined) process.env.GITTREE_GITHUB_CLIENT_ID = previousGithub;
    if (previousGitlab !== undefined) process.env.GITTREE_GITLAB_CLIENT_ID = previousGitlab;
  });

  assert.deepEqual(loadOAuthConfig({ isPackaged: true }), { github: '', gitlab: '' });
  assert.deepEqual(loadOAuthConfig({ isPackaged: false }), { github: '', gitlab: '' });
});

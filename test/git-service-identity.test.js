const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

const CONFIG_VARIABLES = [
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_PARAMETERS'
];

/**
 * Gives GitService (which inherits process.env) a private global config file
 * so the developer's identity never leaks into the assertions.
 */
function isolate(t, globalConfig = '', extraEnvironment = {}) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const globalPath = path.join(repo.root, 'global.gitconfig');
  fs.writeFileSync(globalPath, globalConfig);
  const previous = Object.fromEntries(CONFIG_VARIABLES.map(key => [key, process.env[key]]));
  for (const key of CONFIG_VARIABLES) delete process.env[key];
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: globalPath,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extraEnvironment
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // The fixture helper sets a local identity; these tests control it explicitly.
  repo.git('config', '--unset', 'user.name');
  repo.git('config', '--unset', 'user.email');
  return { repo, globalPath, service: new GitService(repo.repository) };
}

const NO_SIGNING = { enabledByDefault: false, format: 'openpgp', key: '', available: false };

test('identity is empty and unsigned when nothing is configured', async t => {
  const { service } = isolate(t);
  assert.deepEqual(await service.getIdentity(), {
    name: '',
    email: '',
    nameSource: null,
    emailSource: null,
    configured: false,
    signing: NO_SIGNING
  });
});

test('identity prefers local values and falls back to global ones per field', async t => {
  const { repo, service } = isolate(t, '[user]\n\tname = Global Name\n\temail = global@example.test\n');
  assert.deepEqual(await service.getIdentity(), {
    name: 'Global Name',
    email: 'global@example.test',
    nameSource: 'global',
    emailSource: 'global',
    configured: true,
    signing: NO_SIGNING
  });

  repo.git('config', 'user.name', '  Local Name  ');
  repo.git('config', '--add', 'user.name', 'Last Local Name ');
  const identity = await service.getIdentity();
  assert.equal(identity.name, 'Last Local Name');
  assert.equal(identity.nameSource, 'local');
  assert.equal(identity.email, 'global@example.test');
  assert.equal(identity.emailSource, 'global');

  // An empty local value still falls back to the global one.
  repo.git('config', '--replace-all', 'user.name', '');
  assert.equal((await service.getIdentity()).nameSource, 'global');
});

test('identity ignores included files for local and global values only', async t => {
  const included = '[user]\n\tname = Included Name\n\temail = included@example.test\n'
    + '\tsigningKey = INCLUDED-KEY\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgSign = yes\n';
  const { repo, service } = isolate(t);
  const includedPath = path.join(repo.root, 'included.gitconfig');
  fs.writeFileSync(includedPath, included);
  fs.writeFileSync(
    process.env.GIT_CONFIG_GLOBAL,
    `[user]\n\temail = global@example.test\n[include]\n\tpath = ${includedPath.replaceAll('\\', '/')}\n`
  );
  repo.git('config', `includeIf.gitdir:${repo.repository.replaceAll('\\', '/')}/.path`, includedPath);

  assert.deepEqual(await service.getIdentity(), {
    name: '',
    email: 'global@example.test',
    nameSource: null,
    emailSource: 'global',
    configured: false,
    signing: { enabledByDefault: true, format: 'ssh', key: 'INCLUDED-KEY', available: true }
  });
});

test('identity reads signing settings from every scope, including worktree and environment', async t => {
  const { repo, service } = isolate(
    t,
    '[user]\n\tname = Global Name\n\temail = global@example.test\n\tsigningKey = GLOBAL-KEY\n'
      + '[commit]\n\tgpgSign\n',
    {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Environment Name',
      GIT_CONFIG_KEY_1: 'gpg.format',
      GIT_CONFIG_VALUE_1: 'x509'
    }
  );
  // A key without a value reads as an empty string, not as true.
  assert.deepEqual((await service.getIdentity()).signing, {
    enabledByDefault: false,
    format: 'x509',
    key: 'GLOBAL-KEY',
    available: true
  });

  repo.git('config', 'extensions.worktreeConfig', 'true');
  repo.git('config', '--worktree', 'user.signingKey', 'WORKTREE-KEY');
  repo.git('config', '--worktree', 'user.name', 'Worktree Name');
  repo.git('config', 'commit.gpgSign', 'on');
  const identity = await service.getIdentity();
  assert.equal(identity.name, 'Global Name');
  assert.equal(identity.nameSource, 'global');
  assert.deepEqual(identity.signing, {
    enabledByDefault: true,
    format: 'x509',
    key: 'WORKTREE-KEY',
    available: true
  });

  repo.git('config', 'gpg.format', 'unknown');
  delete process.env.GIT_CONFIG_COUNT;
  assert.deepEqual((await service.getIdentity()).signing, {
    enabledByDefault: true,
    format: 'unknown',
    key: 'WORKTREE-KEY',
    available: false
  });
});

test('identity is empty when a config file Git must read is malformed', async t => {
  const { repo, service } = isolate(t, '[user\n\tname = Broken\n');
  repo.git('config', 'user.name', 'Local Name');
  repo.git('config', 'user.email', 'local@example.test');
  repo.git('config', 'user.signingKey', 'LOCAL-KEY');

  // Git refuses every config read, even --local, while the global file is malformed.
  assert.deepEqual(await service.getIdentity(), {
    name: '',
    email: '',
    nameSource: null,
    emailSource: null,
    configured: false,
    signing: NO_SIGNING
  });
});

test('identity follows git config when GIT_CONFIG names a single file', async t => {
  const { repo, service } = isolate(t, '[user]\n\temail = global@example.test\n');
  const legacyPath = path.join(repo.root, 'legacy.gitconfig');
  fs.writeFileSync(legacyPath, '[user]\n\tsigningKey = LEGACY-KEY\n');
  repo.git('config', 'user.name', 'Local Name');
  repo.git('config', 'user.signingKey', 'LOCAL-KEY');
  process.env.GIT_CONFIG = legacyPath;

  // --local and --global refuse a second file; unscoped keys read only GIT_CONFIG.
  const identity = await service.getIdentity();
  assert.equal(identity.name, '');
  assert.equal(identity.email, '');
  assert.equal(identity.signing.key, 'LEGACY-KEY');
});

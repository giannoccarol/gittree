const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

test('reads and writes repository identity without changing global config', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const service = new GitService(repo.repository);

  await service.setIdentity({
    name: 'Local Developer',
    email: 'local@example.test',
    scope: 'local'
  });
  const identity = await service.getIdentity();

  assert.equal(identity.name, 'Local Developer');
  assert.equal(identity.email, 'local@example.test');
  assert.equal(identity.nameSource, 'local');
  assert.equal(identity.emailSource, 'local');
});

test('commits staged changes with body, sign-off and author override', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('change.txt', 'ready\n');
  repo.git('add', '.');
  const service = new GitService(repo.repository);

  const result = await service.commitChanges({
    summary: 'Add advanced commit',
    body: 'Created through GitTree.',
    amend: false,
    signoff: true,
    signing: false,
    authorOverride: {
      name: 'Review Author',
      email: 'reviewer@example.test'
    }
  });

  assert.equal(result.success, true);
  assert.match(result.hash, /^[a-f0-9]{40}$/);
  assert.equal(repo.git('show', '-s', '--format=%an <%ae>', 'HEAD'), 'Review Author <reviewer@example.test>');
  const message = repo.git('show', '-s', '--format=%B', 'HEAD');
  assert.match(message, /^Add advanced commit/);
  assert.match(message, /Created through GitTree\./);
  assert.match(message, /Signed-off-by: GitTree Tests <gittree@example\.test>/);
});

test('amends HEAD without requiring new staged changes', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('tracked.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'old message');
  const oldHash = repo.git('rev-parse', 'HEAD');
  const service = new GitService(repo.repository);

  const result = await service.commitChanges({
    summary: 'updated message',
    amend: true,
    signoff: false,
    signing: false
  });

  assert.notEqual(result.hash, oldHash);
  assert.equal(repo.git('show', '-s', '--format=%s', 'HEAD'), 'updated message');
});

test('rejects empty normal commits and signing without a configured key', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('tracked.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  const service = new GitService(repo.repository);

  await assert.rejects(
    service.commitChanges({ summary: 'empty', amend: false }),
    /no staged changes/i
  );

  repo.write('tracked.txt', 'changed\n');
  repo.git('add', '.');
  repo.git('config', 'user.signingKey', '');
  await assert.rejects(
    service.commitChanges({ summary: 'signed', signing: true }),
    /signing key/i
  );
});

test('keeps staged changes intact when a Git commit hook rejects the message', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('blocked.txt', 'blocked\n');
  repo.git('add', '.');
  const hook = path.join(repo.repository, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const service = new GitService(repo.repository);

  await assert.rejects(
    service.commitChanges({ summary: 'blocked by hook', signing: false }),
    /commit failed/i
  );
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'blocked.txt');
});

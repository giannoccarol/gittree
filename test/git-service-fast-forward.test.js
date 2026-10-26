const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { GitService } = require('../src/main/git-service.mts');
const { createRepository, git } = require('./helpers/git-repository');

function commitIn(directory, file, message) {
  fs.writeFileSync(path.join(directory, file), `${message}\n`);
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

// main is checked out; feature/topic tracks origin/feature/topic and is behind it.
function createFixture(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  commitIn(repo.repository, 'base.txt', 'base');
  const remote = path.join(repo.root, 'origin.git');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '--set-upstream', 'origin', 'main');
  repo.git('switch', '-c', 'feature/topic');
  repo.git('push', '--set-upstream', 'origin', 'feature/topic');
  repo.git('switch', 'main');

  const other = path.join(repo.root, 'other');
  git(repo.root, 'clone', remote, other);
  git(other, 'switch', 'feature/topic');
  const remoteTip = commitIn(other, 'remote.txt', 'remote work');
  git(other, 'push');
  return { repo, other, remoteTip, service: new GitService(repo.repository) };
}

test('a branch that is not checked out is fast-forwarded to its remote branch', async t => {
  const { repo, remoteTip, service } = createFixture(t);
  const before = repo.git('rev-parse', 'feature/topic');

  const result = await service.fastForwardBranch('origin', 'feature/topic', 'feature/topic');

  assert.equal(result.success, true);
  assert.equal(result.updated, true);
  assert.equal(result.before, before);
  assert.equal(result.after, remoteTip);
  assert.equal(repo.git('rev-parse', 'feature/topic'), remoteTip);
  assert.equal(repo.git('rev-parse', 'origin/feature/topic'), remoteTip);
  assert.equal(repo.git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(fs.existsSync(path.join(repo.repository, 'remote.txt')), false);

  const again = await service.fastForwardBranch('origin', 'feature/topic', 'feature/topic');
  assert.equal(again.updated, false);
});

test('a diverged branch is refused and keeps its local commits', async t => {
  const { repo, service } = createFixture(t);
  repo.git('switch', 'feature/topic');
  const localTip = commitIn(repo.repository, 'local.txt', 'local work');
  repo.git('switch', 'main');

  await assert.rejects(
    service.fastForwardBranch('origin', 'feature/topic', 'feature/topic'),
    /Cannot fast-forward feature\/topic/
  );
  assert.equal(repo.git('rev-parse', 'feature/topic'), localTip);
});

test('the current branch and branches checked out elsewhere are refused', async t => {
  const { repo, service } = createFixture(t);

  await assert.rejects(
    service.fastForwardBranch('origin', 'main', 'main'),
    /main is the current branch/
  );

  const linked = path.join(repo.root, 'linked');
  repo.git('worktree', 'add', linked, 'feature/topic');
  const before = repo.git('rev-parse', 'feature/topic');
  await assert.rejects(
    service.fastForwardBranch('origin', 'feature/topic', 'feature/topic'),
    /checked out in another worktree/
  );
  assert.equal(repo.git('rev-parse', 'feature/topic'), before);
});

test('fast-forward rejects unknown remotes and option-like names', async t => {
  const { service } = createFixture(t);

  await assert.rejects(
    service.fastForwardBranch('--upload-pack=touch /tmp/pwned', 'main', 'feature/topic'),
    /Remote not found/
  );
  await assert.rejects(
    service.fastForwardBranch('origin', '--all', 'feature/topic'),
    /Invalid branch name/
  );
  await assert.rejects(
    service.fastForwardBranch('origin', 'feature/topic', '-f'),
    /Invalid local branch name/
  );
});

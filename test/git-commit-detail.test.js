const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRepository } = require('./helpers/git-repository');
const { GitService } = require('../src/main/git-service.mts');
const { parseCommitDetailOutput } = require('../src/main/git/repository-history.mts');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function rawGit(repository, ...args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  });
}

// The detail the inspector showed before it was read with one process: log
// metadata, the first-parent `git diff` and the `git show --stat` lines.
function referenceDetail(repository, hash) {
  const [full, authorName, authorEmail, date, subject] = rawGit(
    repository, 'log', '-1', '--format=%H%x00%aN%x00%aE%x00%aI%x00%s', hash
  ).replace(/\n$/, '').split('\0');
  const parents = rawGit(repository, 'rev-list', '--parents', '-n', '1', hash).trim().split(/\s+/);
  const range = parents.length > 1 ? `${hash}^..${hash}` : `${EMPTY_TREE}..${hash}`;
  return {
    hash: full,
    message: subject,
    author_name: authorName,
    author_email: authorEmail,
    date,
    diff: rawGit(repository, 'diff', '--no-ext-diff', range),
    files: rawGit(repository, 'show', hash, '--stat', '--format=').trim().split('\n').filter(Boolean)
  };
}

function buildHistory(fixture) {
  const commits = {};
  fixture.write('README.md', '# Fixture\n');
  fixture.write('src/a file.txt', 'one\ntwo\nthree\n');
  fixture.git('add', '-A');
  fixture.git('commit', '-m', 'root commit');
  commits.root = fixture.git('rev-parse', 'HEAD');

  fixture.write('src/a file.txt', 'one\n2\nthree\nfour\n');
  fs.writeFileSync(path.join(fixture.repository, 'logo.bin'), Buffer.from([0, 1, 2, 3, 255]));
  fixture.git('add', '-A');
  fixture.git('commit', '-m', 'modify and add binary', '-m', 'Body line one.\n\nBody line two.');
  commits.modify = fixture.git('rev-parse', 'HEAD');

  fixture.git('checkout', '-b', 'topic');
  fs.mkdirSync(path.join(fixture.repository, 'docs'));
  fixture.git('mv', 'README.md', 'docs/README.md');
  fixture.git('commit', '-m', 'rename readme');
  commits.rename = fixture.git('rev-parse', 'HEAD');

  fixture.git('checkout', 'main');
  fixture.write('main.txt', 'main side\n');
  fixture.git('add', '-A');
  fixture.git('commit', '-m', 'main side');
  fixture.git('merge', '--no-ff', 'topic', '-m', 'merge topic');
  commits.merge = fixture.git('rev-parse', 'HEAD');

  fixture.git('commit', '--allow-empty', '-m', 'empty commit');
  commits.empty = fixture.git('rev-parse', 'HEAD');
  return commits;
}

test('commit detail matches the log, diff and stat it replaced for every commit shape', async () => {
  const fixture = createRepository();
  try {
    const commits = buildHistory(fixture);
    const service = new GitService(fixture.repository);
    for (const [name, hash] of Object.entries(commits)) {
      const detail = await service.getCommitDetail(hash);
      assert.deepEqual({ ...detail }, referenceDetail(fixture.repository, hash), name);
    }
    const short = await service.getCommitDetail(commits.modify.slice(0, 7));
    assert.equal(short.hash, commits.modify);
  } finally {
    fixture.cleanup();
  }
});

test('commit detail is read with a single git process', async () => {
  const fixture = createRepository();
  const traceFile = path.join(fixture.root, 'trace.log');
  const previous = process.env.GIT_TRACE2;
  try {
    const commits = buildHistory(fixture);
    const service = new GitService(fixture.repository);
    process.env.GIT_TRACE2 = traceFile;
    await service.getCommitDetail(commits.modify);
    const starts = fs.readFileSync(traceFile, 'utf8').split('\n').filter(line => / start /.test(line));
    assert.equal(starts.length, 1, starts.join('\n'));
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2;
    else process.env.GIT_TRACE2 = previous;
    fixture.cleanup();
  }
});

test('commit detail parsing handles a header without a diff and rejects other output', () => {
  assert.equal(parseCommitDetailOutput(''), null);
  assert.equal(parseCommitDetailOutput('fatal: bad revision'), null);
  assert.deepEqual(parseCommitDetailOutput('abc\0Ada\0ada@example.test\x002026-01-01T00:00:00+00:00\0empty\x01\n'), {
    hash: 'abc',
    message: 'empty',
    author_name: 'Ada',
    author_email: 'ada@example.test',
    date: '2026-01-01T00:00:00+00:00',
    diff: '',
    files: []
  });
});

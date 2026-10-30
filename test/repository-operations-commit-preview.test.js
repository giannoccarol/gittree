const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

// GitService inherits process.env: keep the developer's Git config out of it.
const isolatedEnvironment = {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
};
const previousEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map(key => [key, process.env[key]])
);
Object.assign(process.env, isolatedEnvironment);
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function commit(repo, files, message) {
  for (const [file, content] of Object.entries(files)) repo.write(file, content);
  repo.git('add', '-A');
  repo.git('commit', '--allow-empty', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/** The result of one `git show -s` per hash, parsed like the original per-commit reader. */
function showMetadata(repo, hash) {
  const [fullHash, parentText = '', timestamp = '0', ...subject] = repo
    .git('show', '-s', '--format=%H%x1f%P%x1f%ct%x1f%s', hash)
    .split('\x1f');
  return {
    hash: fullHash,
    parents: parentText ? parentText.split(/\s+/) : [],
    timestamp: Number(timestamp) || 0,
    subject: subject.join('\x1f')
  };
}

/** The union of one `git show --name-only` per commit, in first-seen order. */
function showFiles(repo, hashes) {
  const files = new Set();
  for (const hash of hashes) {
    const raw = execFileSync('git', ['show', '--pretty=format:', '--name-only', '-z', hash], {
      cwd: repo.repository,
      encoding: 'utf8'
    });
    raw.split('\0').filter(Boolean).forEach(file => files.add(file));
  }
  return [...files];
}

/**
 * root -> renamed -> main tip, plus a side branch, a clean merge, an evil
 * merge that resolves a conflict and adds a file, and an empty commit.
 */
function createHistory(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const root = commit(repo, { 'a.txt': 'one\ntwo\nthree\nfour\n', 'b.txt': 'b\n' }, 'root');
  repo.git('mv', 'a.txt', 'renamed.txt');
  const renamed = commit(repo, {}, 'rename a\x1fwith a unit separator');
  repo.git('switch', '-c', 'side');
  const side = commit(repo, { 's.txt': 's\n', 'b.txt': 'b\nside\n' }, 'side work');
  repo.git('switch', 'main');
  const mainWork = commit(repo, { 'm.txt': 'm\n' }, 'main work');
  repo.git('merge', '--no-ff', 'side', '-m', 'clean merge');
  const cleanMerge = repo.git('rev-parse', 'HEAD');
  repo.git('switch', '-c', 'x1', mainWork);
  commit(repo, { 'c.txt': 'x1\n' }, 'x1');
  repo.git('switch', '-c', 'x2', mainWork);
  commit(repo, { 'c.txt': 'x2\n' }, 'x2');
  assert.throws(() => repo.git('merge', 'x1', '-m', 'evil merge'));
  repo.write('c.txt', 'resolved\n');
  repo.write('evil.txt', 'extra\n');
  repo.git('add', '-A');
  repo.git('commit', '-m', 'evil merge');
  const evilMerge = repo.git('rev-parse', 'HEAD');
  const empty = commit(repo, {}, 'empty');
  repo.git('tag', '-a', 'annotated', '-m', 'tag message', root);
  return { repo, root, renamed, side, mainWork, cleanMerge, evilMerge, empty };
}

test('commit action metadata matches one git show per selected hash', async t => {
  const history = createHistory(t);
  const { repo } = history;
  const service = new GitService(repo.repository);
  const hashes = [
    history.side,
    history.root,
    history.evilMerge,
    history.renamed,
    history.empty,
    history.cleanMerge
  ];
  assert.deepEqual(
    await service.getCommitActionMetadata(hashes),
    hashes.map(hash => showMetadata(repo, hash))
  );
  assert.deepEqual((await service.getCommitActionMetadata([history.root]))[0].parents, []);
  assert.equal((await service.getCommitActionMetadata([history.renamed]))[0].subject,
    'rename a\x1fwith a unit separator');

  // Abbreviated, upper-case and duplicate spellings of one commit stay separate entries.
  const spellings = [
    history.side.slice(0, 7),
    history.side.toUpperCase(),
    history.side,
    history.side
  ];
  const metadata = await service.getCommitActionMetadata(spellings);
  assert.equal(metadata.length, 3);
  assert.deepEqual(metadata, spellings.slice(0, 3).map(hash => showMetadata(repo, hash)));

  // An annotated tag id passes validation; git show prints the tag first.
  const tagId = repo.git('rev-parse', 'annotated');
  assert.deepEqual(
    await service.getCommitActionMetadata([history.side, tagId]),
    [showMetadata(repo, history.side), showMetadata(repo, tagId)]
  );
});

test('commit action metadata rejects the first missing hash in selection order', async t => {
  const history = createHistory(t);
  const service = new GitService(history.repo.repository);
  await assert.rejects(
    service.getCommitActionMetadata([history.root, 'deadbeefdeadbeef', 'cafebabecafebabe']),
    { message: 'Git ref not found: deadbeefdeadbeef' }
  );
  await assert.rejects(
    service.getCommitActionMetadata(['not-a-hash']),
    { message: 'Invalid commit hash' }
  );
  await assert.rejects(service.getCommitActionMetadata([]), /between 1 and 500/);
});

test('commit files match the union of git show per commit, in first-seen order', async t => {
  const history = createHistory(t);
  const { repo } = history;
  const service = new GitService(repo.repository);
  const hashes = [
    history.evilMerge,
    history.root,
    history.renamed,
    history.side,
    history.cleanMerge,
    history.empty,
    history.root
  ];
  const files = await service.getCommitFiles(hashes.map(hash => ({ hash })));
  assert.deepEqual(files, showFiles(repo, hashes));
  assert.deepEqual(files, ['c.txt', 'evil.txt', 'a.txt', 'b.txt', 'renamed.txt', 's.txt']);
  assert.deepEqual(await service.getCommitFiles([]), []);
  await assert.rejects(service.getCommitFiles([{ hash: 'deadbeefdeadbeef' }]));
});

test('cherry-pick and rebase previews keep their complete payloads', async t => {
  const history = createHistory(t);
  const { repo } = history;
  const service = new GitService(repo.repository);
  repo.git('switch', 'main');
  repo.git('switch', '-c', 'pick-target', history.root);
  const first = commit(repo, { 'p1.txt': '1\n' }, 'pick one');
  const second = commit(repo, { 'p2.txt': '2\n' }, 'pick two');
  repo.git('switch', '--detach', history.root);

  const cherryPick = await service.previewCommitAction('cherry-pick', [history.side, history.renamed]);
  assert.deepEqual(cherryPick, {
    action: 'cherry-pick',
    target: history.side,
    commits: [showMetadata(repo, history.renamed), showMetadata(repo, history.side)],
    files: showFiles(repo, [history.renamed, history.side]),
    workingTree: { clean: true, files: [] },
    pendingOperation: null,
    detached: true,
    allowed: true,
    reason: ''
  });

  repo.git('switch', 'pick-target');
  const replayed = repo.git('rev-list', '--reverse', `${history.mainWork}..HEAD`).split('\n');
  const rebase = await service.previewCommitAction('rebase', [history.mainWork]);
  assert.deepEqual(rebase, {
    action: 'rebase',
    target: history.mainWork,
    commits: replayed.map(hash => showMetadata(repo, hash)),
    files: repo.git('diff', '--name-only', `${history.mainWork}...HEAD`).split('\n'),
    workingTree: { clean: true, files: [] },
    pendingOperation: null,
    detached: false,
    allowed: true,
    reason: ''
  });
  assert.deepEqual(rebase.commits.map(item => item.hash), [first, second]);
});

test('a rebase preview that would replay more than 500 commits is rejected', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const base = commit(repo, { 'base.txt': 'base\n' }, 'base');
  const stream = [];
  for (let index = 1; index <= 501; index += 1) {
    const message = `long ${index}`;
    stream.push(
      'commit refs/heads/long',
      `mark :${index}`,
      `committer GitTree Tests <gittree@example.test> ${1_700_000_000 + index} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
      index === 1 ? `from ${base}` : `from :${index - 1}`,
      ''
    );
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo.repository, input: `${stream.join('\n')}\n` });
  const target = commit(repo, { 'main.txt': 'main\n' }, 'main work');
  repo.git('switch', 'long');
  fs.rmSync(path.join(repo.repository, 'main.txt'), { force: true });

  await assert.rejects(
    new GitService(repo.repository).previewCommitAction('rebase', [target]),
    { message: 'Select between 1 and 500 commits' }
  );
});

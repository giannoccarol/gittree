const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { simpleGit } = require('simple-git');
const { GitService } = require('../src/main/git-service.mts');
const { GraphHistoryIndex } = require('../src/main/git/graph-history-index.mts');
const { RepositorySession } = require('../src/main/git/repository-session.mts');
const { createRepository } = require('./helpers/git-repository');
const { writeSyntheticHistory } = require('./helpers/synthetic-history');

function historyHashes(repository) {
  return execFileSync('git', [
    'rev-list', '--exclude=refs/notes/*', '--exclude=refs/stash', '--all', '--topo-order', '--date-order'
  ], {
    cwd: repository,
    encoding: 'utf8'
  }).split('\n').filter(Boolean);
}

function createSyntheticRepository(t, commits = 900) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  writeSyntheticHistory(repo.repository, { commits, seed: 23, authors: 30 });
  return repo;
}

function commitOnMain(repo, message) {
  repo.write(`${message.replace(/\W+/g, '-')}.txt`, `${message}\n`);
  repo.git('add', '.');
  repo.git('commit', '-m', message);
}

// Index over the real repository whose git invocations are recorded.
function createRecordedIndex(repository, options = {}) {
  const git = simpleGit(repository);
  const session = new RepositorySession(repository);
  const calls = [];
  const index = new GraphHistoryIndex({
    repoPath: repository,
    ...options,
    git: {
      raw: args => {
        calls.push({ command: args[0], args });
        return git.raw(args);
      },
      rawWithInput: (args, input) => {
        calls.push({ command: args[0], args, input });
        return session.rawWithInput(args, input);
      }
    }
  });
  const commands = () => calls.splice(0, calls.length);
  return { index, commands };
}

test('continuation pages with the snapshot omit refs and keep the snapshot ordering', async t => {
  const repo = createSyntheticRepository(t);
  const before = historyHashes(repo.repository);
  const service = new GitService(repo.repository);
  const first = await service.getGraphPage(0, 300);
  const second = await service.getGraphPage(300, 300, first.snapshot);

  commitOnMain(repo, 'commit while paging');
  const third = await service.getGraphPage(600, 300, first.snapshot);
  const legacy = await service.getGraphPage(300, 300);

  assert.match(first.snapshot, /^[0-9a-f]{32}$/);
  assert.ok(first.refs.length > 0);
  assert.deepEqual(second.refs, []);
  assert.equal(second.snapshot, first.snapshot);
  assert.deepEqual(third.refs, []);
  assert.equal(third.snapshot, first.snapshot);
  assert.deepEqual(
    [...first.commits, ...second.commits, ...third.commits].map(commit => commit.hash),
    before
  );
  assert.notEqual(legacy.snapshot, first.snapshot);
  assert.ok(legacy.refs.length > 0);
  assert.deepEqual(legacy.commits.map(commit => commit.hash), historyHashes(repo.repository).slice(300, 600));
});

test('refs moving before the full order exists surface as a new snapshot', async t => {
  const repo = createSyntheticRepository(t, 600);
  const service = new GitService(repo.repository);
  const first = await service.getGraphPage(0, 200);

  commitOnMain(repo, 'commit before the second page');
  const second = await service.getGraphPage(200, 200, first.snapshot);

  assert.notEqual(second.snapshot, first.snapshot);
  assert.ok(second.refs.some(ref => ref.type === 'head'));
  assert.deepEqual(
    second.commits.map(commit => commit.hash),
    historyHashes(repo.repository).slice(200, 400)
  );
});

test('first pages report whether the snapshot changed since the caller last read it', async t => {
  const repo = createSyntheticRepository(t, 400);
  const service = new GitService(repo.repository);
  const first = await service.getGraphPage(0, 100);

  const unchanged = await service.getGraphPage(0, 100, first.snapshot);
  const restarted = await new GitService(repo.repository).getGraphPage(0, 100, first.snapshot);
  repo.git('branch', 'side', 'main~4');
  const changed = await service.getGraphPage(0, 100, first.snapshot);

  assert.equal(unchanged.snapshot, first.snapshot);
  assert.deepEqual(unchanged.refs, []);
  assert.deepEqual(unchanged.commits, first.commits);
  assert.equal(restarted.snapshot, first.snapshot, 'the id depends only on repository state');
  assert.notEqual(changed.snapshot, first.snapshot);
  assert.ok(changed.refs.some(ref => ref.fullName === 'refs/heads/side'));
});

test('a stale continuation token is answered from the current snapshot with refs', async t => {
  const repo = createSyntheticRepository(t, 400);
  const service = new GitService(repo.repository);
  const first = await service.getGraphPage(0, 100);
  commitOnMain(repo, 'moves the history');
  await service.getGraphPage(0, 100);

  const continuation = await service.getGraphPage(100, 100, first.snapshot);

  assert.notEqual(continuation.snapshot, first.snapshot);
  assert.ok(continuation.refs.length > 0);
  assert.deepEqual(
    continuation.commits.map(commit => commit.hash),
    historyHashes(repo.repository).slice(100, 200)
  );
});

test('malformed snapshot tokens are ignored', async t => {
  const repo = createSyntheticRepository(t, 200);
  const service = new GitService(repo.repository);
  const expected = await service.getGraphPage(50, 50);

  for (const token of ['XYZ', 42, {}, 'a'.repeat(65), '../../etc/passwd', 'abc']) {
    const page = await service.getGraphPage(50, 50, token);
    assert.deepEqual(page.commits, expected.commits);
    assert.ok(page.refs.length > 0, `token ${JSON.stringify(token)} must not hide refs`);
  }
});

test('replace refs refresh cached parents', async t => {
  const repo = createSyntheticRepository(t, 300);
  const service = new GitService(repo.repository);
  const target = repo.git('rev-parse', 'main~3');
  const graftParent = repo.git('rev-parse', 'main~40');
  let snapshot;
  for (let offset = 0; offset < 300; offset += 100) {
    snapshot = (await service.getGraphPage(offset, 100, snapshot)).snapshot;
  }

  repo.git('replace', '--graft', target, graftParent);
  const pages = [];
  for (let offset = 0, token; offset < 400; offset += 100) {
    const page = await service.getGraphPage(offset, 100, token);
    token = page.snapshot;
    pages.push(...page.commits);
    if (!page.hasMore) break;
  }

  assert.deepEqual(pages.find(commit => commit.hash === target).parents, [graftParent]);
  assert.deepEqual(pages.map(commit => commit.hash), historyHashes(repo.repository));
});

test('deep pages slice one cached order instead of walking history again', async t => {
  const repo = createSyntheticRepository(t, 900);
  const expected = historyHashes(repo.repository);
  const { index, commands } = createRecordedIndex(repo.repository);

  const first = await index.page(0, 200, null);
  assert.deepEqual(commands().map(call => call.command), ['for-each-ref', 'rev-parse', 'rev-parse', 'log']);

  const second = await index.page(200, 200, first.snapshot);
  const secondCalls = commands();
  // The walk is followed by one refs check proving it matches the snapshot.
  assert.deepEqual(secondCalls.map(call => call.command), ['rev-list', 'for-each-ref', 'rev-parse', 'log']);
  assert.ok(secondCalls[3].args.includes('--stdin'));
  assert.equal(secondCalls[3].input.trim().split('\n').length, 200, 'only uncached commits are read');

  const deep = await index.page(600, 200, first.snapshot);
  assert.deepEqual(commands().map(call => call.command), ['log']);
  assert.deepEqual(
    [...first.commits, ...second.commits, ...deep.commits].map(commit => commit.hash),
    [...expected.slice(0, 400), ...expected.slice(600, 800)]
  );

  const again = await index.page(200, 200, first.snapshot);
  assert.deepEqual(commands(), [], 'cached pages need no git process');
  assert.deepEqual(again.commits, second.commits);
});

test('a refresh after new commits reads metadata only for the new commits', async t => {
  const repo = createSyntheticRepository(t, 900);
  const { index, commands } = createRecordedIndex(repo.repository);
  let token = null;
  for (let offset = 0; offset < 900; offset += 300) {
    token = (await index.page(offset, 300, token)).snapshot;
  }
  commands();

  const unchanged = await index.page(0, 300, token);
  assert.deepEqual(commands().map(call => call.command), ['for-each-ref', 'rev-parse']);
  assert.deepEqual(unchanged.refs, []);

  commitOnMain(repo, 'fetched one');
  commitOnMain(repo, 'fetched two');
  const refreshed = await index.page(0, 300, token);
  const refreshCalls = commands();
  assert.deepEqual(refreshCalls.map(call => call.command), ['for-each-ref', 'rev-parse', 'rev-list', 'log']);
  assert.equal(refreshCalls[3].input.trim().split('\n').length, 2);
  assert.deepEqual(
    refreshed.commits.map(commit => commit.hash),
    historyHashes(repo.repository).slice(0, 300)
  );
  assert.ok(refreshed.refs.length > 0);
});

test('the metadata cache stays bounded', async t => {
  const repo = createSyntheticRepository(t, 2600);
  const expected = historyHashes(repo.repository);
  const { index } = createRecordedIndex(repo.repository, { maxCachedCommits: 1000 });
  const hashes = [];
  let token = null;
  for (let offset = 0; offset < expected.length; offset += 1000) {
    const page = await index.page(offset, 1000, token);
    token = page.snapshot;
    hashes.push(...page.commits.map(commit => commit.hash));
  }
  const reread = await index.page(0, 1000, token);

  assert.deepEqual(hashes, expected);
  assert.deepEqual(reread.commits.map(commit => commit.hash), expected.slice(0, 1000));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');
const { writeSyntheticHistory } = require('./helpers/synthetic-history');

const FORMAT = '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s';

// Independent reference: the full topological history as git prints it in one walk.
function fullHistory(repository) {
  const raw = execFileSync('git', [
    'log', '--all', '--topo-order', '--date-order', '-z', FORMAT
  ], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\0')
    .map(record => record.replace(/^[\r\n]+|[\r\n]+$/g, ''))
    .filter(Boolean)
    .map(record => {
      const [hash, parents, authorName, authorEmail, date, ...subject] = record.split('\x1f');
      return {
        hash,
        parents: parents ? parents.split(/\s+/).filter(Boolean) : [],
        subject: subject.join('\x1f'),
        authorName,
        authorEmail,
        date
      };
    });
}

async function collectPages(service, limit, maxPages = Infinity) {
  const pages = [];
  let offset = 0;
  let snapshot;
  while (pages.length < maxPages) {
    const page = await service.getGraphPage(offset, limit, snapshot);
    pages.push({ offset, page });
    snapshot = page.snapshot;
    if (!page.hasMore) break;
    offset = page.nextOffset;
  }
  return pages;
}

function createSyntheticRepository(t, commits = 1200) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  writeSyntheticHistory(repo.repository, { commits, seed: 11, authors: 40 });
  return repo;
}

test('graph pages concatenate to the full topological history for every page size', async t => {
  const repo = createSyntheticRepository(t);
  const expected = fullHistory(repo.repository);
  assert.equal(expected.length, 1200);

  for (const limit of [97, 500, 1000]) {
    const service = new GitService(repo.repository);
    const pages = await collectPages(service, limit);
    const commits = pages.flatMap(({ page }) => page.commits);

    assert.deepEqual(commits, expected, `limit ${limit} must preserve order and fields`);
    pages.forEach(({ offset, page }, index) => {
      const last = index === pages.length - 1;
      assert.equal(page.nextOffset, offset + page.commits.length);
      assert.equal(page.hasMore, !last);
      if (!last) assert.equal(page.commits.length, limit);
    });
  }
});

test('single-commit pages keep the look-ahead contract at any offset', async t => {
  const repo = createSyntheticRepository(t, 300);
  const expected = fullHistory(repo.repository);
  const service = new GitService(repo.repository);

  const first = await service.getGraphPage(0, 1);
  const deep = await service.getGraphPage(250, 1, first.snapshot);
  const last = await service.getGraphPage(expected.length - 1, 1, first.snapshot);
  const beyond = await service.getGraphPage(expected.length + 10, 5, first.snapshot);

  assert.deepEqual(first.commits, expected.slice(0, 1));
  assert.equal(first.hasMore, true);
  assert.deepEqual(deep.commits, expected.slice(250, 251));
  assert.equal(deep.nextOffset, 251);
  assert.deepEqual(last.commits, expected.slice(-1));
  assert.equal(last.hasMore, false);
  assert.deepEqual(beyond.commits, []);
  assert.equal(beyond.hasMore, false);
  assert.equal(beyond.nextOffset, expected.length + 10);
});

test('graph pages without a snapshot always carry the current refs', async t => {
  const repo = createSyntheticRepository(t, 600);
  repo.git('tag', '-a', 'v9.9.9', '-m', 'annotated', 'main~3');
  const service = new GitService(repo.repository);
  const refs = await service.getGraphRefs();

  for (const offset of [0, 200, 400]) {
    const page = await service.getGraphPage(offset, 200);
    assert.deepEqual(page.refs, refs, `refs at offset ${offset}`);
  }
  assert.equal(
    refs.find(ref => ref.fullName === 'refs/tags/v9.9.9').commit,
    repo.git('rev-parse', 'main~3')
  );
  assert.ok(refs.some(ref => ref.type === 'remote'));
  assert.ok(refs.some(ref => ref.type === 'head'));
});

test('graph pages without a snapshot reflect history changes between calls', async t => {
  const repo = createSyntheticRepository(t, 400);
  const service = new GitService(repo.repository);
  const before = await service.getGraphPage(0, 100);

  repo.write('later.txt', 'later\n');
  repo.git('add', 'later.txt');
  repo.git('commit', '-m', 'commit after the first page');
  const expected = fullHistory(repo.repository);

  const first = await service.getGraphPage(0, 100);
  const second = await service.getGraphPage(100, 100);

  assert.equal(before.commits[0].subject === 'commit after the first page', false);
  assert.deepEqual(first.commits, expected.slice(0, 100));
  assert.deepEqual(second.commits, expected.slice(100, 200));
  assert.equal(first.commits[0].subject, 'commit after the first page');
  assert.ok(first.refs.some(ref => ref.type === 'head' && ref.commit === expected[0].hash));
});

test('graph paging clamps untrusted offsets and limits', async t => {
  const repo = createSyntheticRepository(t, 1100);
  const expected = fullHistory(repo.repository);
  const service = new GitService(repo.repository);

  const negative = await service.getGraphPage(-50, 3);
  const notANumber = await service.getGraphPage('abc', 'xyz');
  const zeroLimit = await service.getGraphPage(0, 0);
  const hugeLimit = await service.getGraphPage(0, 50_000);

  assert.deepEqual(negative.commits, expected.slice(0, 3));
  assert.equal(negative.nextOffset, 3);
  assert.equal(notANumber.commits.length, 500);
  assert.deepEqual(zeroLimit.commits, expected.slice(0, 1));
  assert.equal(hugeLimit.commits.length, 1000);
  assert.equal(hugeLimit.hasMore, true);
});

test('empty repository yields a final empty graph page', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const service = new GitService(repo.repository);

  const page = await service.getGraphPage(0, 500);

  assert.deepEqual(page.commits, []);
  assert.deepEqual(page.refs, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, 0);
});

test('graph includes commits reachable only from a detached HEAD', async t => {
  const repo = createSyntheticRepository(t, 200);
  repo.git('checkout', '--quiet', '--detach', 'main~2');
  repo.write('detached.txt', 'detached\n');
  repo.git('add', 'detached.txt');
  repo.git('commit', '-m', 'detached work');
  const detached = repo.git('rev-parse', 'HEAD');
  const service = new GitService(repo.repository);

  const pages = await collectPages(service, 500);
  const commits = pages.flatMap(({ page }) => page.commits);

  assert.ok(commits.some(commit => commit.hash === detached));
  assert.ok(pages[0].page.refs.some(ref => ref.type === 'head' && ref.commit === detached));
});

test('graph walk currently includes stash and notes commits', async t => {
  const repo = createSyntheticRepository(t, 120);
  repo.write('wip.txt', 'work in progress\n');
  repo.git('add', 'wip.txt');
  repo.git('stash', 'push', '-m', 'parked work');
  repo.git('notes', 'add', '-m', 'review note', 'main~1');
  const stash = repo.git('rev-parse', 'refs/stash');
  const notes = repo.git('rev-parse', 'refs/notes/commits');
  const service = new GitService(repo.repository);

  const commits = (await collectPages(service, 500)).flatMap(({ page }) => page.commits);
  const hashes = new Set(commits.map(commit => commit.hash));

  assert.equal(hashes.has(stash), true);
  assert.equal(hashes.has(notes), true);
  assert.deepEqual(commits, fullHistory(repo.repository));
});

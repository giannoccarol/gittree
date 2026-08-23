const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepository, git, toWindowsShortPath } = require('./helpers/git-repository');
const { isWorkingTreeRepository } = require('../src/main/working-tree-repository.mts');

test('working-tree validation accepts only the repository root', async t => {
  const fixture = createRepository();
  t.after(() => fixture.cleanup());
  const nested = path.join(fixture.repository, 'nested');
  fs.mkdirSync(nested);

  assert.equal(await isWorkingTreeRepository(fixture.repository), true);
  assert.equal(await isWorkingTreeRepository(toWindowsShortPath(fixture.repository)), true);
  assert.equal(await isWorkingTreeRepository(nested), false);
  assert.equal(await isWorkingTreeRepository('relative/repository'), false);
});

test('working-tree validation rejects bare repositories', async t => {
  const fixture = createRepository();
  t.after(() => fixture.cleanup());
  const bare = path.join(fixture.root, 'bare.git');
  fs.mkdirSync(bare);
  git(bare, 'init', '--bare');

  assert.equal(await isWorkingTreeRepository(bare), false);
});

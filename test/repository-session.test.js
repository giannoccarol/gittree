const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RepositorySession } = require('../src/main/git/repository-session.mts');

test('Repository session owns one normalized path and one git adapter', () => {
  const calls = [];
  const git = { status() {} };
  const session = new RepositorySession(path.join('.', 'fixture-repo'), {
    createGit: repositoryPath => {
      calls.push(repositoryPath);
      return git;
    }
  });

  assert.equal(session.path, path.resolve('fixture-repo'));
  assert.equal(session.git, git);
  assert.deepEqual(calls, [path.resolve('fixture-repo')]);
});

test('Repository session serializes operations and permits nested calls', async () => {
  const session = new RepositorySession('.', { createGit: () => ({}) });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = session.runExclusive(async () => {
    order.push('first:start');
    await session.runExclusive(async () => order.push('first:nested'));
    await firstGate;
    order.push('first:end');
  });
  const second = session.runExclusive(async () => order.push('second'));

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start', 'first:nested']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:nested', 'first:end', 'second']);
});

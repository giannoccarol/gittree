const test = require('node:test');
const assert = require('node:assert/strict');
const { planBatchPull } = require('../src/renderer/components/branch-list.mts');

test('batch pull integrates only the current branch and fast-forwards the others', () => {
  const plan = planBatchPull([
    { kind: 'local', name: 'develop', current: true, upstream: 'origin/develop' },
    { kind: 'local', name: 'feature/login', upstream: 'origin/feature/login' },
    { kind: 'local', name: 'hotfix', upstream: 'upstream/hotfix' }
  ], ['origin', 'upstream'], 'develop');

  assert.deepEqual(plan.steps, [
    { branch: 'develop', remote: 'origin', remoteBranch: 'develop', mode: 'pull' },
    { branch: 'feature/login', remote: 'origin', remoteBranch: 'feature/login', mode: 'fast-forward' },
    { branch: 'hotfix', remote: 'upstream', remoteBranch: 'hotfix', mode: 'fast-forward' }
  ]);
  assert.deepEqual(plan.skipped, []);
});

test('batch pull splits upstreams on the longest known remote name', () => {
  const plan = planBatchPull([
    { kind: 'local', name: 'main', upstream: 'team/fork/main' }
  ], ['team', 'team/fork'], 'other');

  assert.deepEqual(plan.steps, [
    { branch: 'main', remote: 'team/fork', remoteBranch: 'main', mode: 'fast-forward' }
  ]);
});

test('batch pull reports branches without upstream and ignores remote entries', () => {
  const plan = planBatchPull([
    { kind: 'local', name: 'scratch' },
    { kind: 'remote', name: 'origin/main' }
  ], ['origin'], 'main');

  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.skipped, ['scratch']);
});

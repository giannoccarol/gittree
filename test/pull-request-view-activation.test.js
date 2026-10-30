const test = require('node:test');
const assert = require('node:assert/strict');

test('activating pull requests while another repository opens does not reload the previous one', async () => {
  global.window = global.window || {};
  const { PullRequestView } = require('../src/renderer/components/pull-request-view.mts');
  const view = Object.create(PullRequestView.prototype);
  const reloads = [];
  let current = '/repo-b';
  view.root = { classList: { toggle() {} } };
  view.app = { isCurrentRepo: repoPath => repoPath === current };
  view.refreshStatus = async () => {};
  view.reload = async () => { reloads.push(view.repoPath); };

  view.repoPath = '/repo-a';
  view.setActive(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reloads, []);

  current = '/repo-a';
  view.setActive(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reloads, ['/repo-a']);
});

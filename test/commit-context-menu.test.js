const test = require('node:test');
const assert = require('node:assert/strict');
let CommitContextMenu;
try {
  const mod = require('../src/renderer/components/commit-context-menu.mts');
  CommitContextMenu = mod.CommitContextMenu || mod.default || mod;
} catch {
  CommitContextMenu = require('../src/renderer/components/commit-context-menu');
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cherry-pick preview becomes available without waiting for rebase preview', async t => {
  const cherryPick = deferred();
  const rebase = deferred();
  const calls = [];
  global.window = {
    gitTree: {
      previewCommitAction(_repoPath, action) {
        calls.push(action);
        return action === 'cherry-pick' ? cherryPick.promise : rebase.promise;
      }
    }
  };
  global.t = key => key;
  t.after(() => {
    delete global.window;
    delete global.t;
  });

  const menu = Object.create(CommitContextMenu.prototype);
  menu.generation = 1;
  menu.previews = {};
  menu.element = { classList: { contains: () => false } };
  menu.render = () => {};
  menu.place = () => {};

  const loading = menu.loadPreviews(1, '/repo', ['abc1234'], { x: 10, y: 20 });
  assert.deepEqual(calls, ['cherry-pick', 'rebase']);

  cherryPick.resolve({ action: 'cherry-pick', allowed: true, commits: [], files: [] });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(menu.previews['cherry-pick'].allowed, true);
  assert.equal(Object.hasOwn(menu.previews, 'rebase'), false);

  rebase.resolve({ action: 'rebase', allowed: true, commits: [], files: [] });
  await loading;
});

test('preview error envelopes become disabled actions with an explanation', () => {
  global.t = key => key;
  const menu = Object.create(CommitContextMenu.prototype);

  const preview = menu.normalizePreview('cherry-pick', { error: 'Commit disappeared' });

  assert.deepEqual(preview, {
    action: 'cherry-pick',
    allowed: false,
    reason: 'Commit disappeared',
    commits: [],
    files: []
  });
  delete global.t;
});

test('confirmed cherry-pick executes the previewed selection and refreshes its new head', async t => {
  const calls = [];
  global.window = {
    gitTree: {
      async cherryPick(repoPath, hashes) {
        calls.push({ repoPath, hashes });
        return { success: true, head: 'new-head' };
      }
    }
  };
  global.t = key => key;
  t.after(() => {
    delete global.window;
    delete global.t;
  });

  const refreshes = [];
  const menu = Object.create(CommitContextMenu.prototype);
  menu.app = {
    state: { repo: { path: '/repo' } },
    showToast: () => {},
    refresh: options => { refreshes.push(options); }
  };
  menu.hashes = ['abc1234'];
  menu.previews = {
    'cherry-pick': { action: 'cherry-pick', allowed: true, commits: [], files: [] }
  };
  menu.close = () => { menu.hashes = ['changed-after-confirmation']; };
  menu.previewDialog = async () => true;

  await menu.execute('cherry-pick');

  assert.deepEqual(calls, [{ repoPath: '/repo', hashes: ['abc1234'] }]);
  assert.deepEqual(refreshes, [{ selectHash: 'new-head', silent: true }]);
});

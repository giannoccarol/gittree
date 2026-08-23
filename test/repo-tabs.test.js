const test = require('node:test');
const assert = require('node:assert/strict');

let RepoTabs;
try {
  const mod = require('../src/renderer/components/repo-tabs.mts');
  RepoTabs = mod.RepoTabs || mod.default || mod;
} catch {
  RepoTabs = require('../src/renderer/components/repo-tabs');
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    read: key => values.get(key) ?? null
  };
}

function createTabs(storage = createStorage()) {
  const tabs = Object.create(RepoTabs.prototype);
  tabs.app = {
    state: { activeRepoIndex: -1 },
    emit() {}
  };
  tabs.platform = 'win32';
  tabs.storage = storage;
  tabs.layoutStorageKey = 'gittree.repo-tabs.layout';
  tabs.repos = [];
  tabs.backendRepos = [];
  tabs.pinnedKeys = new Set();
  tabs.render = () => { tabs.renderCount = (tabs.renderCount || 0) + 1; };
  return tabs;
}

function repo(path) {
  return { path: `C:\\work\\${path}`, name: path };
}

test('repo tabs restore persisted order and keep pinned repositories at the front', () => {
  const storage = createStorage({
    'gittree.repo-tabs.layout': JSON.stringify({
      order: ['C:\\work\\third', 'C:\\work\\first', 'C:\\work\\second'],
      pinned: ['C:\\WORK\\SECOND']
    })
  });
  const tabs = createTabs(storage);

  tabs.setRepositoryData([repo('first'), repo('second'), repo('third')]);

  assert.deepEqual(tabs.repos.map(item => item.name), ['second', 'third', 'first']);
  assert.equal(tabs.isPinned(tabs.repos[0]), true);
});

test('pinning preserves the active repository while moving it into the pinned group', () => {
  const tabs = createTabs();
  tabs.repos = [repo('first'), repo('second'), repo('third')];
  tabs.app.state.activeRepoIndex = 1;

  tabs.togglePinned(tabs.repos[1].path);

  assert.deepEqual(tabs.repos.map(item => item.name), ['second', 'first', 'third']);
  assert.equal(tabs.app.state.activeRepoIndex, 0);
  assert.deepEqual(JSON.parse(tabs.storage.read(tabs.layoutStorageKey)), {
    order: ['c:\\work\\second', 'c:\\work\\first', 'c:\\work\\third'],
    pinned: ['c:\\work\\second']
  });
});

test('drag and keyboard reordering persist display order without changing backend order', () => {
  const tabs = createTabs();
  tabs.backendRepos = [repo('first'), repo('second'), repo('third')];
  tabs.repos = [repo('first'), repo('second'), repo('third')];
  tabs.app.state.activeRepoIndex = 0;

  assert.equal(tabs.moveRepo(tabs.repos[2].path, tabs.repos[0].path, false), true);
  assert.deepEqual(tabs.repos.map(item => item.name), ['third', 'first', 'second']);
  assert.deepEqual(tabs.backendRepos.map(item => item.name), ['first', 'second', 'third']);
  assert.equal(tabs.app.state.activeRepoIndex, 1);

  assert.equal(tabs.moveRepoByOffset(1, 1), true);
  assert.deepEqual(tabs.repos.map(item => item.name), ['third', 'second', 'first']);
  assert.equal(tabs.moveRepoByOffset(0, 1), true);
  assert.deepEqual(tabs.repos.map(item => item.name), ['second', 'third', 'first']);
});

test('selecting a reordered tab maps its display position to the backend repository index', async () => {
  const calls = [];
  global.window = {
    gitTree: {
      setActiveRepo: async index => {
        calls.push(index);
        return { path: 'C:\\work\\second', name: 'second' };
      }
    }
  };
  const tabs = createTabs();
  tabs.backendRepos = [repo('first'), repo('second')];
  tabs.repos = [repo('second'), repo('first')];

  await tabs.selectRepo(0);

  assert.deepEqual(calls, [1]);
  assert.equal(tabs.app.state.activeRepoIndex, 0);
});

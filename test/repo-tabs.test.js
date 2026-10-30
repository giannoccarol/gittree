const test = require('node:test');
const assert = require('node:assert/strict');

let RepoTabs;
let splitVisibleAndOverflowRepos;
try {
  const mod = require('../src/renderer/components/repo-tabs.mts');
  RepoTabs = mod.RepoTabs || mod.default || mod;
  splitVisibleAndOverflowRepos = mod.splitVisibleAndOverflowRepos;
} catch {
  RepoTabs = require('../src/renderer/components/repo-tabs');
  splitVisibleAndOverflowRepos = RepoTabs.splitVisibleAndOverflowRepos;
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

test('overflow split keeps stable order regardless of the active repository', () => {
  const repos = ['a', 'b', 'c', 'd', 'e', 'f'].map(repo);
  const { visible, overflow } = splitVisibleAndOverflowRepos(repos, 4, path => path.toLowerCase());
  assert.equal(visible.length, 4);
  assert.deepEqual(visible.map(item => item.name), ['a', 'b', 'c', 'd']);
  assert.equal(overflow.length, 2);
  assert.deepEqual(overflow.map(item => item.name), ['e', 'f']);
});

test('selecting a visible tab keeps display order', async () => {
  global.window = { gitTree: { setActiveRepo: async () => ({ path: 'C:\\work\\second' }) } };
  const tabs = createTabs();
  tabs.backendRepos = [repo('first'), repo('second'), repo('third')];
  tabs.repos = [repo('first'), repo('second'), repo('third')];
  await tabs.selectRepo(1);
  assert.deepEqual(tabs.repos.map(item => item.name), ['first', 'second', 'third']);
  assert.equal(tabs.app.state.activeRepoIndex, 1);
});

test('selecting an overflow tab promotes it into the last visible slot', async () => {
  global.window = { gitTree: { setActiveRepo: async () => ({ path: 'C:\\work\\f' }) } };
  const tabs = createTabs();
  tabs.persistLayout = () => {};
  tabs.backendRepos = ['a', 'b', 'c', 'd', 'e', 'f'].map(repo);
  tabs.repos = ['a', 'b', 'c', 'd', 'e', 'f'].map(repo);
  await tabs.selectRepo(5);
  assert.deepEqual(tabs.repos.map(item => item.name), ['a', 'b', 'c', 'f', 'd', 'e']);
  assert.equal(tabs.app.state.activeRepoIndex, 3);
});

test('overflow pick does not displace a pinned last visible tab', async () => {
  global.window = { gitTree: { setActiveRepo: async () => ({ path: 'C:\\work\\e' }) } };
  const tabs = createTabs();
  tabs.persistLayout = () => {};
  tabs.repos = ['a', 'b', 'c', 'd', 'e'].map(repo);
  tabs.backendRepos = [...tabs.repos];
  for (const name of ['a', 'b', 'c', 'd']) tabs.pinnedKeys.add(tabs.repoKey(`C:\\work\\${name}`));
  await tabs.selectRepo(4);
  assert.deepEqual(tabs.repos.map(item => item.name), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(tabs.app.state.activeRepoIndex, 4);
});

test('overflow split is empty when four or fewer repositories are open', () => {
  const repos = ['a', 'b', 'c'].map(repo);
  const { visible, overflow } = splitVisibleAndOverflowRepos(repos, 1, path => path);
  assert.equal(visible.length, 3);
  assert.equal(overflow.length, 0);
});

test('tab sync polling pauses while the window is hidden or unfocused and catches up on focus', async () => {
  const savedSetInterval = global.setInterval;
  const savedClearInterval = global.clearInterval;
  const savedDocument = global.document;
  let tick = null;
  global.setInterval = callback => { tick = callback; return 1; };
  global.clearInterval = () => { tick = null; };
  const windowListeners = new Map();
  let reads = 0;
  global.window = {
    gitTree: { getBranchMetadata: async () => { reads += 1; return { branches: [] }; } },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    removeEventListener: type => windowListeners.delete(type)
  };
  const focus = { hidden: false, focused: true };
  global.document = { get hidden() { return focus.hidden; }, hasFocus: () => focus.focused };
  try {
    const tabs = createTabs();
    tabs.repos = [repo('first'), repo('second')];
    tabs.render = () => {};
    tabs.startPeriodicSyncRefresh();

    focus.focused = false;
    tick();
    focus.focused = true;
    focus.hidden = true;
    tick();
    assert.equal(reads, 0, 'no reads while unfocused or hidden');

    focus.hidden = false;
    tick();
    await Promise.resolve();
    assert.equal(reads, 2, 'one read per tab while visible and focused');

    windowListeners.get('focus')();
    assert.equal(reads, 2, 'a recent read is not repeated on focus');
    tabs.lastSyncAt -= 61000;
    windowListeners.get('focus')();
    await Promise.resolve();
    assert.equal(reads, 4);

    tabs.stopPeriodicSyncRefresh();
    assert.equal(windowListeners.has('focus'), false);
    assert.equal(tick, null);
  } finally {
    global.setInterval = savedSetInterval;
    global.clearInterval = savedClearInterval;
    if (savedDocument === undefined) delete global.document;
    else global.document = savedDocument;
  }
});

test('reading unchanged tab sync state does not rebuild the tab strip', async () => {
  global.window = {
    gitTree: {
      getBranchMetadata: async () => ({
        branches: [{ kind: 'local', current: true, name: 'main', upstream: 'origin/main', ahead: 1, behind: 0 }]
      })
    }
  };
  const tabs = createTabs();
  tabs.repos = [repo('first')];
  tabs.syncByRepoPath = new Map();
  tabs._syncRefreshToken = 0;
  await tabs.refreshAllSync();
  assert.equal(tabs.renderCount, 1);
  await tabs.refreshAllSync();
  assert.equal(tabs.renderCount, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');

function loadGitTreeApp() {
  if (!global.window) global.window = {};
  Object.assign(global.window, {
    gitTree: {
      getBranchMetadata: async () => ({}),
      getStatus: async () => ({}),
      getOperationState: async () => ({}),
      setTheme: () => {}
    },
    I18n: { init: async () => {}, translateDOM: () => {} },
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis)
  });
  if (!global.localStorage) {
    global.localStorage = { getItem: () => null, setItem: () => {} };
  }
  if (!global.getComputedStyle) {
    global.getComputedStyle = () => ({ getPropertyValue: () => '' });
  }
  global.document = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}
    }),
    documentElement: { dataset: {} }
  };
  if (!global.t) global.t = key => key;

  let mod;
  try {
    mod = require('../src/renderer/app.mts');
  } catch {
    mod = require('../src/renderer/app');
  }
  return mod.GitTreeApp || mod.default || mod;
}

function createAppHarness(GitTreeApp) {
  const calls = [];
  const app = Object.create(GitTreeApp.prototype);
  app.state = { repo: { path: '/repo', name: 'repo' } };
  app.isCurrentRepo = repoPath => repoPath === '/repo';
  app.components = {
    branchList: {
      switchFromDirection: null,
      metadata: { branches: [] },
      setCurrentBranch: branch => calls.push(['setCurrent', branch]),
      load: async (...args) => {
        calls.push(['branchLoad', ...args]);
      }
    },
    diffViewer: { clear: () => calls.push(['clear']) },
    graphView: { body: {}, load: async () => calls.push(['graph']) },
    changes: { load: async () => calls.push(['changes']) },
    repoTabs: { updateSync: () => calls.push(['sync']) },
    statusBar: { setBranch: () => {} },
    welcome: {}
  };
  app.animateBranchSwitch = () => {};
  app.updateStatus = async () => calls.push(['status']);
  app.updatePushPullCounts = () => {};
  app.pushInspectorPayload = () => {};
  return { app, calls };
}

test('checkout da ricerca remota ricarica la lista locali senza fetch manuale', async () => {
  const GitTreeApp = loadGitTreeApp();
  const { app, calls } = createAppHarness(GitTreeApp);

  await app.afterBranchCheckout({ branch: 'feature/remota' }, '/repo');

  assert.ok(
    calls.some(call => call[0] === 'branchLoad' && call[1] === '/repo' && call[3]?.background === true),
    'la branch list deve ricaricarsi in background dopo il checkout'
  );
  assert.ok(calls.some(call => call[0] === 'setCurrent' && call[1] === 'feature/remota'));
});

test('checkout ignorato per repository non corrente', async () => {
  const GitTreeApp = loadGitTreeApp();
  const { app, calls } = createAppHarness(GitTreeApp);
  app.isCurrentRepo = () => false;

  await app.afterBranchCheckout({ branch: 'feature/remota' }, '/altro-repo');

  assert.equal(calls.some(call => call[0] === 'branchLoad'), false);
});

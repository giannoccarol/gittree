const test = require('node:test');
const assert = require('node:assert/strict');
let RemoteOperationController;
try {
  const mod = require('../src/renderer/remote-operation-controller.mts');
  RemoteOperationController = mod.RemoteOperationController || mod.default || mod;
} catch {
  RemoteOperationController = require('../src/renderer/remote-operation-controller');
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
  contains(value) { return this.values.has(value); }
}

function createButton(iconClass) {
  const icon = { className: iconClass, dataset: {} };
  return {
    classList: new FakeClassList(),
    dataset: {},
    disabled: false,
    attributes: {},
    icon,
    getAnimations: () => [],
    querySelector: () => icon,
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function createHarness(overrides = {}) {
  const buttons = {
    'btn-fetch': createButton('ph ph-cloud-arrow-down'),
    'btn-pull': createButton('ph ph-download-simple'),
    'btn-push': createButton('ph ph-upload-simple')
  };
  const calls = [];
  const repo = { path: 'C:\\repo' };
  const bridge = {
    fetch: async () => ({ success: true }),
    pull: async () => ({ success: true }),
    push: async () => ({ success: true }),
    ...overrides.bridge
  };
  const controller = new RemoteOperationController({
    bridge,
    document: { getElementById: id => buttons[id] },
    translate: key => key,
    notify: (message, type) => calls.push(['notify', message, type]),
    getCurrentRepository: () => overrides.currentRepo || repo,
    getPushContext: overrides.getPushContext,
    isCurrentRepository: path => (overrides.currentRepo || repo).path === path,
    repoTabs: {
      setSyncBusy: (path, busy) => calls.push(['tabBusy', path, busy]),
      refreshAllSync: async () => calls.push(['refreshTabs'])
    },
    createLoadSession: path => ({ path }),
    views: {
      refreshGraph: async (...args) => calls.push(['graph', ...args]),
      refreshBranches: async (...args) => calls.push(['branches', ...args]),
      refreshChanges: async (...args) => calls.push(['changes', ...args]),
      refreshStatus: async (...args) => calls.push(['status', ...args]),
      syncCurrent: path => calls.push(['sync', path])
    }
  });
  return { buttons, calls, controller, repo };
}

test('fetch refreshes remote refs incrementally without reloading unrelated views', async () => {
  const { calls, controller, repo } = createHarness();

  await controller.run('fetch');

  assert.ok(calls.some(call => (
    call[0] === 'graph' &&
    call[1] === repo.path &&
    call[2]?.preserveViewport === true
  )));
  assert.ok(calls.some(call => (
    call[0] === 'branches' &&
    call[1] === repo.path &&
    call[3]?.background === true
  )));
  assert.ok(calls.some(call => call[0] === 'status'));
  assert.equal(calls.some(call => call[0] === 'changes'), false);
  assert.ok(calls.some(call => call[0] === 'sync' && call[1] === repo.path));
});

test('pull also refreshes the working tree while push keeps it untouched', async () => {
  const pull = createHarness();
  await pull.controller.run('pull');
  assert.ok(pull.calls.some(call => call[0] === 'changes'));

  const push = createHarness();
  await push.controller.run('push');
  assert.equal(push.calls.some(call => call[0] === 'changes'), false);
});

test('remote failure skips view refresh and restores every toolbar button', async () => {
  const { buttons, calls, controller } = createHarness({
    bridge: { fetch: async () => ({ error: 'offline' }) }
  });

  const result = await controller.run('fetch');

  assert.deepEqual(result, { error: 'offline' });
  assert.equal(calls.some(call => call[0] === 'graph'), false);
  assert.ok(calls.some(call => call[0] === 'notify' && call[1] === 'offline'));
  assert.equal(Object.values(buttons).every(button => !button.disabled), true);
  assert.equal(buttons['btn-fetch'].attributes['aria-busy'], 'false');
  assert.equal(buttons['btn-fetch'].icon.className, 'ph ph-cloud-arrow-down');
});

test('push uses set-upstream when the current branch has no tracking branch', async () => {
  const pushCalls = [];
  const { controller } = createHarness({
    bridge: {
      push: async (...args) => {
        pushCalls.push(args);
        return { success: true };
      }
    },
    getPushContext: () => ({
      remote: 'origin',
      branch: 'feature/new',
      setUpstream: true
    })
  });

  await controller.run('push');

  assert.deepEqual(pushCalls, [['C:\\repo', 'origin', 'feature/new', true]]);
});

test('push keeps upstream when the current branch is already tracked', async () => {
  const pushCalls = [];
  const { controller } = createHarness({
    bridge: {
      push: async (...args) => {
        pushCalls.push(args);
        return { success: true };
      }
    },
    getPushContext: () => ({
      remote: 'origin',
      branch: 'main',
      setUpstream: false
    })
  });

  await controller.run('push');

  assert.deepEqual(pushCalls, [['C:\\repo', 'origin', 'main', false]]);
});

test('running operation exposes one honest busy state and blocks concurrent actions', async () => {
  let finishFetch;
  const fetchResult = new Promise(resolve => { finishFetch = resolve; });
  const { buttons, controller } = createHarness({
    bridge: { fetch: () => fetchResult }
  });

  const pending = controller.run('fetch');
  assert.equal(buttons['btn-fetch'].attributes['aria-busy'], 'true');
  assert.equal(buttons['btn-fetch'].icon.className, 'ph ph-circle-notch');
  assert.equal(Object.values(buttons).every(button => button.disabled), true);
  assert.equal(await controller.run('push'), null);

  finishFetch({ success: true });
  await pending;
  assert.equal(Object.values(buttons).every(button => !button.disabled), true);
});

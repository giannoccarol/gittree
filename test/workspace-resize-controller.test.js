const test = require('node:test');
const assert = require('node:assert/strict');
let WorkspaceResizeController;
try {
  const mod = require('../src/renderer/workspace-resize-controller.mts');
  WorkspaceResizeController = mod.WorkspaceResizeController || mod.default || mod;
} catch {
  WorkspaceResizeController = require('../src/renderer/workspace-resize-controller');
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
    this.writes = [];
    this.cursor = '';
  }

  setProperty(name, value) {
    this.values.set(name, value);
    this.writes.push({ name, value });
  }

  getPropertyValue(name) { return this.values.get(name) || ''; }
  removeProperty(name) { this.values.delete(name); }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }

  dispatch(name, properties = {}) {
    const event = {
      type: name,
      preventDefault() {},
      pointerId: 1,
      isTrusted: false,
      button: 0,
      ...properties
    };
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(width = 0) {
    super();
    this.width = width;
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
  }

  getBoundingClientRect() { return { width: this.width }; }
  setPointerCapture() {}
}

class FakeStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.setCalls = [];
  }

  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }

  setItem(key, value) {
    this.values.set(key, String(value));
    this.setCalls.push({ key, value: String(value) });
  }
}

function createFrameHarness() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    requestFrame(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id) { callbacks.delete(id); },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    get pending() { return callbacks.size; }
  };
}

function createHarness(stored = {}) {
  const document = new FakeEventTarget();
  document.body = new FakeElement();
  const workspace = new FakeElement();
  const leftHandle = new FakeElement();
  const rightHandle = new FakeElement();
  const leftPanel = new FakeElement(260);
  const rightPanel = new FakeElement(360);
  const storage = new FakeStorage(stored);
  const frames = createFrameHarness();
  const controller = new WorkspaceResizeController({
    workspace,
    document,
    storage,
    requestFrame: callback => frames.requestFrame(callback),
    cancelFrame: id => frames.cancelFrame(id),
    panels: {
      left: {
        handle: leftHandle,
        panel: leftPanel,
        min: 220,
        max: 380,
        cssVariable: '--left-panel',
        storageKey: 'gittree.panel.left',
        direction: 1
      },
      right: {
        handle: rightHandle,
        panel: rightPanel,
        min: 300,
        max: 620,
        cssVariable: '--right-panel',
        storageKey: 'gittree.panel.right',
        direction: -1
      }
    }
  });
  controller.mount();
  return {
    controller,
    document,
    frames,
    leftHandle,
    rightHandle,
    storage,
    workspace
  };
}

test('restores persisted panel widths without writing storage', () => {
  const { storage, workspace } = createHarness({
    'gittree.panel.left': '312',
    'gittree.panel.right': '488'
  });

  assert.equal(workspace.style.getPropertyValue('--left-panel'), '312px');
  assert.equal(workspace.style.getPropertyValue('--right-panel'), '488px');
  assert.deepEqual(storage.setCalls, []);
});

test('coalesces realtime width updates to one per frame and persists once on release', () => {
  const { document, frames, leftHandle, storage, workspace } = createHarness();

  leftHandle.dispatch('pointerdown', { clientX: 100 });
  document.dispatch('pointermove', { clientX: 112 });
  document.dispatch('pointermove', { clientX: 138 });

  assert.equal(frames.pending, 1);
  assert.equal(workspace.style.getPropertyValue('--left-panel'), '');
  assert.deepEqual(storage.setCalls, []);

  frames.flush();

  assert.equal(workspace.style.getPropertyValue('--left-panel'), '298px');
  assert.equal(
    workspace.style.writes.filter(write => write.name === '--left-panel').length,
    1
  );
  assert.deepEqual(storage.setCalls, []);
  assert.equal(workspace.classList.contains('is-resizing'), true);
  assert.equal(leftHandle.classList.contains('is-dragging'), true);
  assert.equal(workspace.style.getPropertyValue('opacity'), '');

  document.dispatch('pointerup', { clientX: 140 });

  assert.equal(workspace.style.getPropertyValue('--left-panel'), '300px');
  assert.deepEqual(storage.setCalls, [
    { key: 'gittree.panel.left', value: '300' }
  ]);
  assert.equal(workspace.classList.contains('is-resizing'), false);
  assert.equal(leftHandle.classList.contains('is-dragging'), false);
  assert.equal(document.body.style.cursor, '');
});

test('uses the inverse direction for the inspector and clamps the live width', () => {
  const { document, frames, rightHandle, storage, workspace } = createHarness();

  rightHandle.dispatch('pointerdown', { clientX: 600 });
  document.dispatch('pointermove', { clientX: 100 });
  frames.flush();

  assert.equal(workspace.style.getPropertyValue('--right-panel'), '620px');
  assert.deepEqual(storage.setCalls, []);

  document.dispatch('pointerup', { clientX: 900 });

  assert.equal(workspace.style.getPropertyValue('--right-panel'), '300px');
  assert.deepEqual(storage.setCalls, [
    { key: 'gittree.panel.right', value: '300' }
  ]);
});

test('destroy cancels pending work and removes active drag state without persistence', () => {
  const { controller, document, frames, leftHandle, storage, workspace } = createHarness();

  leftHandle.dispatch('pointerdown', { clientX: 100 });
  document.dispatch('pointermove', { clientX: 140 });
  controller.destroy();
  frames.flush();

  assert.equal(workspace.style.getPropertyValue('--left-panel'), '');
  assert.deepEqual(storage.setCalls, []);
  assert.equal(workspace.classList.contains('is-resizing'), false);
  assert.equal(leftHandle.classList.contains('is-dragging'), false);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInspectorWindowController
} = require('../src/main/inspector-window-controller.mts');

test('inspector controller creates one locked-down window and reuses it', () => {
  const created = [];
  const rendererEvents = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.listeners = new Map();
      this.sent = [];
      this.webContents = {
        once: (event, listener) => this.listeners.set(event, listener),
        send: (...args) => this.sent.push(args)
      };
      created.push(this);
    }
    isDestroyed() { return false; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; }
    loadFile(filename) { this.loaded = filename; }
    on(event, listener) { this.listeners.set(event, listener); }
  }
  const parent = {};
  const controller = createInspectorWindowController({
    BrowserWindow: FakeWindow,
    getMainWindow: () => parent,
    lockDownWindow: window => { window.locked = true; },
    iconPath: () => 'icon.png',
    preloadPath: 'preload.js',
    htmlPath: 'inspector.html',
    sendToRenderer: (...args) => rendererEvents.push(args)
  });

  assert.deepEqual(controller.update({}), { success: false });
  assert.deepEqual(controller.open({
    title: 'Commit', meta: 'abc1234 · Ada · 1 file', theme: 'dark', tone: 'blue',
    mode: 'split', html: '<b>x</b>', diffText: '+x'
  }), { success: true });
  assert.equal(created.length, 1);
  assert.equal(created[0].options.parent, parent);
  assert.equal(created[0].options.width, 1040);
  assert.equal(created[0].options.minWidth, 620);
  assert.equal(created[0].options.webPreferences.contextIsolation, true);
  assert.equal(created[0].options.webPreferences.sandbox, true);
  assert.equal(created[0].locked, true);
  assert.equal(created[0].loaded, 'inspector.html');

  created[0].listeners.get('did-finish-load')();
  assert.deepEqual(created[0].sent.at(-1), ['inspector:render', {
    title: 'Commit', meta: 'abc1234 · Ada · 1 file', theme: 'dark', tone: 'blue', mode: 'split',
    eyebrow: 'Inspector', modeLabel: 'Split', wordLevel: false,
    graph: { revision: 0, laneCount: 1, hasMore: false, selectedHash: null, rows: [] },
    files: [], selectedFile: null, filesOpen: true,
    html: '<b>x</b>', diffText: '+x'
  }]);
  controller.open({ title: 'Next' });
  assert.equal(created.length, 1);
  assert.equal(created[0].focused, true);

  controller.destroy();
  assert.equal(created[0].destroyed, true);

  created[0].listeners.get('closed')();
  assert.deepEqual(rendererEvents, [['inspector:closed']]);
  assert.deepEqual(controller.update({}), { success: false });
});

test('inspector controller sanitizes oversized and invalid payload fields', () => {
  let window;
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { once() {}, send: (...args) => { this.lastSend = args; } };
      window = this;
    }
    isDestroyed() { return false; }
    loadFile() {}
    on() {}
  }
  const controller = createInspectorWindowController({
    BrowserWindow: FakeWindow,
    getMainWindow: () => null,
    lockDownWindow() {},
    iconPath: () => null,
    preloadPath: '',
    htmlPath: '',
    sendToRenderer() {}
  });
  controller.open({ title: 'x'.repeat(201) });
  assert.equal(window.options.title, 'Inspector');
  assert.deepEqual(controller.update({
    title: 42,
    theme: 'black',
    tone: 'Bad Tone!',
    mode: 'other',
    html: 'x'.repeat(2_000_001),
    diffText: 'x'.repeat(10_000_001)
  }), { success: true });
  assert.deepEqual(window.lastSend, ['inspector:render', {
    title: 'Inspector', meta: '', theme: 'light', tone: '', mode: 'unified',
    eyebrow: 'Inspector', modeLabel: 'Unified', wordLevel: false,
    graph: { revision: 0, laneCount: 1, hasMore: false, selectedHash: null, rows: [] },
    files: [], selectedFile: null, filesOpen: true,
    html: '', diffText: ''
  }]);
});

test('inspector controller bounds structured graph and file navigation data', () => {
  let inspectorWindow;
  class FakeWindow {
    constructor() {
      this.webContents = { once() {}, send: (...args) => { this.lastSend = args; } };
      inspectorWindow = this;
    }
    isDestroyed() { return false; }
    loadFile() {}
    on() {}
  }
  const controller = createInspectorWindowController({
    BrowserWindow: FakeWindow,
    getMainWindow: () => null,
    lockDownWindow() {},
    iconPath: () => null,
    preloadPath: '',
    htmlPath: '',
    sendToRenderer() {}
  });
  controller.open({});
  controller.update({
    graph: {
      revision: 4,
      laneCount: 2,
      hasMore: true,
      selectedHash: 'abc1234',
      rows: [{
        hash: 'abc1234', subject: 'Ship inspector', lane: 1, incoming: true,
        before: ['abc1234', null],
        parents: [{ hash: 'parent123', lane: 0, kind: 'first-parent' }],
        refs: [{ fullName: 'refs/heads/main', shortName: 'main', type: 'branch' }]
      }]
    },
    files: [{ path: 'src/app.js', status: 'M', additions: 3, deletions: 1 }],
    selectedFile: 'src/app.js',
    filesOpen: false
  });

  const payload = inspectorWindow.lastSend[1];
  assert.equal(payload.graph.rows[0].subject, 'Ship inspector');
  assert.deepEqual(payload.graph.rows[0].refs, [{ shortName: 'main', type: 'branch' }]);
  assert.deepEqual(payload.files, [{
    path: 'src/app.js', oldPath: null, status: 'M', additions: 3, deletions: 1
  }]);
  assert.equal(payload.selectedFile, 'src/app.js');
  assert.equal(payload.filesOpen, false);
});

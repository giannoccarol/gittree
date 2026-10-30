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
    kind: 'commit', title: 'Commit', meta: 'abc1234 · Ada · 1 file', theme: 'dark', tone: 'blue',
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
    kind: 'commit', title: 'Commit', meta: 'abc1234 · Ada · 1 file', theme: 'dark', tone: 'blue', mode: 'split',
    eyebrow: 'Inspector', wordLevel: false,
    files: [], selectedFile: null, filesOpen: true,
    diffText: '+x'
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
    kind: 'script',
    title: 42,
    theme: 'black',
    tone: 'Bad Tone!',
    mode: 'other',
    html: 'x'.repeat(2_000_001),
    diffText: 'x'.repeat(10_000_001)
  }), { success: true });
  assert.deepEqual(window.lastSend, ['inspector:render', {
    kind: 'empty', title: 'Inspector', meta: '', theme: 'light', tone: '', mode: 'unified',
    eyebrow: 'Inspector', wordLevel: false,
    files: [], selectedFile: null, filesOpen: true,
    diffText: ''
  }]);
});

test('inspector controller bounds file navigation data and drops markup and graph fields', () => {
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
    kind: 'working-file',
    html: '<img src=x onerror=alert(1)>',
    graph: { rows: [{ hash: 'abc1234' }] },
    files: [
      { path: 'src/app.js', status: 'M', additions: 3, deletions: 1 },
      { path: 'src/other.js', status: 'X', additions: -1, deletions: 2.5 },
      { path: '' }
    ],
    selectedFile: 'src/app.js',
    filesOpen: false
  });

  const payload = inspectorWindow.lastSend[1];
  assert.equal(payload.kind, 'working-file');
  assert.equal('html' in payload, false);
  assert.equal('graph' in payload, false);
  assert.deepEqual(payload.files, [
    { path: 'src/app.js', oldPath: null, status: 'M', additions: 3, deletions: 1 },
    { path: 'src/other.js', oldPath: null, status: 'M', additions: 0, deletions: 0 }
  ]);
  assert.equal(payload.selectedFile, 'src/app.js');
  assert.equal(payload.filesOpen, false);
});

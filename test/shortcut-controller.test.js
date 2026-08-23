const test = require('node:test');
const assert = require('node:assert/strict');
let ShortcutController;
try {
  const mod = require('../src/renderer/shortcut-controller.mts');
  ShortcutController = mod.ShortcutController || mod.default || mod;
} catch {
  ShortcutController = require('../src/renderer/shortcut-controller');
}

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = { ...dataset };
    this.attributes = {};
    this.textContent = '';
    this.title = '';
    this.classList = {
      contains: value => this.classes?.has(value) || false
    };
    this.classes = new Set();
  }

  setAttribute(name, value) { this.attributes[name] = value; }
}

function keyboardEvent(key, options = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    prevented: false,
    target: { closest: () => null },
    preventDefault() { this.prevented = true; },
    ...options
  };
}

function createHarness(platform = 'win32') {
  const calls = [];
  const listeners = new Map();
  const searchHint = new FakeElement({ platformShortcut: 'search' });
  const titleElements = ['fetch', 'pull', 'push', 'newBranch'].map(action => (
    new FakeElement({ shortcutTitle: action })
  ));
  const modal = new FakeElement();
  modal.classes.add('is-hidden');
  const document = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    querySelectorAll(selector) {
      if (selector === '[data-platform-shortcut]') return [searchHint];
      if (selector === '[data-shortcut-title]') return titleElements;
      return [];
    },
    getElementById: id => id === 'modal-overlay' ? modal : null
  };
  let inspectorState = 'maximized';
  const controller = new ShortcutController({
    document,
    platform,
    translate: key => `translated:${key}`,
    callbacks: {
      openRepository: () => calls.push('open'),
      fetch: () => calls.push('fetch'),
      pull: () => calls.push('pull'),
      push: () => calls.push('push'),
      newBranch: () => calls.push('newBranch'),
      getInspectorState: () => inspectorState,
      restoreInspector: () => {
        calls.push('restoreInspector');
        inspectorState = 'open';
      }
    }
  });
  return { controller, calls, listeners, searchHint, titleElements, modal };
}

test('shortcut labels preserve Windows, Linux and macOS conventions', () => {
  const windows = createHarness('win32').controller;
  assert.equal(windows.label('open'), 'Ctrl+O');
  assert.equal(windows.label('fetch'), 'Ctrl+Shift+F');
  assert.equal(windows.label('search'), 'Ctrl+P');
  assert.equal(windows.label('unknown'), '');

  const linux = createHarness('linux').controller;
  assert.equal(linux.label('newBranch'), 'Ctrl+Shift+B');

  const mac = createHarness('darwin').controller;
  assert.equal(mac.label('open'), '⌘O');
  assert.equal(mac.label('push'), '⌘⇧P');
});

test('refreshHints applies localized titles, keyboard labels and accessible names', () => {
  const { controller, searchHint, titleElements } = createHarness();

  controller.refreshHints();

  assert.equal(searchHint.textContent, 'Ctrl+P');
  assert.deepEqual(titleElements.map(element => element.title), [
    'translated:actions.fetch (Ctrl+Shift+F)',
    'translated:actions.pull (Ctrl+Shift+L)',
    'translated:actions.push (Ctrl+Shift+P)',
    'translated:sidebar.newBranch (Ctrl+Shift+B)'
  ]);
  assert.deepEqual(
    titleElements.map(element => element.attributes['aria-label']),
    titleElements.map(element => element.title)
  );
});

test('mounted shortcuts dispatch the existing command combinations', () => {
  const { controller, calls, listeners } = createHarness();
  controller.mount();
  controller.mount();
  const keydown = listeners.get('keydown');

  for (const [key, expected] of [['o', 'open'], ['f', 'fetch'], ['l', 'pull'], ['p', 'push'], ['b', 'newBranch']]) {
    const event = keyboardEvent(key, {
      ctrlKey: true,
      shiftKey: key !== 'o'
    });
    keydown(event);
    assert.equal(event.prevented, true);
    assert.equal(calls.at(-1), expected);
  }

  const escape = keyboardEvent('Escape');
  keydown(escape);
  assert.equal(calls.at(-1), 'restoreInspector');
});

test('shortcuts ignore editable targets, modals, repeats and incomplete modifiers', () => {
  const { controller, calls, listeners, modal } = createHarness();
  controller.mount();
  const keydown = listeners.get('keydown');

  keydown(keyboardEvent('o', { ctrlKey: true, repeat: true }));
  keydown(keyboardEvent('o', {
    ctrlKey: true,
    target: { closest: () => ({ tagName: 'INPUT' }) }
  }));
  keydown(keyboardEvent('f', { ctrlKey: true, shiftKey: false }));
  keydown(keyboardEvent('f', { shiftKey: true }));
  modal.classes.delete('is-hidden');
  keydown(keyboardEvent('p', { ctrlKey: true, shiftKey: true }));
  keydown(keyboardEvent('Escape'));

  assert.deepEqual(calls, []);
});

test('macOS uses Meta and destroy removes the exact key listener', () => {
  const { controller, calls, listeners } = createHarness('darwin');
  controller.mount();
  const keydown = listeners.get('keydown');

  keydown(keyboardEvent('o', { ctrlKey: true }));
  assert.deepEqual(calls, []);
  keydown(keyboardEvent('o', { metaKey: true }));
  assert.deepEqual(calls, ['open']);

  controller.destroy();
  assert.equal(listeners.has('keydown'), false);
  controller.destroy();
});

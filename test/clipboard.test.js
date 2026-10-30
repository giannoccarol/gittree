const test = require('node:test');
const assert = require('node:assert/strict');
const { copyText } = require('../src/renderer/clipboard.mts');

function fakeDocument({ commandResult = true } = {}) {
  const appended = [];
  const focused = [];
  const active = { focus: options => focused.push(options) };
  const doc = {
    activeElement: active,
    body: { appendChild: node => { appended.push(node); node.remove = () => { node.removed = true; }; } },
    createElement: () => ({ setAttribute() {}, select() { this.selected = true; } }),
    execCommand: command => (command === 'copy' ? commandResult : false)
  };
  return { doc, appended, focused };
}

test('copyText uses the Clipboard API when it is allowed', async () => {
  const written = [];
  const saved = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { written.push(text); } } } });
  try {
    const { doc, appended } = fakeDocument();
    assert.equal(await copyText('abc123', doc), true);
    assert.deepEqual(written, ['abc123']);
    assert.equal(appended.length, 0);
  } finally {
    if (saved) Object.defineProperty(global, 'navigator', saved);
    else delete global.navigator;
  }
});

test('copyText falls back to a copy command and restores focus when the API is denied', async () => {
  const saved = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('denied'); } } } });
  try {
    const { doc, appended, focused } = fakeDocument();
    assert.equal(await copyText('abc123', doc), true);
    assert.equal(appended[0].value, 'abc123');
    assert.equal(appended[0].selected, true);
    assert.equal(appended[0].removed, true);
    assert.deepEqual(focused, [{ preventScroll: true }]);

    const failing = fakeDocument({ commandResult: false });
    assert.equal(await copyText('abc123', failing.doc), false);
  } finally {
    if (saved) Object.defineProperty(global, 'navigator', saved);
    else delete global.navigator;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { InspectorPanel } = require('../src/renderer/components/inspector-panel.mts');

function element() {
  return { textContent: '', title: '', dataset: {} };
}

test('presenting content sets the title, the kind and returns the shared body', () => {
  const changes = [];
  const panel = new InspectorPanel({
    panel: element(),
    title: element(),
    body: element(),
    onKindChange: (next, previous) => changes.push([previous, next])
  });

  const body = panel.present('working-file', { title: 'app.js', tooltip: 'src/app.js' });

  assert.equal(body, panel.body);
  assert.equal(panel.title.textContent, 'app.js');
  assert.equal(panel.title.title, 'src/app.js');
  assert.equal(panel.panel.dataset.inspectorKind, 'working-file');
  assert.ok(panel.isShowing('working-file'));
  assert.deepEqual(changes, [['empty', 'working-file']]);

  panel.present('working-file', { title: 'other.js' });
  assert.equal(panel.title.title, 'other.js');
  assert.equal(changes.length, 1, 'the same kind does not report a change');

  panel.present('commit', { title: 'Fix', tooltip: '' });
  assert.equal(panel.title.title, '');
  assert.deepEqual(changes.at(-1), ['working-file', 'commit']);
});

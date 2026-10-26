const test = require('node:test');
const assert = require('node:assert/strict');

function loadChangesView(getWorkingTree) {
  global.window = { gitTree: { getWorkingTree }, addEventListener() {} };
  global.document = { hasFocus: () => false };
  global.t = key => key;
  global.HtmlEncoder = { encode: value => String(value ?? '') };
  const mod = require('../src/renderer/components/changes-view.mts');
  return mod.ChangesView || mod.default || mod;
}

test('a persistent working tree error is reported once while polling', async () => {
  let response = { error: 'Finish or abort the pending merge before changing branches' };
  const ChangesView = loadChangesView(async () => response);
  const toasts = [];
  const view = Object.create(ChangesView.prototype);
  Object.assign(view, {
    app: { showToast: (message, kind) => toasts.push([message, kind]) },
    repoPath: '/repo',
    snapshot: null,
    inflight: null,
    lastPollError: null,
    render() {}
  });

  await view.refresh();
  await view.refresh();
  await view.refresh();
  assert.equal(toasts.length, 1);

  response = { snapshotId: 'clean', files: [] };
  await view.refresh();
  response = { error: 'Finish or abort the pending merge before changing branches' };
  await view.refresh();
  assert.equal(toasts.length, 2);
});

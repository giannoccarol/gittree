const test = require('node:test');
const assert = require('node:assert/strict');
let CommitContextMenu;
let HtmlEncoder;
try {
  const mod = require('../src/renderer/components/commit-context-menu.mts');
  CommitContextMenu = mod.CommitContextMenu || mod.default || mod;
} catch {
  CommitContextMenu = require('../src/renderer/components/commit-context-menu');
}
try {
  const mod = require('../src/renderer/html-encoder.mts');
  HtmlEncoder = mod.HtmlEncoder || mod.default || mod;
} catch {
  HtmlEncoder = require('../src/renderer/html-encoder');
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cherry-pick preview becomes available without waiting for rebase preview', async t => {
  const cherryPick = deferred();
  const rebase = deferred();
  const calls = [];
  global.window = {
    gitTree: {
      previewCommitAction(_repoPath, action) {
        calls.push(action);
        return action === 'cherry-pick' ? cherryPick.promise : rebase.promise;
      }
    }
  };
  global.t = key => key;
  t.after(() => {
    delete global.window;
    delete global.t;
  });

  const menu = Object.create(CommitContextMenu.prototype);
  menu.generation = 1;
  menu.previews = {};
  menu.element = { classList: { contains: () => false } };
  menu.render = () => {};
  menu.place = () => {};

  const loading = menu.loadPreviews(1, '/repo', ['abc1234'], { x: 10, y: 20 });
  assert.deepEqual(calls, ['cherry-pick', 'rebase']);

  cherryPick.resolve({ action: 'cherry-pick', allowed: true, commits: [], files: [] });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(menu.previews['cherry-pick'].allowed, true);
  assert.equal(Object.hasOwn(menu.previews, 'rebase'), false);

  rebase.resolve({ action: 'rebase', allowed: true, commits: [], files: [] });
  await loading;
});

test('preview error envelopes become disabled actions with an explanation', () => {
  global.t = key => key;
  const menu = Object.create(CommitContextMenu.prototype);

  const preview = menu.normalizePreview('cherry-pick', { error: 'Commit disappeared' });

  assert.deepEqual(preview, {
    action: 'cherry-pick',
    allowed: false,
    reason: 'Commit disappeared',
    commits: [],
    files: []
  });
  delete global.t;
});

test('confirmed cherry-pick executes the previewed selection and refreshes its new head', async t => {
  const calls = [];
  global.window = {
    gitTree: {
      async cherryPick(repoPath, hashes) {
        calls.push({ repoPath, hashes });
        return { success: true, head: 'new-head' };
      }
    }
  };
  global.t = key => key;
  t.after(() => {
    delete global.window;
    delete global.t;
  });

  const refreshes = [];
  const menu = Object.create(CommitContextMenu.prototype);
  menu.app = {
    state: { repo: { path: '/repo' } },
    showToast: () => {},
    refresh: options => { refreshes.push(options); }
  };
  menu.hashes = ['abc1234'];
  menu.previews = {
    'cherry-pick': { action: 'cherry-pick', allowed: true, commits: [], files: [] }
  };
  menu.close = () => { menu.hashes = ['changed-after-confirmation']; };
  menu.previewDialog = async () => true;

  await menu.execute('cherry-pick');

  assert.deepEqual(calls, [{ repoPath: '/repo', hashes: ['abc1234'] }]);
  assert.deepEqual(refreshes, [{ selectHash: 'new-head', silent: true }]);
});

function tagDialogHarness() {
  const name = { value: '', disabled: false, focus() {} };
  const message = { value: '', disabled: false };
  const form = { onsubmit: null, elements: { name, message } };
  const error = { textContent: '' };
  const icon = { className: 'ph ph-tag' };
  const create = {
    disabled: false,
    querySelector() { return icon; }
  };
  const cancel = { disabled: false, onclick: null };
  const dialog = {
    className: '',
    innerHTML: '',
    attributes: {},
    setAttribute(attribute, value) { this.attributes[attribute] = value; },
    removeAttribute(attribute) { delete this.attributes[attribute]; },
    querySelector(selector) {
      if (selector === 'form') return form;
      if (selector === '[data-tag-error]') return error;
      if (selector === '[data-create]') return create;
      if (selector === '[data-cancel]') return cancel;
      return null;
    }
  };
  const overlay = {
    classList: { add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {}
  };
  const document = {
    getElementById(id) {
      if (id === 'modal-overlay') return overlay;
      if (id === 'modal-dialog') return dialog;
      return null;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  return { document, dialog, form, name, message, cancel, create };
}

async function openTagDialog(tags) {
  const harness = tagDialogHarness();
  const calls = [];
  global.window = {
    gitTree: {
      getTags(repoPath) {
        calls.push(repoPath);
        return Promise.resolve(tags);
      },
      createTag(repoPath, name, hash, message) {
        calls.push({ repoPath, name, hash, message });
        return Promise.resolve({ success: true, name });
      }
    }
  };
  global.document = harness.document;
  global.t = key => key;
  global.HtmlEncoder = HtmlEncoder;
  const menu = Object.create(CommitContextMenu.prototype);
  menu.app = { showToast() {}, refresh: async () => {} };
  const pending = menu.createTagDialog({ path: '/repo' }, 'abcdef1234567890');
  await new Promise(resolve => setImmediate(resolve));
  return { harness, pending, calls, menu };
}

test('create-tag dialog prefills the next tag and shows the last tag chip', async t => {
  const opened = await openTagDialog({ all: ['v1.2.3', 'v1.2.9', 'nightly'], latest: 'nightly' });
  t.after(() => {
    opened.harness.cancel.onclick();
    delete global.window;
    delete global.document;
    delete global.t;
    delete global.HtmlEncoder;
  });

  assert.deepEqual(opened.calls, ['/repo']);
  assert.match(opened.harness.dialog.innerHTML, /value="v1\.2\.10"/);
  assert.match(opened.harness.dialog.innerHTML, /commitMenu\.lastTag/);
  assert.match(opened.harness.dialog.innerHTML, /tag-create-last-chip/);
  assert.match(opened.harness.dialog.innerHTML, />v1\.2\.9</);
  assert.doesNotMatch(opened.harness.dialog.innerHTML, /readonly|disabled/);
  assert.match(opened.harness.dialog.innerHTML, /aria-describedby="tag-create-last"/);

  opened.harness.name.value = 'custom-release';
  opened.harness.message.value = 'notes';
  await opened.harness.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(opened.calls[1], {
    repoPath: '/repo',
    name: 'custom-release',
    hash: 'abcdef1234567890',
    message: 'notes'
  });
  await opened.pending;
});

test('create-tag dialog stays empty and hides the last-tag chip when there are no tags', async t => {
  const opened = await openTagDialog({ all: [] });
  t.after(() => {
    opened.harness.cancel.onclick();
    delete global.window;
    delete global.document;
    delete global.t;
    delete global.HtmlEncoder;
  });

  assert.match(opened.harness.dialog.innerHTML, /value=""/);
  assert.doesNotMatch(opened.harness.dialog.innerHTML, /tag-create-last/);
  assert.doesNotMatch(opened.harness.dialog.innerHTML, /commitMenu\.lastTag/);
  opened.harness.cancel.onclick();
  assert.equal(await opened.pending, null);
});

test('create-tag dialog shows a non-numeric last tag without inventing a name', async t => {
  const opened = await openTagDialog({ all: ['release'] });
  t.after(() => {
    opened.harness.cancel.onclick();
    delete global.window;
    delete global.document;
    delete global.t;
    delete global.HtmlEncoder;
  });

  assert.match(opened.harness.dialog.innerHTML, /value=""/);
  assert.match(opened.harness.dialog.innerHTML, />release</);
  assert.match(opened.harness.dialog.innerHTML, /commitMenu\.lastTag/);
  opened.harness.cancel.onclick();
  await opened.pending;
});

test('create-tag dialog still opens when tag lookup fails', async t => {
  const menu = Object.create(CommitContextMenu.prototype);
  global.window = {
    gitTree: {
      getTags() { return Promise.reject(new Error('offline')); }
    }
  };
  t.after(() => {
    delete global.window;
  });
  assert.deepEqual(await menu.tagSuggestionFor('/repo'), { latest: null, next: '' });
  assert.deepEqual(await menu.tagSuggestionFor(undefined), { latest: null, next: '' });
});

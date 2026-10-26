const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadMergeWorkspace(gitTree) {
  const filename = path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'merge-workspace.mts'
  );
  global.window = { gitTree };
  global.document = {
    createElement: () => ({ textContent: '', innerHTML: '' }),
    getElementById: () => null
  };
  global.t = key => key;
  const mod = require(filename);
  return mod.MergeWorkspace || mod.default || mod;
}

test('merge preview compares develop against quality without treating the range as a commit', async () => {
  const calls = [];
  const MergeWorkspace = loadMergeWorkspace({
    compareBranches: async (repoPath, target, source) => {
      calls.push({ repoPath, target, source });
      return {
        commits: [{ hash: 'develop-commit', message: 'change' }],
        diff: 'diff --git a/file b/file'
      };
    },
    getLog: async () => ({ latest: { hash: 'quality-commit' } }),
    getStatus: async () => ({ isClean: true }),
    previewMerge: async () => ({
      supported: true,
      canFastForward: false,
      conflictedFiles: ['a.txt'],
      changedFiles: ['a.txt', 'b.txt']
    })
  });
  const errors = [];
  const workspace = new MergeWorkspace({
    state: { repo: { path: 'C:\\repo' } },
    showToast: message => errors.push(message)
  });
  workspace.container = {
    classList: { add() {}, remove() {} },
    innerHTML: ''
  };
  workspace.showLoading = () => {};
  workspace.renderMerge = () => {};

  await workspace.open('develop', 'quality');

  assert.deepEqual(calls, [{
    repoPath: 'C:\\repo',
    target: 'quality',
    source: 'develop'
  }]);
  assert.equal(workspace.mergeData.source, 'develop');
  assert.equal(workspace.mergeData.target, 'quality');
  assert.equal(workspace.mergeData.commitsCount, 1);
  assert.equal(workspace.mergeData.diff, 'diff --git a/file b/file');
  assert.deepEqual(workspace.preview.conflictedFiles, ['a.txt']);
  assert.equal(workspace.preview.changedFiles.length, 2);
  assert.deepEqual(errors, []);
});

function createWorkspaceWithDocument() {
  const MergeWorkspace = loadMergeWorkspace({});
  const ids = {};
  const listeners = [];
  const documentMock = {
    ids,
    listeners,
    createElement: () => ({
      textContent: '',
      innerHTML: '',
      style: { setProperty() {} },
      appendChild() {}
    }),
    createDocumentFragment: () => ({ appendChild() {} }),
    getElementById: id => ids[id] || (ids[id] = { onclick: null, disabled: false }),
    addEventListener: (name, listener) => {
      if (name === 'keydown') listeners.push(listener);
    },
    removeEventListener: (name, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
  global.document = documentMock;
  global.HtmlEncoder = { encode: value => String(value ?? '') };
  const classList = () => {
    const values = new Set();
    return {
      add: value => values.add(value),
      remove: value => values.delete(value),
      contains: value => values.has(value)
    };
  };
  const workspace = new MergeWorkspace({
    state: { repo: { path: 'C:\\repo' } },
    showToast: () => {}
  });
  workspace.container = {
    classList: classList(),
    innerHTML: '',
    querySelectorAll: () => []
  };
  return { documentMock, workspace };
}

test('merge loading overlay shows a close button that hides the workspace', () => {
  const { documentMock, workspace } = createWorkspaceWithDocument();

  workspace.showLoading();

  const cancel = documentMock.ids['merge-cancel-btn'];
  assert.ok(cancel);
  assert.match(workspace.container.innerHTML, /merge-cancel-btn/);
  assert.equal(workspace.container.classList.contains('is-hidden'), false);
  cancel.onclick();
  assert.equal(workspace.container.classList.contains('is-hidden'), true);
});

test('Escape closes the merge overlay and removes its listener', () => {
  const { documentMock, workspace } = createWorkspaceWithDocument();

  workspace.showLoading();
  assert.equal(documentMock.listeners.length, 1);

  documentMock.listeners[0]({ key: 'Escape' });
  assert.equal(workspace.container.classList.contains('is-hidden'), true);
  assert.equal(documentMock.listeners.length, 0);
});

test('Escape cannot interrupt the merge while it is pushing', () => {
  const { documentMock, workspace } = createWorkspaceWithDocument();

  workspace.showLoading();
  documentMock.ids['merge-cancel-btn'].disabled = true;

  documentMock.listeners[0]({ key: 'Escape' });
  assert.equal(workspace.container.classList.contains('is-hidden'), false);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createFakeElement(tag = 'div') {
  return {
    tag,
    className: '',
    textContent: '',
    children: [],
    style: { setProperty() {} },
    appendChild(child) {
      this.children.push(child);
      return child;
    }
  };
}

function installFakeDom() {
  global.document = {
    createElement: tag => createFakeElement(tag),
    createDocumentFragment: () => createFakeElement('#fragment'),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {}
  };
  global.HtmlEncoder = { encode: value => String(value ?? '') };
  global.DiffParser = require('../src/renderer/components/diff-parser.mts');
  global.t = (key, options) => (options ? `${key}:${JSON.stringify(options)}` : key);
}

function mergeComparisonBridge(overrides = {}) {
  return {
    compareBranches: async () => ({ commits: [], diff: '' }),
    getLog: async () => ({ latest: null }),
    getStatus: async () => ({ isClean: true }),
    previewMerge: async () => ({ supported: true, conflictedFiles: [], changedFiles: [] }),
    ...overrides
  };
}

test('merge preview shows the real commit total when the commit list is capped', async () => {
  const MergeWorkspace = loadMergeWorkspace(mergeComparisonBridge({
    compareBranches: async () => ({
      commits: [{ hash: 'a'.repeat(40), message: 'one' }],
      totalCommits: 350,
      diff: ''
    })
  }));
  const workspace = new MergeWorkspace({ state: { repo: { path: '/repo' } }, showToast() {} });
  workspace.showLoading = () => {};
  workspace.renderMerge = () => {};

  await workspace.open('feature', 'main');

  assert.equal(workspace.mergeData.commitsCount, 350);
  assert.equal(workspace.mergeData.commits.length, 1);
  assert.equal(MergeWorkspace.commitCount({ commits: [{}, {}] }), 2);
});

test('closing the merge overlay while it loads discards the late preview', async () => {
  const pending = deferred();
  const MergeWorkspace = loadMergeWorkspace(mergeComparisonBridge({
    compareBranches: () => pending.promise
  }));
  const toasts = [];
  const workspace = new MergeWorkspace({
    state: { repo: { path: '/repo' } },
    showToast: message => toasts.push(message)
  });
  let renders = 0;
  workspace.showLoading = () => {};
  workspace.renderMerge = () => { renders += 1; };

  const opening = workspace.open('feature', 'main');
  workspace.hide();
  pending.resolve({ commits: [], diff: '' });
  await opening;

  assert.equal(renders, 0);
  assert.equal(workspace.mergeData, null);
  assert.deepEqual(toasts, []);
});

test('a second merge click while a merge runs does not start another merge', async () => {
  const pending = deferred();
  let merges = 0;
  const MergeWorkspace = loadMergeWorkspace({
    merge: () => {
      merges += 1;
      return pending.promise;
    }
  });
  const events = [];
  const workspace = new MergeWorkspace({
    state: { repo: { path: '/repo' } },
    showToast() {},
    emit: name => events.push(name),
    components: { branchList: { metadata: null } }
  });
  workspace.mergeData = {
    source: 'feature',
    target: 'main',
    commitsCount: 1,
    commits: [],
    targetCommit: null,
    diff: '',
    diffTruncated: false,
    status: { isClean: true }
  };
  workspace.preview = { changedFiles: [] };
  workspace.setBusy = () => {};
  workspace.hide = () => {};

  const first = workspace.executeMerge(false);
  await workspace.executeMerge(false);
  assert.equal(merges, 1);

  pending.resolve({ success: true });
  await first;
  assert.equal(workspace.busy, false);
  assert.deepEqual(events, ['refresh']);
});

test('merge diff preview renders a bounded number of rows', () => {
  installFakeDom();
  const mod = require('../src/renderer/components/merge-workspace.mts');
  const MergeWorkspace = mod.MergeWorkspace || mod.default || mod;
  const limit = mod.MERGE_PREVIEW_DIFF_LINES;
  assert.ok(Number.isInteger(limit) && limit > 0);
  const body = Array.from({ length: limit * 3 }, (_, index) => `+line ${index}`).join('\n');
  const diff = `diff --git a/big.txt b/big.txt\n@@ -0,0 +1,${limit * 3} @@\n${body}`;
  const workspace = new MergeWorkspace({ state: { repo: null }, showToast() {} });

  const fragment = workspace.renderDiff(diff, false);
  const scroll = fragment.children[0];
  const rows = scroll.children.filter(child => child.className !== 'merge-overflow-note');
  const note = scroll.children.at(-1);

  assert.equal(rows.length, limit);
  assert.equal(note.className, 'merge-overflow-note');
  assert.match(note.textContent, /diffPreviewLimited/);

  const truncated = workspace.renderDiff('diff --git a/x b/x\n+one', true);
  assert.match(truncated.children[0].children.at(-1).textContent, /diffPreviewTruncated/);
});

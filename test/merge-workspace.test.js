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

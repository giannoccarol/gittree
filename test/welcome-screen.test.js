const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadWelcomeScreen(gitTree, documentOverride) {
  const filename = path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'welcome.mts'
  );
  const elements = new Map();
  global.window = { gitTree };
  global.document = documentOverride || {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          classList: { add() {}, remove() {} },
          innerHTML: ''
        });
      }
      return elements.get(id);
    },
    createElement() {
      return { textContent: '', innerHTML: '' };
    }
  };
  global.t = key => key;
  const mod = require(filename);
  return mod.WelcomeScreen || mod.default || mod;
}

function createPickerDocument() {
  class FakeElement {
    constructor() {
      this.innerHTML = '';
      this.onclick = null;
      this.removed = false;
      this.controls = new Map();
      this.classList = { add() {}, remove() {} };
    }

    addEventListener() {}

    remove() {
      this.removed = true;
    }

    focus() {}

    querySelector(selector) {
      if (!this.controls.has(selector)) this.controls.set(selector, new FakeElement());
      return this.controls.get(selector);
    }
  }

  const elements = new Map();
  const body = new FakeElement();
  body.appendChild = element => { body.child = element; };
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement: () => new FakeElement(),
    addEventListener() {},
    removeEventListener() {},
    body
  };
}

test('a fresh install adds the first repository through the registered tabs component', async () => {
  const selectedPath = 'C:\\work\\first-repository';
  const added = [];
  const errors = [];
  const WelcomeScreen = loadWelcomeScreen({
    selectDirectory: async () => selectedPath,
    checkIsGitRepo: async repoPath => repoPath === selectedPath
  });
  const welcome = new WelcomeScreen();
  welcome.app = {
    components: {
      repoTabs: {
        addRepo: async repoPath => added.push(repoPath)
      }
    },
    showToast: message => errors.push(message)
  };

  await welcome.openRepo();

  assert.deepEqual(added, [selectedPath]);
  assert.deepEqual(errors, []);
});

test('the repository picker opened from the tabs can start a clone', async () => {
  const pickerDocument = createPickerDocument();
  const WelcomeScreen = loadWelcomeScreen({}, pickerDocument);
  const welcome = new WelcomeScreen();
  let cloneStarted = false;
  welcome.cloneRepo = async () => { cloneStarted = true; };

  welcome.openRepositoryPicker();
  const overlay = pickerDocument.body.child;

  assert.match(overlay.innerHTML, /data-mode="clone"/);
  await overlay.querySelector('[data-mode="clone"]').onclick();

  assert.equal(cloneStarted, true);
  assert.equal(overlay.removed, true);
  assert.equal(welcome.repositoryPicker, null);
});

test('bulk repository import persists once and selects the first newly added repository', () => {
  const { RepoManager } = require('../src/main/repo-manager.mts');
  const repositories = {
    existing: path.resolve('workspace', 'existing'),
    alpha: path.resolve('workspace', 'alpha'),
    beta: path.resolve('workspace', 'beta')
  };
  const manager = Object.create(RepoManager.prototype);
  manager.repos = [
    { path: repositories.existing, name: 'existing', addedAt: 'before' }
  ];
  manager.activeRepoIndex = 0;
  manager.platform = process.platform;
  manager.now = () => 'now';
  let saves = 0;
  manager.saveRepos = () => { saves += 1; };

  const result = manager.addRepos([
    repositories.existing,
    repositories.alpha,
    repositories.beta
  ]);

  assert.equal(saves, 1);
  assert.deepEqual(result.added.map(item => item.name), ['alpha', 'beta']);
  assert.deepEqual(result.existing.map(item => item.name), ['existing']);
  assert.equal(result.activeRepo.name, 'alpha');
});

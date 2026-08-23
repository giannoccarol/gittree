const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMainApplication,
  isSafeExternalUrl
} = require('../src/main/main-application.mts');

function createHarness(t, { realAiService = false } = {}) {
  const calls = [];
  const handlers = new Map();
  const removedHandlers = [];
  const windows = [];
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-main-application-'));
  t.after(() => fs.rmSync(profileRoot, { recursive: true, force: true }));
  const userDataPath = path.join(profileRoot, 'GitTree');
  let repoManagerOptions;
  let conversionOptions;

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.messages = [];
    }

    send(channel, payload) {
      this.messages.push([channel, payload]);
    }

    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.minimized = false;
      windows.push(this);
      calls.push('window');
    }

    static getAllWindows() {
      return windows.filter(window => !window.destroyed);
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
    }

    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    restore() { this.minimized = false; }
    focus() { calls.push('focus'); }
    setBackgroundColor(color) { this.backgroundColor = color; }
    minimize() {}
    maximize() {}
    unmaximize() {}
    close() { this.destroy(); }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  class FakeRepoManager {
    constructor(options) {
      repoManagerOptions = options;
      calls.push('repo-store');
    }
  }

  class FakeRepositoryWorkspace {
    constructor({ repoStore }) {
      assert.ok(repoStore instanceof FakeRepoManager);
      calls.push('workspace');
      this.repositories = [];
    }

    assertManaged() {}
    getGitService() {
      return {
        getStatus: async () => ({ clean: true }),
        getStagedDiff: async () => '',
        getUnstagedDiff: async () => '',
        getBranchComparison: async () => ({ commits: [], diff: '' }),
        readConflict: async () => ({ path: 'src/a.js', blocks: [] }),
        getCommitDetail: async () => null,
        getLog: async () => ({ all: [] }),
        getBlame: async () => ({ rows: [] })
      };
    }
    list() { return [...this.repositories]; }
    active() { return null; }
    setActive() { return null; }
    remove() { return false; }
    canInspect() { return false; }
    canAdd() { return false; }
    authorizeDirectory(value) { return value; }
    consumeAuthorizedDirectory(value) { return value; }
    beginScan(value) { return value; }
    authorizeScanResults() {}

    addTrustedRepository(repoPath) {
      const repository = { path: repoPath, name: 'repo' };
      this.repositories.push(repository);
      calls.push(`deep-link:${repoPath}`);
      return repository;
    }
  }

  class FakeUpdateService {
    constructor(window) {
      this.window = window;
      calls.push('update');
    }

    setWindow(window) { this.window = window; }
    initialize() { calls.push('update-initialize'); }
    getState() { return { status: 'idle' }; }
    destroy() { calls.push('update-destroy'); }
  }

  class FakeCredentialVault {
    constructor() { calls.push('vault'); }
    async getAccount() { return null; }
    async setAccount() {}
    async removeAccount() {}
  }

  class FakeAiService {
    constructor() { calls.push('ai'); }
    async initialize() { calls.push('ai-initialize'); }
    async getSettings() {
      return {
        provider: 'opencode', baseUrl: '', model: '', language: 'auto',
        keyConfigured: false, opencode: { available: false, version: '' }
      };
    }
    async setSettings(input) { return { ...input, keyConfigured: false }; }
    async setKey() { return { keyConfigured: true }; }
    async clearKey() { return { keyConfigured: false }; }
    async generateCommitMessage() { return { summary: 'feat: test', body: '' }; }
    async generatePrDescription() { return { summary: 'Pull request', body: '' }; }
    async testConnection() { return { ok: true, reply: 'OK' }; }
  }

  class FakeHostingService {
    constructor() { calls.push('hosting'); }
    destroy() { calls.push('hosting-destroy'); }
  }

  class FakeLogger {
    constructor() { calls.push('logger'); }
    setLevel(level) { calls.push(`log-level:${level}`); }
    info(message) { calls.push(`log:${message}`); }
    error(message) { calls.push(`error:${message}`); }
  }

  class FakeDiagnosticsExporter {
    export() { return { canceled: true }; }
  }

  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: async () => { calls.push('ready'); },
    quit: () => calls.push('quit'),
    setName: name => calls.push(`name:${name}`),
    setAppUserModelId: id => calls.push(`app-id:${id}`),
    getPath: () => userDataPath,
    getVersion: () => '1.2.3',
    getAppPath: () => 'C:\\app'
  });
  const processHost = new EventEmitter();
  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle(channel, implementation) {
        assert.equal(handlers.has(channel), false, `duplicate channel ${channel}`);
        handlers.set(channel, implementation);
      },
      removeHandler(channel) {
        removedHandlers.push(channel);
        handlers.delete(channel);
      }
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    },
    Menu: { setApplicationMenu: value => calls.push(`menu:${value}`) },
    nativeTheme: { themeSource: 'system' },
    safeStorage: {},
    session: {
      defaultSession: {
        setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
        setPermissionCheckHandler(handler) { this.permissionCheck = handler; }
      }
    },
    shell: {
      openExternal: value => calls.push(`external:${value}`),
      openPath: async () => ''
    }
  };
  const inspector = {
    open: () => ({ success: true }),
    update: () => ({ success: true }),
    destroy: () => calls.push('inspector-destroy')
  };
  const application = createMainApplication({
    electron,
    argv: ['electron', '.', '--log-level=debug', 'gittree://open?path=fixture'],
    platform: 'win32',
    processHost,
    dependencies: {
      RepoManager: FakeRepoManager,
      RepositoryWorkspace: FakeRepositoryWorkspace,
      UpdateService: FakeUpdateService,
      CredentialVault: FakeCredentialVault,
      ...(realAiService ? {} : { AiService: FakeAiService }),
      HostingService: FakeHostingService,
      Logger: FakeLogger,
      DiagnosticsExporter: FakeDiagnosticsExporter,
      loadOAuthConfig: () => ({}),
      getGitVersion: async () => '2.50.0',
      parseDeepLink: url => url.startsWith('gittree://') ? 'C:\\repo' : null,
      isWorkingTreeRepository: async () => true,
      createInspectorWindowController: () => inspector,
      scanRepositories: async () => ({ repositories: [] }),
      convertWorkspaceProfile: options => {
        conversionOptions = options;
        return { converted: false };
      }
    }
  });
  return {
    application,
    app,
    calls,
    electron,
    handlers,
    processHost,
    removedHandlers,
    profileRoot,
    userDataPath,
    getConversionOptions: () => conversionOptions,
    getRepoManagerOptions: () => repoManagerOptions,
    windows
  };
}

test('Main application composes Electron once and tears down every owned resource', async t => {
  const harness = createHarness(t);

  assert.equal(await harness.application.start(), true);
  assert.equal(harness.windows.length, 1);
  assert.deepEqual(harness.getConversionOptions(), {
    currentConfigPath: path.join(harness.userDataPath, 'repos.json'),
    previousConfigPath: path.join(harness.profileRoot, 'gittree-minimal', 'repos.json')
  });
  assert.deepEqual(harness.getRepoManagerOptions(), {
    configPath: path.join(harness.userDataPath, 'repos.json')
  });
  assert.equal(harness.handlers.size, 148);
  assert.equal(harness.processHost.listenerCount('unhandledRejection'), 1);
  assert.equal(harness.app.listenerCount('activate'), 1);
  assert.equal(
    await harness.handlers.get('app:version')({ sender: 'renderer' }),
    '1.2.3'
  );
  assert.equal(await harness.handlers.get('app:set-theme')({}, 'dark', '#101010'), 'dark');
  assert.equal(harness.electron.nativeTheme.themeSource, 'dark');
  assert.equal(harness.windows[0].backgroundColor, '#101010');
  await harness.handlers.get('app:open-external')({}, 'https://github.com/open/repo');
  await harness.handlers.get('app:open-external')({}, 'https://evil.example/repo');
  assert.equal(
    harness.calls.filter(call => call.startsWith('external:')).length,
    1
  );
  assert.deepEqual(await harness.handlers.get('app:open-explorer')({}, 'C:\\repo'), {
    ok: true
  });
  assert.deepEqual(await harness.handlers.get('app:export-diagnostics')({}), {
    canceled: true
  });
  assert.deepEqual(await harness.handlers.get('update:get-state')({}), {
    status: 'idle'
  });
  assert.equal((await harness.handlers.get('agent:settings')({})).agentsEnabled, true);
  assert.equal((await harness.handlers.get('agent:enabled-set')({}, false)).agentsEnabled, false);
  assert.equal((await harness.handlers.get('agent:concurrency-set')({}, 3)).maxConcurrent, 3);
  assert.deepEqual(
    (await harness.handlers.get('agent:adapters-set')({}, ['codex'])).enabledAdapters,
    ['codex']
  );
  assert.deepEqual(await harness.handlers.get('agent:tasks')({}, 'C:\\repo'), []);
  assert.match((await harness.handlers.get('agent:task-stop')({}, 'missing')).error, /Unknown agent task/);
  assert.equal(await harness.handlers.get('agent:root-select')({}), null);
  assert.equal((await harness.handlers.get('ai:settings-get')({})).provider, 'opencode');
  assert.equal((await harness.handlers.get('ai:key-set')({}, 'sk-test')).keyConfigured, true);
  assert.equal((await harness.handlers.get('ai:key-clear')({})).keyConfigured, false);
  assert.equal(
    (await harness.handlers.get('ai:commit-message')({}, 'C:\\repo', { language: 'en' })).summary,
    'feat: test'
  );
  assert.equal(
    (await harness.handlers.get('ai:pr-description')({}, 'C:\\repo', {
      source: 'feature', target: 'main'
    })).summary,
    'Pull request'
  );
  assert.deepEqual(await harness.handlers.get('ai:test-connection')({}), { ok: true, reply: 'OK' });
  assert.ok(harness.calls.includes('ai-initialize'));
  assert.equal(await harness.handlers.get('dialog:select-directory')({}), null);
  assert.deepEqual(await harness.handlers.get('window:open-inspector')({}, {}), {
    success: true
  });
  assert.deepEqual(await harness.handlers.get('window:update-inspector')({}, {}), {
    success: true
  });
  assert.deepEqual(await harness.handlers.get('repo:list')({}), []);
  assert.deepEqual(await harness.handlers.get('git:status')({}, 'C:\\repo'), {
    clean: true
  });
  let permissionAllowed = true;
  harness.electron.session.defaultSession.permissionRequest(null, null, allowed => {
    permissionAllowed = allowed;
  });
  assert.equal(permissionAllowed, false);
  assert.equal(harness.electron.session.defaultSession.permissionCheck(), false);

  harness.windows[0].webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.calls.includes('update-initialize'));
  assert.ok(harness.calls.includes('deep-link:C:\\repo'));
  assert.deepEqual(
    harness.windows[0].webContents.messages.find(([channel]) => (
      channel === 'deep-link:open-repo'
    )),
    ['deep-link:open-repo', { path: 'C:\\repo', name: 'repo' }]
  );
  harness.app.emit('activate');
  harness.app.emit('second-instance', {}, ['gittree://open?path=second']);
  await new Promise(resolve => setImmediate(resolve));
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    harness.processHost.emit('unhandledRejection', new Error('rejected'));
    harness.processHost.emit('uncaughtException', new Error('uncaught'));
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(harness.calls.includes('error:Unhandled rejection'));
  assert.ok(harness.calls.includes('error:Uncaught exception'));

  await harness.application.stop();
  await harness.application.stop();

  assert.equal(harness.handlers.size, 0);
  assert.equal(new Set(harness.removedHandlers).size, 148);
  assert.equal(harness.windows[0].isDestroyed(), true);
  assert.equal(harness.processHost.listenerCount('unhandledRejection'), 0);
  assert.equal(harness.app.listenerCount('activate'), 0);
  assert.ok(harness.calls.includes('update-destroy'));
  assert.ok(harness.calls.includes('hosting-destroy'));
  assert.ok(harness.calls.includes('inspector-destroy'));
});

test('external navigation accepts only the explicit HTTPS host allowlist', () => {
  assert.equal(isSafeExternalUrl('https://github.com/open/repo'), true);
  assert.equal(isSafeExternalUrl('https://dev.azure.com/org/project'), true);
  assert.equal(isSafeExternalUrl('http://github.com/open/repo'), false);
  assert.equal(isSafeExternalUrl('https://github.com.evil.example/repo'), false);
  assert.equal(isSafeExternalUrl('not a URL'), false);
});

test('Main application composes the real AI service over the credential vault', async t => {
  const harness = createHarness(t, { realAiService: true });

  assert.equal(await harness.application.start(), true);
  const initial = await harness.handlers.get('ai:settings-get')({});
  assert.equal(initial.provider, 'opencode');
  assert.equal(initial.keyConfigured, false);

  await harness.handlers.get('ai:key-set')({}, 'sk-test-key');
  assert.equal((await harness.handlers.get('ai:settings-get')({})).keyConfigured, true);
  await harness.handlers.get('ai:key-clear')({});
  assert.equal((await harness.handlers.get('ai:settings-get')({})).keyConfigured, false);

  assert.equal((await harness.handlers.get('ai:settings-set')({}, {
    provider: 'openai', baseUrl: 'https://api.example.test', model: 'bench', language: 'en'
  })).provider, 'openai');
  assert.match(
    (await harness.handlers.get('ai:commit-message')({}, 'C:\\repo')).error,
    /No changes to generate a commit message from/
  );
  assert.match(
    (await harness.handlers.get('ai:pr-description')({}, 'C:\\repo', {
      source: 'feature', target: 'main'
    })).error,
    /API key in Settings/
  );

  await harness.application.stop();
});

test('AI composition callbacks expose conflict, commit, history and blame reads to the real AI service', async t => {
  const harness = createHarness(t, { realAiService: true });

  assert.equal(await harness.application.start(), true);

  assert.match(
    (await harness.handlers.get('ai:explain-conflict')({}, 'C:\\repo', {
      file: 'src/a.js', blockIndex: 0, language: 'en'
    })).error,
    /Conflict block not found/
  );
  assert.match(
    (await harness.handlers.get('ai:explain-commit')({}, 'C:\\repo', {
      hash: 'a1b2c3d', language: 'en'
    })).error,
    /Commit not found/
  );
  assert.deepEqual(
    await harness.handlers.get('ai:history-search')({}, 'C:\\repo', {
      query: 'find the parser change'
    }),
    { matches: [] }
  );
  assert.match(
    (await harness.handlers.get('ai:explain-lines')({}, 'C:\\repo', {
      file: 'src/a.js', hash: 'a1b2c3d', language: 'en'
    })).error,
    /No blame information for this file/
  );

  await harness.application.stop();
});

test('application start propagates runtime failures and detaches process listeners', async t => {
  const harness = createHarness(t);

  harness.app.whenReady = async () => {
    throw new Error('ready failed');
  };

  await assert.rejects(() => harness.application.start(), /ready failed/);
  assert.equal(harness.processHost.listenerCount('unhandledRejection'), 0);
  assert.equal(harness.processHost.listenerCount('uncaughtException'), 0);
});

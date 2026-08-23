const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerWindowApplicationHandlers
} = require('../src/main/ipc/window-application-handlers.mts');

test('terminal and explorer actions require a managed repository registrar', () => {
  const managedChannels = [];
  registerWindowApplicationHandlers({
    registerHandler() {},
    registerManagedRepoHandler(channel) {
      managedChannels.push(channel);
    },
    getMainWindow() {},
    getWindowState() {},
    getUpdateService() {},
    getAppVersion() {},
    getGitVersion() {},
    openExternal() {},
    showOpenDialog() {},
    setTheme() {},
    sendToRenderer() {},
    createInspectorWindow() {}
  });

  assert.deepEqual(managedChannels.sort(), [
    'app:open-explorer',
    'app:open-terminal'
  ]);
});

test('directory selection authorizes the native dialog result before returning it', async () => {
  const handlers = new Map();
  const calls = [];
  registerWindowApplicationHandlers({
    registerHandler(channel, implementation) {
      handlers.set(channel, implementation);
    },
    registerManagedRepoHandler() {},
    getMainWindow: () => ({ id: 1 }),
    getWindowState: () => ({}),
    getUpdateService() {},
    getAppVersion() {},
    getGitVersion() {},
    openExternal() {},
    setTheme() {},
    exportDiagnostics() {},
    openInspector() {},
    updateInspector() {},
    async showOpenDialog(window, options) {
      calls.push(['dialog', window.id, options.properties]);
      return { canceled: false, filePaths: ['C:\\selected'] };
    },
    authorizeDirectory(directory) {
      calls.push(['authorize', directory]);
      return 'C:\\canonical';
    }
  });

  assert.equal(await handlers.get('dialog:select-directory')(), 'C:\\canonical');
  assert.deepEqual(calls, [
    ['dialog', 1, ['openDirectory']],
    ['authorize', 'C:\\selected']
  ]);
});

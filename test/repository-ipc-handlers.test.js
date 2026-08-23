const test = require('node:test');
const assert = require('node:assert/strict');

const { registerRepositoryHandlers } = require('../src/main/ipc/repository-handlers.mts');

test('adding a repository rejects non-working-tree paths without persisting them', async () => {
  const registrations = new Map();
  let additions = 0;
  registerRepositoryHandlers({
    registerHandler(channel, implementation) {
      registrations.set(channel, implementation);
    },
    repositoryWorkspace: {
      canAdd: () => true,
      addAuthorizedRepository() {
        additions += 1;
      },
      canInspect: () => true,
      list: () => [],
      active: () => null,
      setActive: () => null,
      remove: () => false,
      beginScan: value => value,
      authorizeScanResults() {}
    },
    isWorkingTreeRepository: async () => false,
    createGitService() {},
    scanRepositories() {},
    sendToRenderer() {},
    evictGitService() {}
  });

  assert.deepEqual(await registrations.get('repo:add')('C:\\not-a-repo'), {
    error: 'Not a valid Git repository'
  });
  assert.equal(additions, 0);
});

test('repository admission rejects valid but unauthorized renderer paths', async () => {
  const registrations = new Map();
  let inspected = 0;
  registerRepositoryHandlers({
    registerHandler(channel, implementation) {
      registrations.set(channel, implementation);
    },
    repositoryWorkspace: {
      canAdd: () => false,
      canInspect: () => false,
      list: () => [],
      active: () => null,
      setActive: () => null,
      remove: () => false,
      beginScan() {
        throw new Error('Repository scan root was not authorized');
      },
      authorizeScanResults() {}
    },
    isWorkingTreeRepository: async () => {
      inspected += 1;
      return true;
    },
    createGitService() {},
    scanRepositories() {},
    sendToRenderer() {},
    logger: null
  });

  assert.equal(await registrations.get('git:is-repo')('C:\\arbitrary'), false);
  assert.deepEqual(await registrations.get('repo:add')('C:\\arbitrary'), {
    error: 'Repository path was not authorized'
  });
  assert.equal(inspected, 0);
  assert.throws(
    () => registrations.get('repo:scan-start')('C:\\arbitrary'),
    /not authorized/i
  );
});

test('repository scan authorizes only the results emitted by the approved root', async () => {
  const registrations = new Map();
  const calls = [];
  let finishScan;
  const scanResult = new Promise(resolve => { finishScan = resolve; });
  let completed;
  const completion = new Promise(resolve => { completed = resolve; });
  registerRepositoryHandlers({
    registerHandler(channel, implementation) {
      registrations.set(channel, implementation);
    },
    repositoryWorkspace: {
      beginScan(rootPath) {
        calls.push(['begin', rootPath]);
        return 'C:\\canonical-root';
      },
      authorizeScanResults(rootPath, repositories) {
        calls.push(['authorize', rootPath, repositories]);
      },
      canAdd: () => true,
      canInspect: () => true,
      list: () => [],
      active: () => null,
      setActive: () => null,
      remove: () => false
    },
    scanRepositories(rootPath) {
      calls.push(['scan', rootPath]);
      return scanResult;
    },
    sendToRenderer(channel, payload) {
      if (channel === 'repo:scan-complete') {
        calls.push(['complete', payload.repositories]);
        completed();
      }
    },
    isWorkingTreeRepository: async () => true,
    createGitService() {},
    logger: null
  });

  const started = registrations.get('repo:scan-start')('C:\\selected-root');
  const repositories = [{ path: 'C:\\canonical-root\\repo' }];
  finishScan({ repositories, scannedDirectories: 2, skipped: 0, canceled: false });
  await completion;

  assert.equal(typeof started.scanId, 'string');
  assert.deepEqual(calls, [
    ['begin', 'C:\\selected-root'],
    ['scan', 'C:\\canonical-root'],
    ['authorize', 'C:\\canonical-root', repositories],
    ['complete', repositories]
  ]);
});

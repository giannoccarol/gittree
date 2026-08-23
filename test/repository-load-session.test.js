const test = require('node:test');
const assert = require('node:assert/strict');
let RepositoryLoadSession;
try {
  const mod = require('../src/renderer/repository-load-session.mts');
  RepositoryLoadSession = mod.RepositoryLoadSession || mod.default || mod;
} catch {
  RepositoryLoadSession = require('../src/renderer/repository-load-session');
}

function createBridge() {
  const calls = { metadata: 0, status: 0, operation: 0 };
  return {
    calls,
    bridge: {
      async getBranchMetadata(repoPath) {
        calls.metadata += 1;
        return { repoPath, branches: [] };
      },
      async getStatus(repoPath) {
        calls.status += 1;
        return { repoPath, isClean: true };
      },
      async getOperationState(repoPath) {
        calls.operation += 1;
        return { repoPath, type: null };
      }
    }
  };
}

test('repository load session shares identical reads within one activation', async () => {
  const { bridge, calls } = createBridge();
  const session = new RepositoryLoadSession(bridge, 'C:\\repo');

  const [metadataA, metadataB, statusA, statusB, operationA, operationB] = await Promise.all([
    session.branchMetadata(),
    session.branchMetadata(),
    session.status(),
    session.status(),
    session.operationState(),
    session.operationState()
  ]);

  assert.equal(metadataA, metadataB);
  assert.equal(statusA, statusB);
  assert.equal(operationA, operationB);
  assert.deepEqual(calls, { metadata: 1, status: 1, operation: 1 });
});

test('a new repository activation always performs fresh reads', async () => {
  const { bridge, calls } = createBridge();

  await new RepositoryLoadSession(bridge, 'C:\\repo').status();
  await new RepositoryLoadSession(bridge, 'C:\\repo').status();

  assert.equal(calls.status, 2);
});

test('repository reads start immediately in caller priority order', async () => {
  const { bridge, calls } = createBridge();
  const session = new RepositoryLoadSession(bridge, 'C:\\repo');

  const pending = session.branchMetadata();

  assert.equal(calls.metadata, 1);
  await pending;
});

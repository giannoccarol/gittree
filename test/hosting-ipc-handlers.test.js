const test = require('node:test');
const assert = require('node:assert/strict');

const { registerHostingHandlers } = require('../src/main/ipc/hosting-handlers.mts');

test('PAT setup validates every optional repository path before provider resolution', async () => {
  const registrations = new Map();
  const calls = [];
  registerHostingHandlers({
    registerHandler(channel, implementation) {
      registrations.set(channel, implementation);
    },
    registerManagedRepoHandler() {},
    assertManagedRepo(repoPath) {
      calls.push(['validate', repoPath]);
      throw new Error('Repository is not managed');
    },
    async getHostingRepository() {
      calls.push(['resolve']);
      return { organization: 'example' };
    },
    hostingService: {
      async setPat() {
        calls.push(['set-pat']);
      }
    },
    credentialVault: {}
  });

  await assert.rejects(
    registrations.get('auth:set-pat')('azure', 'secret', 'C:\\unmanaged'),
    /Repository is not managed/
  );
  assert.deepEqual(calls, [['validate', 'C:\\unmanaged']]);
});

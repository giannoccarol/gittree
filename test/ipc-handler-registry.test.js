const test = require('node:test');
const assert = require('node:assert/strict');

const { createHandlerRegistry } = require('../src/main/ipc/handler-registry.mts');

function createHarness(assertManagedRepo = () => {}) {
  const handlers = new Map();
  const registry = createHandlerRegistry({
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertManagedRepo
  });
  return { handlers, registry };
}

test('registerHandler preserves successful results and hides the Electron event', async () => {
  const { handlers, registry } = createHarness();
  registry.registerHandler('example:success', (...args) => ({ args }));

  const result = await handlers.get('example:success')({ sender: 'renderer' }, 'one', 2);

  assert.deepEqual(result, { args: ['one', 2] });
});

test('registerHandler normalizes synchronous and asynchronous errors', async () => {
  const { handlers, registry } = createHarness();
  registry.registerHandler('example:throw', () => {
    throw new Error('synchronous failure');
  });
  registry.registerHandler('example:reject', async () => {
    throw new Error('asynchronous failure');
  });

  assert.deepEqual(
    await handlers.get('example:throw')({}),
    { error: 'synchronous failure' }
  );
  assert.deepEqual(
    await handlers.get('example:reject')({}),
    { error: 'asynchronous failure' }
  );
});

test('registerManagedRepoHandler validates before invoking the implementation', async () => {
  const calls = [];
  const { handlers, registry } = createHarness(repoPath => {
    calls.push(['validate', repoPath]);
    if (repoPath === 'unmanaged') throw new Error('Repository is not managed');
  });
  registry.registerManagedRepoHandler('git:status', repoPath => {
    calls.push(['implementation', repoPath]);
    return { clean: true };
  });

  assert.deepEqual(await handlers.get('git:status')({}, 'managed'), { clean: true });
  assert.deepEqual(
    await handlers.get('git:status')({}, 'unmanaged'),
    { error: 'Repository is not managed' }
  );
  assert.deepEqual(calls, [
    ['validate', 'managed'],
    ['implementation', 'managed'],
    ['validate', 'unmanaged']
  ]);
});

test('handler registry removes exactly the channels it registered', () => {
  const removed = [];
  const registry = createHandlerRegistry({
    handle() {},
    removeHandler: channel => removed.push(channel),
    assertManagedRepo() {}
  });
  registry.registerHandler('app:version', () => '1.0.0');
  registry.registerManagedRepoHandler('git:status', () => ({ clean: true }));

  registry.dispose();
  registry.dispose();

  assert.deepEqual(removed.sort(), ['app:version', 'git:status']);
});
